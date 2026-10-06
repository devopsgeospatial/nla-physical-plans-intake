/**
 * Isomorphic upload parser: runs in the browser (preview) and on the server (authoritative
 * validation). Accepts GeoJSON (.geojson/.json) or a zipped Shapefile (.zip) and returns one
 * validated WGS84 Polygon/MultiPolygon per input feature, together with that feature's attributes.
 */
import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";
import area from "@turf/area";
import kinks from "@turf/kinks";
import { webMercatorToLonLat } from "./web-mercator";

export type UploadFormat = "geojson" | "shapefile";

export interface UploadFeature {
  /** WGS84 (EPSG:4326) geometry, RFC 7946 axis order [lon, lat]. */
  geometry: Polygon | MultiPolygon;
  /** Attributes as read from the file (GeoJSON properties / DBF record). */
  properties: Record<string, unknown>;
  vertexCount: number;
  /** Geodesic area, used for the preview only (the stored area is computed in the layer grid). */
  areaSqMeters: number;
  /**
   * First self-intersection point [lon, lat] when the polygon is not topologically simple. Such
   * polygons are repaired on submit by the ArcGIS geometry service (simplify), not rejected.
   */
  selfIntersection?: [number, number];
}

export interface ParsedUpload {
  features: UploadFeature[];
  format: UploadFormat;
  /** Union of attribute names found in the file, in first-seen order. */
  fieldNames: string[];
  vertexCount: number;
  bbox: [minLon: number, minLat: number, maxLon: number, maxLat: number];
  warnings: string[];
  /** Number of features that need geometry repair (see UploadFeature.selfIntersection). */
  repairCount: number;
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export const MAX_FEATURES = 10_000;
export const MAX_VERTICES = 1_000_000;

type Ring = [number, number][];
type PolygonRings = Ring[];
type CoordinateTransform = (position: [number, number]) => [number, number];

interface RawFeature {
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  label: string;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function detectFormat(fileName: string, data: ArrayBuffer): UploadFormat {
  const head = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  const isZip = ZIP_MAGIC.every((byte, i) => head[i] === byte);
  const lower = fileName.toLowerCase();

  if (isZip) {
    if (!lower.endsWith(".zip")) {
      throw new UploadValidationError(`"${fileName}" is a ZIP archive; rename it to .zip if it contains a Shapefile.`);
    }
    return "shapefile";
  }
  if (lower.endsWith(".zip")) throw new UploadValidationError(`"${fileName}" has a .zip extension but is not a valid ZIP archive.`);
  if (lower.endsWith(".geojson") || lower.endsWith(".json")) return "geojson";
  throw new UploadValidationError("The file must be a zipped Shapefile (.zip) or GeoJSON (.geojson / .json).");
}

export async function parseUploadFile(fileName: string, data: ArrayBuffer): Promise<ParsedUpload> {
  if (data.byteLength === 0) throw new UploadValidationError("The file is empty.");

  const format = detectFormat(fileName, data);
  const warnings: string[] = [];
  const { raw, transform } = format === "geojson" ? readGeoJson(data, warnings) : await readShapefile(data, warnings);

  const features: UploadFeature[] = [];
  const fieldNames = new Set<string>();
  for (const item of raw) {
    if (item.geometry == null) {
      warnings.push(`${item.label} has no geometry and was skipped.`);
      continue;
    }
    const polygons = collectPolygons(item.geometry, transform, item.label, warnings);
    const geometry: Polygon | MultiPolygon =
      polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };

    // Real cadastral data often contains a few self-touching or crossing rings. They are flagged here
    // and repaired with ArcGIS Simplify on submit, instead of blocking the whole upload.
    const kink = kinks(geometry).features[0]?.geometry.coordinates as [number, number] | undefined;
    const areaSqMeters = area(geometry);
    if (!(areaSqMeters > 0) && !kink) throw new UploadValidationError(`${item.label} has zero area.`);

    Object.keys(item.properties).forEach((k) => fieldNames.add(k));
    features.push({
      geometry,
      properties: item.properties,
      vertexCount: polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0),
      areaSqMeters,
      ...(kink ? { selfIntersection: kink } : {}),
    });
  }

  if (features.length === 0) throw new UploadValidationError("No polygon features found in the file.");
  if (features.length > MAX_FEATURES) {
    throw new UploadValidationError(`The file has ${features.length.toLocaleString()} polygons; the maximum per upload is ${MAX_FEATURES.toLocaleString()}.`);
  }
  const vertexCount = features.reduce((n, f) => n + f.vertexCount, 0);
  if (vertexCount > MAX_VERTICES) {
    throw new UploadValidationError(`The file has ${vertexCount.toLocaleString()} vertices; the maximum is ${MAX_VERTICES.toLocaleString()}. Simplify or split it.`);
  }

  const repairCount = features.filter((f) => f.selfIntersection).length;
  return { features, format, fieldNames: [...fieldNames], vertexCount, bbox: computeBbox(features), warnings, repairCount };
}

// ---------------------------------------------------------------------------------------------------
// Format readers
// ---------------------------------------------------------------------------------------------------

function readGeoJson(data: ArrayBuffer, warnings: string[]): { raw: RawFeature[]; transform: CoordinateTransform | null } {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (err) {
    throw new UploadValidationError(`The file is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  if (!isObject(json) || typeof json.type !== "string") {
    throw new UploadValidationError('The file is not a GeoJSON object (missing "type").');
  }

  const transform = resolveLegacyCrs(json.crs, warnings);
  const toRaw = (feature: unknown, label: string): RawFeature => {
    if (!isObject(feature) || feature.type !== "Feature") throw new UploadValidationError(`${label} is not a GeoJSON Feature.`);
    return {
      geometry: (feature.geometry ?? null) as Geometry | null,
      properties: isObject(feature.properties) ? feature.properties : {},
      label,
    };
  };

  switch (json.type) {
    case "FeatureCollection":
      if (!Array.isArray(json.features)) throw new UploadValidationError('FeatureCollection has no "features" array.');
      return { raw: json.features.map((f: unknown, i: number) => toRaw(f, `Feature ${i + 1}`)), transform };
    case "Feature":
      return { raw: [toRaw(json, "Feature 1")], transform };
    default:
      return { raw: [{ geometry: json as unknown as Geometry, properties: {}, label: "Feature 1" }], transform };
  }
}

async function readShapefile(data: ArrayBuffer, warnings: string[]): Promise<{ raw: RawFeature[]; transform: null }> {
  const { default: shp } = await import("shpjs");
  let result: Awaited<ReturnType<typeof shp>>;
  try {
    result = await shp(data);
  } catch (err) {
    throw new UploadValidationError(`Could not read the zipped Shapefile: ${(err as Error).message}`);
  }

  const collections = Array.isArray(result) ? result : [result];
  if (collections.length === 0) throw new UploadValidationError("The ZIP archive does not contain a .shp file.");
  if (collections.length > 1) {
    const names = collections.map((c) => c.fileName ?? "?").join(", ");
    throw new UploadValidationError(`The ZIP contains ${collections.length} shapefiles (${names}); upload exactly one.`);
  }
  warnings.push("Coordinates were read using the Shapefile's .prj (assumed WGS84 if the .prj is missing).");
  return {
    raw: collections[0]!.features.map((f, i) => ({
      geometry: f.geometry,
      properties: (f.properties ?? {}) as Record<string, unknown>,
      label: `Feature ${i + 1}`,
    })),
    transform: null,
  };
}

/** Supports the pre-RFC 7946 "crs" member for the two CRSs that convert without a projection engine. */
function resolveLegacyCrs(crs: unknown, warnings: string[]): CoordinateTransform | null {
  if (crs == null) return null;
  const name = isObject(crs) && isObject(crs.properties) ? crs.properties.name : undefined;
  if (typeof name !== "string") {
    throw new UploadValidationError('Unsupported GeoJSON "crs" member; remove it and supply WGS84 coordinates.');
  }
  const code = name.match(/(?:EPSG|CRS)[:]{1,2}(?:[\d.]*:)?(\d+)$/i)?.[1] ?? "";
  if (["4326", "84"].includes(code)) return null;
  if (["3857", "900913", "102100", "3785"].includes(code)) {
    warnings.push(`GeoJSON declared ${name}; coordinates were converted from Web Mercator to WGS84.`);
    return webMercatorToLonLat;
  }
  throw new UploadValidationError(
    `GeoJSON declares CRS "${name}". Use WGS84 (EPSG:4326), or upload a zipped Shapefile with its .prj (any coordinate system).`,
  );
}

// ---------------------------------------------------------------------------------------------------
// Geometry normalisation
// ---------------------------------------------------------------------------------------------------

function collectPolygons(
  geometry: Geometry,
  transform: CoordinateTransform | null,
  label: string,
  warnings: string[],
): PolygonRings[] {
  if (!isObject(geometry) || typeof geometry.type !== "string") throw new UploadValidationError(`${label} has an invalid geometry.`);
  switch (geometry.type) {
    case "Polygon":
      return [normalizePolygon(geometry.coordinates, transform, label, warnings)];
    case "MultiPolygon":
      return geometry.coordinates.map((poly, i) => normalizePolygon(poly, transform, `${label} part ${i + 1}`, warnings));
    case "GeometryCollection":
      return geometry.geometries.flatMap((g) => collectPolygons(g, transform, label, warnings));
    default:
      throw new UploadValidationError(`${label} is a ${geometry.type}; only polygon features can be appended.`);
  }
}

function normalizePolygon(rings: Position[][], transform: CoordinateTransform | null, label: string, warnings: string[]): PolygonRings {
  if (!Array.isArray(rings) || rings.length === 0) throw new UploadValidationError(`${label}: polygon has no rings.`);
  return rings.map((ring, i) => normalizeRing(ring, transform, rings.length > 1 ? `${label} ring ${i + 1}` : label, warnings));
}

function normalizeRing(ring: Position[], transform: CoordinateTransform | null, label: string, warnings: string[]): Ring {
  if (!Array.isArray(ring)) throw new UploadValidationError(`${label}: ring is not an array of positions.`);

  const out: Ring = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) {
      throw new UploadValidationError(`${label}: invalid position ${JSON.stringify(position)}.`);
    }
    const [rawX, rawY] = position as [unknown, unknown];
    if (typeof rawX !== "number" || typeof rawY !== "number" || !Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      throw new UploadValidationError(`${label}: non-numeric coordinate ${JSON.stringify(position)}.`);
    }
    // Z/M values are dropped; the target layer is 2D.
    const [lon, lat] = transform ? transform([rawX, rawY]) : [rawX, rawY];
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new UploadValidationError(
        `${label}: coordinate (${rawX}, ${rawY}) is not longitude/latitude. The file uses a projected coordinate system: upload it as a zipped Shapefile including its .prj, or export the GeoJSON as WGS84.`,
      );
    }
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    out.push([lon, lat]);
  }

  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push([first[0], first[1]]);
    warnings.push(`${label} was not closed; it was closed automatically.`);
  }
  if (out.length < 4) throw new UploadValidationError(`${label}: a ring needs at least 3 distinct vertices.`);
  return out;
}

function computeBbox(features: UploadFeature[]): ParsedUpload["bbox"] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { geometry } of features) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const poly of polygons) {
      for (const [x, y] of poly[0] ?? []) {
        if (x! < minX) minX = x!;
        if (y! < minY) minY = y!;
        if (x! > maxX) maxX = x!;
        if (y! > maxY) maxY = y!;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
