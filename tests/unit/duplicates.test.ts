import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geoJsonToEsriPolygon } from "../../lib/geo/esri-geometry";
import { findDuplicates, fingerprintEsriRings, fingerprintGeoJson, normalizeUpi, type ExistingParcel } from "../../lib/plans/duplicates";

/** ~60 m x 45 m parcel in Muhanga, offset by dx/dy metres. */
function parcel(dxM = 0, dyM = 0): number[][] {
  const lon0 = 29.7672 + dxM / 111_255;
  const lat0 = -2.0893 + dyM / 110_574;
  const w = 60 / 111_255;
  const h = 45 / 110_574;
  return [[lon0, lat0], [lon0 + w, lat0], [lon0 + w, lat0 + h], [lon0, lat0 + h], [lon0, lat0]];
}
const poly = (ring: number[][]) => ({ type: "Polygon" as const, coordinates: [ring] });
const existing = (ring: number[][], upi: string | null, objectId: number): ExistingParcel => ({
  objectId,
  ...fingerprintEsriRings(geoJsonToEsriPolygon(poly(ring)).rings, upi),
});

describe("fingerprints", () => {
  it("give the same centroid and area for GeoJSON and Esri ring orientation, with holes", () => {
    // ~5.5 m x 5.5 m courtyard inside the parcel.
    const [hx, hy] = parcel(20, 15)[0]!;
    const d = 0.00005;
    const hole = [[hx!, hy!], [hx!, hy! + d], [hx! + d, hy! + d], [hx! + d, hy!], [hx!, hy!]];
    const geojson = { type: "Polygon" as const, coordinates: [parcel(), hole] };
    const a = fingerprintGeoJson(geojson, null);
    const b = fingerprintEsriRings(geoJsonToEsriPolygon(geojson).rings, null);
    assert.ok(Math.abs(a.areaSqMeters - b.areaSqMeters) < 1e-6, `${a.areaSqMeters} vs ${b.areaSqMeters}`);
    assert.ok(Math.abs(a.cx - b.cx) < 1e-12 && Math.abs(a.cy - b.cy) < 1e-12);
    assert.ok(a.areaSqMeters > 2600 && a.areaSqMeters < 2700, `area minus hole: ${a.areaSqMeters}`);
  });

  it("normalise UPIs", () => {
    assert.equal(normalizeUpi(" 2/01/05/01/2201 "), "2/01/05/01/2201");
    assert.equal(normalizeUpi("ab-1"), "AB-1");
    assert.equal(normalizeUpi("  "), null);
    assert.equal(normalizeUpi(undefined), null);
  });
});

describe("findDuplicates", () => {
  const inLayer = [existing(parcel(), "2/01/05/01/2201", 10), existing(parcel(500, 0), null, 11)];

  it("matches existing parcels by UPI (case/space-insensitive) regardless of geometry", () => {
    const uploads = [fingerprintGeoJson(poly(parcel(2000, 2000)), " 2/01/05/01/2201")];
    assert.deepEqual(findDuplicates(uploads, inLayer), [{ index: 0, reason: "upi", existingObjectId: 10 }]);
  });

  it("matches existing parcels by geometry when the UPI is missing or different", () => {
    const uploads = [fingerprintGeoJson(poly(parcel(500.3, -0.2)), null), fingerprintGeoJson(poly(parcel(0.4, 0.4)), "NEW-UPI")];
    assert.deepEqual(findDuplicates(uploads, inLayer), [
      { index: 0, reason: "geometry", existingObjectId: 11 },
      { index: 1, reason: "geometry", existingObjectId: 10 },
    ]);
  });

  it("does not match neighbouring or resized parcels", () => {
    const shifted = fingerprintGeoJson(poly(parcel(5, 0)), null); // 5 m away
    const neighbour = fingerprintGeoJson(poly(parcel(60, 0)), null); // adjacent parcel
    assert.deepEqual(findDuplicates([shifted, neighbour], inLayer), []);
  });

  it("flags repeats within the same file, keeping the first occurrence", () => {
    const uploads = [
      fingerprintGeoJson(poly(parcel(1000, 0)), "A"),
      fingerprintGeoJson(poly(parcel(3000, 0)), "a"),
      fingerprintGeoJson(poly(parcel(1000.2, 0)), null),
      fingerprintGeoJson(poly(parcel(4000, 0)), "B"),
    ];
    assert.deepEqual(findDuplicates(uploads, []), [
      { index: 1, reason: "upi", sameFileAs: 0 },
      { index: 2, reason: "geometry", sameFileAs: 0 },
    ]);
  });
});
