import assert from "node:assert/strict";
import { describe, it } from "node:test";
import proj4 from "proj4";
import {
  geoJsonToEsriPolygon,
  projectWgs84PolygonLocally,
  projectWgs84PolygonWithWkt,
  type EsriPolygon,
} from "../../lib/geo/esri-geometry";

const TM_RWANDA_WKT =
  'PROJCS["ITRF_2005",GEOGCS["GCS_ITRF_2005",DATUM["D_ITRF_2005",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",5000000.0],PARAMETER["Central_Meridian",30.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

/** Positive shoelace sum => clockwise (y-up). */
function clockwise(ring: [number, number][]): boolean {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += (ring[i + 1]![0] - ring[i]![0]) * (ring[i + 1]![1] + ring[i]![1]);
  return sum > 0;
}

// RFC 7946 orientation: exterior counter-clockwise, hole clockwise (the opposite of Esri).
const outerCcw = [[29.765, -2.09], [29.767, -2.09], [29.767, -2.088], [29.765, -2.088], [29.765, -2.09]];
const holeCw = [[29.7655, -2.0895], [29.7655, -2.0885], [29.7665, -2.0885], [29.7665, -2.0895], [29.7655, -2.0895]];

describe("geoJsonToEsriPolygon", () => {
  it("orients exterior rings clockwise and holes counter-clockwise", () => {
    const esri = geoJsonToEsriPolygon({ type: "Polygon", coordinates: [outerCcw, holeCw] });
    assert.equal(esri.rings.length, 2);
    assert.equal(clockwise(esri.rings[0]!), true);
    assert.equal(clockwise(esri.rings[1]!), false);
    assert.deepEqual(esri.spatialReference, { wkid: 4326 });
  });

  it("keeps already-Esri-oriented rings unchanged and flattens MultiPolygons", () => {
    const outerCw = [...outerCcw].reverse();
    const esri = geoJsonToEsriPolygon({ type: "MultiPolygon", coordinates: [[outerCw], [outerCcw]] });
    assert.equal(esri.rings.length, 2);
    assert.deepEqual(esri.rings[0], outerCw);
    assert.ok(esri.rings.every(clockwise));
  });
});

describe("projection", () => {
  const wgs84: EsriPolygon = geoJsonToEsriPolygon({ type: "Polygon", coordinates: [outerCcw] });

  it("passes WGS84 through and projects to Web Mercator", () => {
    assert.deepEqual(projectWgs84PolygonLocally(wgs84, { wkid: 4326 })?.rings, wgs84.rings);
    const merc = projectWgs84PolygonLocally(wgs84, { wkid: 102100, latestWkid: 3857 })!;
    const [x, y] = merc.rings[0]![0]!;
    const [refX, refY] = proj4("EPSG:4326", "EPSG:3857", [29.765, -2.09]); // independent reference
    assert.ok(Math.abs(x - refX) < 0.01 && Math.abs(y - refY) < 0.01, `${x}, ${y} vs ${refX}, ${refY}`);
    assert.equal(projectWgs84PolygonLocally(wgs84, { wkid: 32735 }), null);
  });

  it("projects into TM Rwanda (ITRF2005) from the layer WKT", () => {
    const tm = projectWgs84PolygonWithWkt(wgs84, { wkt: TM_RWANDA_WKT })!;
    const [x, y] = tm.rings[0]![0]!;
    // Inside the existing NLA Physical_Plans extent for Muhanga (x 473835–476364, y 4768076–4769925).
    assert.ok(Math.abs(x - 473859.7) < 0.5 && Math.abs(y - 4768919.9) < 0.5, `${x}, ${y}`);
    assert.equal(clockwise(tm.rings[0]!), true, "orientation must survive projection");
    assert.equal(tm.spatialReference.wkt, TM_RWANDA_WKT);
  });

  it("returns null for WKT that proj4 cannot parse", () => {
    assert.equal(projectWgs84PolygonWithWkt(wgs84, { wkt: "NOT A WKT" }), null);
  });
});
