/**
 * Duplicate detection (isomorphic). A polygon is a duplicate when it matches a parcel already in the
 * layer, or an earlier polygon in the same file, by:
 *   - parcel UPI (trimmed, case-insensitive), or
 *   - geometry: centroids within 1 m and areas within 1 % (catches parcels without / with mistyped UPI).
 *
 * Fingerprints are computed in WGS84 with a local planar approximation, which is accurate to well
 * under a centimetre at parcel scale.
 */
import type { MultiPolygon, Polygon } from "geojson";
import type { UploadFeature } from "../geo/parse-upload";
import { mapFields, type LayerFieldInfo } from "./attribute-mapping";

export const UPI_FIELD = "parcel_upi";
const CENTROID_TOLERANCE_M = 1;
const AREA_TOLERANCE = 0.01;
const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LON_EQUATOR = 111_320;

export interface Fingerprint {
  /** Normalised UPI, or null when the polygon has none. */
  upi: string | null;
  /** Centroid longitude/latitude. */
  cx: number;
  cy: number;
  areaSqMeters: number;
}

export interface ExistingParcel extends Fingerprint {
  objectId: number;
}

export type DuplicateReason = "upi" | "geometry";

export interface DuplicateMatch {
  /** Index of the duplicate polygon in the upload. */
  index: number;
  reason: DuplicateReason;
  /** Set when the match is a parcel already in the layer. */
  existingObjectId?: number;
  /** Set when the match is an earlier polygon in the same file (its index). */
  sameFileAs?: number;
}

export function normalizeUpi(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  return text === "" ? null : text;
}

/** Fingerprint of a GeoJSON (RFC 7946) polygon in WGS84. */
export function fingerprintGeoJson(geometry: Polygon | MultiPolygon, upi: unknown): Fingerprint {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return fingerprintRings(polygons.flat() as number[][][], normalizeUpi(upi));
}

/** Fingerprint of Esri JSON rings in WGS84 (orientation-independent). */
export function fingerprintEsriRings(rings: number[][][], upi: unknown): Fingerprint {
  return fingerprintRings(rings, normalizeUpi(upi));
}

/**
 * Area/centroid over all rings. Exterior and hole rings are told apart by containment depth parity
 * rather than orientation, so GeoJSON and Esri inputs give the same result.
 */
function fingerprintRings(rings: number[][][], upi: string | null): Fingerprint {
  const ref = rings[0]?.[0] ?? [0, 0];
  const lat0 = ref[1]!;
  const kx = METERS_PER_DEGREE_LON_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  const ky = METERS_PER_DEGREE_LAT;
  const local = rings.map((ring) => ring.map(([lon, lat]) => [(lon! - ref[0]!) * kx, (lat! - lat0) * ky] as [number, number]));

  let area = 0;
  let sx = 0;
  let sy = 0;
  local.forEach((ring, i) => {
    const { a, cx, cy } = ringAreaCentroid(ring);
    const depth = local.reduce((d, other, j) => (j !== i && ring[0] && pointInRing(ring[0], other) ? d + 1 : d), 0);
    const sign = depth % 2 === 0 ? 1 : -1; // even depth = exterior, odd = hole
    area += sign * Math.abs(a);
    sx += sign * Math.abs(a) * cx;
    sy += sign * Math.abs(a) * cy;
  });
  const cxM = area !== 0 ? sx / area : 0;
  const cyM = area !== 0 ? sy / area : 0;
  return { upi, cx: ref[0]! + cxM / kx, cy: lat0 + cyM / ky, areaSqMeters: Math.abs(area) };
}

function ringAreaCentroid(ring: [number, number][]): { a: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a /= 2;
  return a === 0 ? { a: 0, cx: ring[0]?.[0] ?? 0, cy: ring[0]?.[1] ?? 0 } : { a, cx: cx / (6 * a), cy: cy / (6 * a) };
}

function pointInRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function sameGeometry(a: Fingerprint, b: Fingerprint): boolean {
  const kx = METERS_PER_DEGREE_LON_EQUATOR * Math.cos((a.cy * Math.PI) / 180);
  const dx = (a.cx - b.cx) * kx;
  const dy = (a.cy - b.cy) * METERS_PER_DEGREE_LAT;
  if (Math.hypot(dx, dy) > CENTROID_TOLERANCE_M) return false;
  const larger = Math.max(a.areaSqMeters, b.areaSqMeters);
  return Math.abs(a.areaSqMeters - b.areaSqMeters) <= Math.max(1, larger * AREA_TOLERANCE);
}

/** Fingerprints for an upload, taking the UPI from whichever file field maps to the layer's parcel_upi. */
export function uploadFingerprints(features: UploadFeature[], fileFields: string[], layerFields: LayerFieldInfo[]): Fingerprint[] {
  const upiFileField = mapFields(fileFields, layerFields).matched.find((m) => m.layerField.name.toLowerCase() === UPI_FIELD)?.fileField;
  return features.map((f) => fingerprintGeoJson(f.geometry, upiFileField ? f.properties[upiFileField] : null));
}

/** Matches every upload polygon against existing parcels, then against earlier polygons in the file. */
export function findDuplicates(uploads: Fingerprint[], existing: ExistingParcel[]): DuplicateMatch[] {
  const existingByUpi = new Map<string, ExistingParcel>();
  for (const parcel of existing) if (parcel.upi && !existingByUpi.has(parcel.upi)) existingByUpi.set(parcel.upi, parcel);

  // Coarse grid (~110 m cells) so geometry comparison stays fast for thousands of parcels.
  const cell = (fp: Fingerprint) => `${Math.floor(fp.cx * 1000)}:${Math.floor(fp.cy * 1000)}`;
  const neighbours = (fp: Fingerprint) => {
    const gx = Math.floor(fp.cx * 1000);
    const gy = Math.floor(fp.cy * 1000);
    const keys: string[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(`${gx + dx}:${gy + dy}`);
    return keys;
  };
  const existingGrid = new Map<string, ExistingParcel[]>();
  for (const parcel of existing) {
    const key = cell(parcel);
    existingGrid.set(key, [...(existingGrid.get(key) ?? []), parcel]);
  }

  const matches: DuplicateMatch[] = [];
  const keptByUpi = new Map<string, number>();
  const keptGrid = new Map<string, number[]>();

  uploads.forEach((fp, index) => {
    const byUpi = fp.upi ? existingByUpi.get(fp.upi) : undefined;
    if (byUpi) return void matches.push({ index, reason: "upi", existingObjectId: byUpi.objectId });

    const byGeometry = neighbours(fp)
      .flatMap((k) => existingGrid.get(k) ?? [])
      .find((parcel) => sameGeometry(fp, parcel));
    if (byGeometry) return void matches.push({ index, reason: "geometry", existingObjectId: byGeometry.objectId });

    const earlierUpi = fp.upi ? keptByUpi.get(fp.upi) : undefined;
    if (earlierUpi !== undefined) return void matches.push({ index, reason: "upi", sameFileAs: earlierUpi });

    const earlierGeometry = neighbours(fp)
      .flatMap((k) => keptGrid.get(k) ?? [])
      .find((j) => sameGeometry(fp, uploads[j]!));
    if (earlierGeometry !== undefined) return void matches.push({ index, reason: "geometry", sameFileAs: earlierGeometry });

    if (fp.upi) keptByUpi.set(fp.upi, index);
    const key = cell(fp);
    keptGrid.set(key, [...(keptGrid.get(key) ?? []), index]);
  });
  return matches;
}
