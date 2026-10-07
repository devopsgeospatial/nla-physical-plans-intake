/**
 * GeoJSON -> Esri JSON polygon conversion.
 *
 * Esri polygons are a flat list of rings where orientation (not nesting) defines meaning:
 * exterior rings are CLOCKWISE and holes are COUNTER-CLOCKWISE. RFC 7946 GeoJSON uses the
 * opposite convention (and many files ignore it entirely), so every ring is re-oriented explicitly.
 */
import type { MultiPolygon, Polygon, Position } from "geojson";
import proj4, { type Converter } from "proj4";
import { lonLatToWebMercator, WEB_MERCATOR_WKIDS, WGS84_WKIDS } from "./web-mercator";

export interface EsriSpatialReference {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
}

export interface EsriPolygon {
  rings: [number, number][][];
  spatialReference: EsriSpatialReference;
}

export function geoJsonToEsriPolygon(geometry: Polygon | MultiPolygon): EsriPolygon {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const rings: [number, number][][] = [];

  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const xy = ring.map((p: Position) => [p[0]!, p[1]!] as [number, number]);
      const clockwise = isClockwise(xy);
      const wantClockwise = index === 0; // exterior
      rings.push(clockwise === wantClockwise ? xy : xy.slice().reverse());
    });
  }

  return { rings, spatialReference: { wkid: 4326 } };
}

/** Effective numeric WKID of a spatial reference, preferring latestWkid. */
export function wkidOf(sr: EsriSpatialReference | undefined): number | undefined {
  return sr?.latestWkid ?? sr?.wkid;
}

export function isWgs84(sr: EsriSpatialReference | undefined): boolean {
  const wkid = wkidOf(sr);
  return wkid !== undefined && WGS84_WKIDS.has(wkid);
}

export function isWebMercator(sr: EsriSpatialReference | undefined): boolean {
  const wkid = wkidOf(sr);
  return wkid !== undefined && WEB_MERCATOR_WKIDS.has(wkid);
}

/**
 * Projects a WGS84 polygon to the target SR when that can be done exactly without a projection
 * engine (4326 passthrough, 3857 spherical Mercator). Returns null when a geometry service is required.
 */
export function projectWgs84PolygonLocally(polygon: EsriPolygon, target: EsriSpatialReference): EsriPolygon | null {
  if (isWgs84(target)) return { rings: polygon.rings, spatialReference: { wkid: 4326 } };
  if (isWebMercator(target)) {
    return {
      rings: polygon.rings.map((ring) => ring.map(lonLatToWebMercator)),
      spatialReference: { wkid: 102100, latestWkid: 3857 },
    };
  }
  return null;
}

/**
 * Projects a WGS84 polygon to a spatial reference that is defined only by WKT (common for national
 * grids such as TM Rwanda / ITRF2005), using proj4. Returns null if proj4 cannot parse the WKT.
 * No datum transformation is applied: ITRF2005 and WGS84 agree to well under a metre.
 */
export function projectWgs84PolygonWithWkt(polygon: EsriPolygon, target: EsriSpatialReference): EsriPolygon | null {
  if (!target.wkt) return null;
  let converter: Converter;
  try {
    converter = proj4("EPSG:4326", target.wkt);
  } catch {
    return null;
  }
  const rings = polygon.rings.map((ring) =>
    ring.map(([lon, lat]) => {
      const [x, y] = converter.forward([lon, lat]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`proj4 could not project ${lon}, ${lat}.`);
      return [x, y] as [number, number];
    }),
  );
  return { rings, spatialReference: { wkt: target.wkt } };
}

/** Shoelace sum; positive => clockwise in a y-up coordinate system. */
function isClockwise(ring: readonly (readonly [number, number])[]): boolean {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += (x2 - x1) * (y2 + y1);
  }
  return sum > 0;
}

/**
 * Esri JSON rings (WGS84) → GeoJSON. Esri marks exterior rings clockwise and holes counter-clockwise;
 * each hole is attached to the exterior ring before it, which is how ArcGIS writes them.
 */
export function esriRingsToGeoJson(rings: number[][][]): Polygon | MultiPolygon {
  const polygons: Position[][][] = [];
  for (const ring of rings) {
    const xy = ring.map((p) => [p[0]!, p[1]!] as [number, number]);
    if (isClockwise(xy) || polygons.length === 0) polygons.push([[...xy].reverse()]);
    else polygons[polygons.length - 1]!.push([...xy].reverse());
  }
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}
