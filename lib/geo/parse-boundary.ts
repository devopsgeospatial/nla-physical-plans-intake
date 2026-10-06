/**
 * Isomorphic boundary parser: runs in the browser (for the preview) and on the server (authoritative
 * validation). Accepts GeoJSON (.geojson/.json) or a zipped Shapefile (.zip) and returns a single,
 * validated WGS84 Polygon or MultiPolygon.
 */
import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";
import area from "@turf/area";
import kinks from "@turf/kinks";
import { webMercatorToLonLat } from "./web-mercator";

export type BoundarySourceFormat = "geojson" | "shapefile";

export interface ParsedBoundary {
  /** WGS84 (EPSG:4326) geometry, RFC 7946 axis order [lon, lat]. */
  geometry: Polygon | MultiPolygon;
  sourceFormat: BoundarySourceFormat;
  polygonCount: number;
  vertexCount: number;
  areaSqMeters: number;
  bbox: [minLon: number, minLat: number, maxLon: number, maxLat: number];
  warnings: string[];
}

export class BoundaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryValidationError";
  }
}

export const MAX_BOUNDARY_VERTICES = 100_000;

type Ring = [number, number][];
type PolygonRings = Ring[];

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function detectBoundaryFormat(fileName: string, data: ArrayBuffer): BoundarySourceFormat {
  const head = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  const isZip = ZIP_MAGIC.every((byte, i) => head[i] === byte);
  const lower = fileName.toLowerCase();

  if (isZip) {
    if (!lower.endsWith(".zip")) {
      throw new BoundaryValidationError(`"${fileName}" is a ZIP archive; rename it to .zip if it contains a Shapefile.`);
    }
    return "shapefile";
  }
  if (lower.endsWith(".zip")) {
    throw new BoundaryValidationError(`"${fileName}" has a .zip extension but is not a valid ZIP archive.`);
  }
  if (lower.endsWith(".geojson") || lower.endsWith(".json")) return "geojson";
  throw new BoundaryValidationError("Boundary file must be .geojson, .json, or a zipped Shapefile (.zip).");
}

export async function parseBoundaryFile(fileName: string, data: ArrayBuffer): Promise<ParsedBoundary> {
  if (data.byteLength === 0) throw new BoundaryValidationError("Boundary file is empty.");

  const format = detectBoundaryFormat(fileName, data);
  const warnings: string[] = [];
  const geometries = format === "geojson" ? parseGeoJson(data, warnings) : await parseShapefile(data, warnings);

  const polygons = collectPolygons(geometries, warnings);
  if (polygons.length === 0) {
    throw new BoundaryValidationError("No polygon geometry found in the boundary file.");
  }

  const geometry: Polygon | MultiPolygon =
    polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0]! }
      : { type: "MultiPolygon", coordinates: polygons };

  const vertexCount = polygons.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
  if (vertexCount > MAX_BOUNDARY_VERTICES) {
    throw new BoundaryValidationError(
      `Boundary has ${vertexCount.toLocaleString()} vertices; the maximum is ${MAX_BOUNDARY_VERTICES.toLocaleString()}. Simplify the geometry.`,
    );
  }

  const intersections = kinks(geometry).features;
  if (intersections.length > 0) {
    const [lon, lat] = intersections[0]!.geometry.coordinates;
    throw new BoundaryValidationError(
      `Boundary is self-intersecting (${intersections.length} intersection point(s), first near ${lon?.toFixed(6)}, ${lat?.toFixed(6)}). Fix the topology and re-upload.`,
    );
  }

  const areaSqMeters = area(geometry);
  if (!(areaSqMeters > 0)) throw new BoundaryValidationError("Boundary polygon has zero area.");

  return {
    geometry,
    sourceFormat: format,
    polygonCount: polygons.length,
    vertexCount,
    areaSqMeters,
    bbox: computeBbox(polygons),
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------------
// Format readers
// ---------------------------------------------------------------------------------------------------

type CoordinateTransform = (position: [number, number]) => [number, number];

interface GeometryBatch {
  geometries: Geometry[];
  transform: CoordinateTransform | null;
}

function parseGeoJson(data: ArrayBuffer, warnings: string[]): GeometryBatch {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (err) {
    throw new BoundaryValidationError(`Boundary file is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  if (!isObject(json) || typeof json.type !== "string") {
    throw new BoundaryValidationError("Boundary file is not a GeoJSON object (missing \"type\").");
  }

  const transform = resolveLegacyCrs(json.crs, warnings);
  const geometries: Geometry[] = [];

  switch (json.type) {
    case "FeatureCollection": {
      if (!Array.isArray(json.features)) throw new BoundaryValidationError("FeatureCollection has no \"features\" array.");
      json.features.forEach((feature: unknown, index: number) => {
        if (!isObject(feature) || feature.type !== "Feature") {
          throw new BoundaryValidationError(`features[${index}] is not a GeoJSON Feature.`);
        }
        if (feature.geometry == null) {
          warnings.push(`features[${index}] has a null geometry and was skipped.`);
          return;
        }
        geometries.push(feature.geometry as Geometry);
      });
      break;
    }
    case "Feature":
      if (json.geometry == null) throw new BoundaryValidationError("Feature has a null geometry.");
      geometries.push(json.geometry as Geometry);
      break;
    default:
      geometries.push(json as unknown as Geometry);
  }

  return { geometries, transform };
}

async function parseShapefile(data: ArrayBuffer, warnings: string[]): Promise<GeometryBatch> {
  const { default: shp } = await import("shpjs");
  let result: Awaited<ReturnType<typeof shp>>;
  try {
    result = await shp(data);
  } catch (err) {
    throw new BoundaryValidationError(`Could not read zipped Shapefile: ${(err as Error).message}`);
  }

  const collections = Array.isArray(result) ? result : [result];
  if (collections.length === 0) throw new BoundaryValidationError("ZIP archive does not contain a .shp file.");
  if (collections.length > 1) {
    const names = collections.map((c) => c.fileName ?? "?").join(", ");
    throw new BoundaryValidationError(`ZIP contains ${collections.length} shapefiles (${names}); upload exactly one.`);
  }

  warnings.push(
    "Shapefile coordinates are reprojected to WGS84 using the .prj file; if the .prj is missing they are assumed to already be WGS84.",
  );
  const geometries = collections[0]!.features.flatMap((f) => (f.geometry ? [f.geometry] : []));
  return { geometries, transform: null };
}

/** Supports the pre-RFC 7946 "crs" member for the two CRSs we can convert without a projection engine. */
function resolveLegacyCrs(crs: unknown, warnings: string[]): CoordinateTransform | null {
  if (crs == null) return null;
  const name = isObject(crs) && isObject(crs.properties) ? crs.properties.name : undefined;
  if (typeof name !== "string") {
    throw new BoundaryValidationError("Unsupported GeoJSON \"crs\" member; remove it and supply WGS84 coordinates.");
  }
  const code = name.match(/(?:EPSG|CRS)[:]{1,2}(?:[\d.]*:)?(\d+)$/i)?.[1] ?? "";
  if (["4326", "84"].includes(code)) return null;
  if (["3857", "900913", "102100", "3785"].includes(code)) {
    warnings.push(`GeoJSON declared ${name}; coordinates were converted from Web Mercator to WGS84.`);
    return webMercatorToLonLat;
  }
  throw new BoundaryValidationError(
    `GeoJSON declares CRS "${name}". Only WGS84 (EPSG:4326) or Web Mercator (EPSG:3857) are supported; export as WGS84 or use a zipped Shapefile with a .prj.`,
  );
}

// ---------------------------------------------------------------------------------------------------
// Geometry normalisation
// ---------------------------------------------------------------------------------------------------

function collectPolygons({ geometries, transform }: GeometryBatch, warnings: string[]): PolygonRings[] {
  const polygons: PolygonRings[] = [];

  const visit = (geometry: Geometry, path: string) => {
    switch (geometry.type) {
      case "Polygon":
        polygons.push(normalizePolygon(geometry.coordinates, transform, path, warnings));
        break;
      case "MultiPolygon":
        geometry.coordinates.forEach((poly, i) =>
          polygons.push(normalizePolygon(poly, transform, `${path}[${i}]`, warnings)),
        );
        break;
      case "GeometryCollection":
        geometry.geometries.forEach((g, i) => visit(g, `${path}.geometries[${i}]`));
        break;
      default:
        throw new BoundaryValidationError(
          `Found a ${String((geometry as { type?: unknown }).type)} at ${path}; only Polygon/MultiPolygon boundaries are accepted.`,
        );
    }
  };

  geometries.forEach((g, i) => {
    if (!isObject(g) || typeof g.type !== "string") {
      throw new BoundaryValidationError(`geometry #${i} is not a GeoJSON geometry.`);
    }
    visit(g, `geometry #${i}`);
  });
  return polygons;
}

function normalizePolygon(
  rings: Position[][],
  transform: CoordinateTransform | null,
  path: string,
  warnings: string[],
): PolygonRings {
  if (!Array.isArray(rings) || rings.length === 0) {
    throw new BoundaryValidationError(`${path}: polygon has no rings.`);
  }
  return rings.map((ring, ringIndex) => normalizeRing(ring, transform, `${path} ring ${ringIndex}`, warnings));
}

function normalizeRing(
  ring: Position[],
  transform: CoordinateTransform | null,
  path: string,
  warnings: string[],
): Ring {
  if (!Array.isArray(ring)) throw new BoundaryValidationError(`${path}: ring is not an array of positions.`);

  const out: Ring = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) {
      throw new BoundaryValidationError(`${path}: invalid position ${JSON.stringify(position)}.`);
    }
    const [rawX, rawY] = position as [unknown, unknown];
    if (typeof rawX !== "number" || typeof rawY !== "number" || !Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      throw new BoundaryValidationError(`${path}: non-numeric coordinate ${JSON.stringify(position)}.`);
    }
    // Z/M values are intentionally dropped; the target layer is 2D.
    const [lon, lat] = transform ? transform([rawX, rawY]) : [rawX, rawY];
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new BoundaryValidationError(
        `${path}: coordinate (${rawX}, ${rawY}) is outside WGS84 longitude/latitude range. The file appears to use a projected coordinate system; export it as WGS84 (EPSG:4326) or upload a zipped Shapefile including its .prj.`,
      );
    }
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue; // drop consecutive duplicates
    out.push([lon, lat]);
  }

  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push([first[0], first[1]]);
    warnings.push(`${path} was not closed; it was closed automatically.`);
  }
  if (out.length < 4) {
    throw new BoundaryValidationError(`${path}: a ring needs at least 3 distinct vertices.`);
  }
  return out;
}

function computeBbox(polygons: PolygonRings[]): ParsedBoundary["bbox"] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly[0] ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
