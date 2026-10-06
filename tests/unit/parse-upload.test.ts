import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import shpwrite from "@mapbox/shp-write";
import { parseUploadFile, UploadValidationError } from "../../lib/geo/parse-upload";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
const file = async (path: string) => {
  const b = await readFile(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const TM_RWANDA_WKT =
  'PROJCS["ITRF_2005",GEOGCS["GCS_ITRF_2005",DATUM["D_ITRF_2005",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",5000000.0],PARAMETER["Central_Meridian",30.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

const square = [[29.765, -2.09], [29.767, -2.09], [29.767, -2.088], [29.765, -2.088], [29.765, -2.09]];
const shifted = square.map(([x, y]) => [x! + 0.01, y!]);
const feature = (coordinates: number[][][], properties: Record<string, unknown> = {}) => ({
  type: "Feature",
  properties,
  geometry: { type: "Polygon", coordinates },
});

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof UploadValidationError, `expected UploadValidationError, got ${String(err)}`);
    assert.match((err as Error).message, pattern);
    return true;
  });
}

describe("parseUploadFile: GeoJSON", () => {
  it("returns one record per feature, keeping each feature's attributes", async () => {
    const parsed = await parseUploadFile("plans.geojson", enc({
      type: "FeatureCollection",
      features: [feature([square], { plan_id: "A", parcel_upi: "1/01" }), feature([shifted], { plan_id: "B", zoning: "R1" })],
    }));
    assert.equal(parsed.features.length, 2);
    assert.deepEqual(parsed.features.map((f) => f.properties.plan_id), ["A", "B"]);
    assert.deepEqual(parsed.fieldNames, ["plan_id", "parcel_upi", "zoning"]);
    assert.equal(parsed.format, "geojson");
  });

  it("keeps a MultiPolygon feature as a single record", async () => {
    const parsed = await parseUploadFile("plan.geojson", enc({
      type: "Feature",
      properties: { plan_id: "M" },
      geometry: { type: "MultiPolygon", coordinates: [[square], [shifted]] },
    }));
    assert.equal(parsed.features.length, 1);
    assert.equal(parsed.features[0]!.geometry.type, "MultiPolygon");
  });

  it("keeps holes, computes area, and closes unclosed rings with a warning", async () => {
    const hole = [[29.7655, -2.0895], [29.7655, -2.0885], [29.7665, -2.0885], [29.7665, -2.0895], [29.7655, -2.0895]];
    const parsed = await parseUploadFile("plan.geojson", enc(feature([square.slice(0, 4), hole])));
    const f = parsed.features[0]!;
    assert.equal(f.vertexCount, 10);
    assert.ok(f.areaSqMeters > 35_000 && f.areaSqMeters < 38_000, `area ${f.areaSqMeters}`);
    assert.match(parsed.warnings.join(" "), /closed automatically/);
  });

  it("skips features without geometry, with a warning", async () => {
    const parsed = await parseUploadFile("plan.geojson", enc({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }, feature([square])],
    }));
    assert.equal(parsed.features.length, 1);
    assert.match(parsed.warnings.join(" "), /Feature 1 has no geometry/);
  });

  it("converts legacy EPSG:3857 crs to WGS84", async () => {
    const mercator = [[3313424.6, -232709.3], [3313647.3, -232709.3], [3313647.3, -232486.7], [3313424.6, -232486.7], [3313424.6, -232709.3]];
    const parsed = await parseUploadFile("plan.geojson", enc({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
      features: [feature([mercator])],
    }));
    assert.ok(Math.abs(parsed.bbox[0] - 29.765) < 1e-5 && Math.abs(parsed.bbox[1] + 2.09) < 1e-5, `bbox ${parsed.bbox}`);
  });

  it("flags self-intersecting polygons for repair instead of rejecting the upload", async () => {
    const bowtie = [[29.765, -2.09], [29.767, -2.088], [29.767, -2.09], [29.765, -2.088], [29.765, -2.09]];
    const parsed = await parseUploadFile("plan.geojson", enc({ type: "FeatureCollection", features: [feature([square]), feature([bowtie])] }));
    assert.equal(parsed.features.length, 2);
    assert.equal(parsed.repairCount, 1);
    assert.equal(parsed.features[0]!.selfIntersection, undefined);
    const [lon, lat] = parsed.features[1]!.selfIntersection!;
    assert.ok(Math.abs(lon - 29.766) < 1e-9 && Math.abs(lat + 2.089) < 1e-9, `kink at ${lon}, ${lat}`);
  });

  it("accepts large files (thousands of parcels)", async () => {
    const many = Array.from({ length: 2_500 }, (_, i) =>
      feature([square.map(([x, y]) => [x! + (i % 50) * 0.003, y! - Math.floor(i / 50) * 0.003])], { parcel_upi: `P${i}` }),
    );
    const parsed = await parseUploadFile("big.geojson", enc({ type: "FeatureCollection", features: many }));
    assert.equal(parsed.features.length, 2_500);
    assert.equal(parsed.repairCount, 0);
  });

  it("rejects projected coordinates, unsupported crs, non-polygons, degenerate rings and bad files", async () => {
    const projected = [[473860, 4768920], [474082, 4768920], [474082, 4769141], [473860, 4768920]];
    await rejects(parseUploadFile("bad.geojson", enc(feature([projected]))), /projected coordinate system/);
    await rejects(parseUploadFile("bad.geojson", enc({ ...feature([square]), crs: { type: "name", properties: { name: "EPSG:32735" } } })), /Use WGS84/);
    await rejects(parseUploadFile("line.geojson", enc({ type: "LineString", coordinates: square })), /only polygon features/);
    await rejects(parseUploadFile("bad.geojson", enc(feature([[[29.7, -2], [29.8, -2], [29.7, -2]]]))), /at least 3 distinct/);
    await rejects(parseUploadFile("empty.geojson", new ArrayBuffer(0)), /empty/);
    await rejects(parseUploadFile("bad.geojson", new TextEncoder().encode("{not json").buffer as ArrayBuffer), /not valid UTF-8 JSON/);
    await rejects(parseUploadFile("plan.kml", enc(feature([square]))), /zipped Shapefile/);
  });
});

describe("parseUploadFile: zipped Shapefile", () => {
  async function zipped(features: { coords: number[][]; props: Record<string, unknown> }[], prj?: string): Promise<ArrayBuffer> {
    const zip = await shpwrite.zip(
      {
        type: "FeatureCollection",
        features: features.map((f) => ({ type: "Feature", properties: f.props, geometry: { type: "Polygon", coordinates: [f.coords] } })),
      },
      { outputType: "arraybuffer", compression: "STORE", ...(prj ? { prj } : {}) },
    );
    return zip as unknown as ArrayBuffer;
  }

  it("reads the sample NLA parcels (TM Rwanda .prj) as one record per parcel with their attributes", async () => {
    const parsed = await parseUploadFile("muhanga-parcels-tm-rwanda.zip", await file("samples/muhanga-parcels-tm-rwanda.zip"));
    assert.equal(parsed.format, "shapefile");
    assert.equal(parsed.features.length, 3);
    assert.deepEqual(parsed.features.map((f) => f.properties.parcel_upi), ["2/01/05/01/2201", "2/01/05/01/2202", "2/01/05/01/2203"]);
    assert.ok(parsed.fieldNames.includes("planning_s"), "DBF truncates field names to 10 characters");
    const [minLon, minLat] = parsed.bbox;
    assert.ok(Math.abs(minLon - 29.7672) < 0.001 && Math.abs(minLat + 2.0893) < 0.001, `reprojected bbox ${parsed.bbox}`);
  });

  it("reads a WGS84 shapefile without .prj reprojection", async () => {
    const parsed = await parseUploadFile("plan.zip", await zipped([{ coords: square, props: { plan_id: "X" } }]));
    assert.ok(Math.abs(parsed.bbox[0] - 29.765) < 1e-9);
    assert.equal(parsed.features[0]!.properties.plan_id, "X");
  });

  it("reprojects a TM Rwanda shapefile via its .prj", async () => {
    const tm = [[473860, 4768920], [473860, 4769141], [474082, 4769141], [474082, 4768920], [473860, 4768920]];
    const parsed = await parseUploadFile("plan.zip", await zipped([{ coords: tm, props: {} }], TM_RWANDA_WKT));
    assert.ok(Math.abs(parsed.bbox[0] - 29.765) < 0.0005 && Math.abs(parsed.bbox[1] + 2.09) < 0.0005, `bbox ${parsed.bbox}`);
  });

  it("rejects a .zip that is not a zip, and a zip renamed to .geojson", async () => {
    await rejects(parseUploadFile("plan.zip", enc(feature([square]))), /not a valid ZIP/);
    await rejects(parseUploadFile("plan.geojson", await zipped([{ coords: square, props: {} }])), /ZIP archive/);
  });
});
