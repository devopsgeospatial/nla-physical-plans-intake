import assert from "node:assert/strict";
import { describe, it } from "node:test";
import shpwrite from "@mapbox/shp-write";
import { BoundaryValidationError, parseBoundaryFile } from "../../lib/geo/parse-boundary";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

const TM_RWANDA_WKT =
  'PROJCS["ITRF_2005",GEOGCS["GCS_ITRF_2005",DATUM["D_ITRF_2005",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",5000000.0],PARAMETER["Central_Meridian",30.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

const square = [
  [29.765, -2.09],
  [29.767, -2.09],
  [29.767, -2.088],
  [29.765, -2.088],
  [29.765, -2.09],
];

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof BoundaryValidationError, `expected BoundaryValidationError, got ${String(err)}`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe("parseBoundaryFile: GeoJSON", () => {
  it("accepts a FeatureCollection polygon with a hole and computes area/bbox", async () => {
    const hole = [[29.7655, -2.0895], [29.7655, -2.0885], [29.7665, -2.0885], [29.7665, -2.0895], [29.7655, -2.0895]];
    const parsed = await parseBoundaryFile("plan.geojson", enc({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [square, hole] } }],
    }));
    assert.equal(parsed.geometry.type, "Polygon");
    assert.equal(parsed.sourceFormat, "geojson");
    assert.equal(parsed.vertexCount, 10);
    assert.deepEqual(parsed.bbox, [29.765, -2.09, 29.767, -2.088]);
    // ~222 m x 221 m minus a ~111 m x 111 m hole
    assert.ok(parsed.areaSqMeters > 35_000 && parsed.areaSqMeters < 38_000, `area ${parsed.areaSqMeters}`);
  });

  it("merges multiple polygon features into a MultiPolygon", async () => {
    const shifted = square.map(([x, y]) => [x! + 0.01, y!]);
    const parsed = await parseBoundaryFile("plan.json", enc({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [square] } },
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [shifted] } },
      ],
    }));
    assert.equal(parsed.geometry.type, "MultiPolygon");
    assert.equal(parsed.polygonCount, 2);
  });

  it("closes an unclosed ring and reports a warning", async () => {
    const parsed = await parseBoundaryFile("plan.geojson", enc({ type: "Polygon", coordinates: [square.slice(0, 4)] }));
    assert.equal(parsed.vertexCount, 5);
    assert.match(parsed.warnings.join(" "), /closed automatically/);
  });

  it("drops Z values", async () => {
    const parsed = await parseBoundaryFile("plan.geojson", enc({ type: "Polygon", coordinates: [square.map((p) => [...p, 1500])] }));
    assert.equal((parsed.geometry.coordinates[0] as number[][])[0]!.length, 2);
  });

  it("converts legacy EPSG:3857 crs to WGS84", async () => {
    const mercator = [[3313432, -232685], [3313655, -232685], [3313655, -232462], [3313432, -232462], [3313432, -232685]];
    const parsed = await parseBoundaryFile("plan.geojson", enc({
      type: "Polygon",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
      coordinates: [mercator],
    }));
    assert.ok(Math.abs(parsed.bbox[0] - 29.765) < 0.001 && Math.abs(parsed.bbox[1] + 2.09) < 0.001, `bbox ${parsed.bbox}`);
  });

  it("rejects self-intersecting boundaries", async () => {
    const bowtie = [[29.765, -2.09], [29.767, -2.088], [29.767, -2.09], [29.765, -2.088], [29.765, -2.09]];
    await rejects(parseBoundaryFile("bad.geojson", enc({ type: "Polygon", coordinates: [bowtie] })), /self-intersecting/);
  });

  it("rejects projected coordinates without a crs", async () => {
    const projected = [[473860, 4768920], [474082, 4768920], [474082, 4769141], [473860, 4768920]];
    await rejects(parseBoundaryFile("bad.geojson", enc({ type: "Polygon", coordinates: [projected] })), /projected coordinate system/);
  });

  it("rejects an unsupported crs", async () => {
    const body = { type: "Polygon", crs: { type: "name", properties: { name: "EPSG:32735" } }, coordinates: [square] };
    await rejects(parseBoundaryFile("bad.geojson", enc(body)), /Only WGS84/);
  });

  it("rejects non-polygon geometries", async () => {
    await rejects(parseBoundaryFile("line.geojson", enc({ type: "LineString", coordinates: square })), /only Polygon\/MultiPolygon/);
  });

  it("rejects degenerate rings and empty/invalid files", async () => {
    await rejects(parseBoundaryFile("bad.geojson", enc({ type: "Polygon", coordinates: [[[29.7, -2], [29.8, -2], [29.7, -2]]] })), /at least 3 distinct/);
    await rejects(parseBoundaryFile("empty.geojson", new ArrayBuffer(0)), /empty/);
    await rejects(parseBoundaryFile("bad.geojson", new TextEncoder().encode("{not json").buffer as ArrayBuffer), /not valid UTF-8 JSON/);
    await rejects(parseBoundaryFile("plan.kml", enc({ type: "Polygon", coordinates: [square] })), /must be \.geojson/);
  });
});

describe("parseBoundaryFile: zipped Shapefile", () => {
  async function zippedShapefile(coordinates: number[][], prj?: string): Promise<ArrayBuffer> {
    const zip = await shpwrite.zip(
      { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "plan" }, geometry: { type: "Polygon", coordinates: [coordinates] } }] },
      { outputType: "arraybuffer", compression: "STORE", ...(prj ? { prj } : {}) },
    );
    return zip as unknown as ArrayBuffer;
  }

  it("reads a WGS84 shapefile", async () => {
    const parsed = await parseBoundaryFile("plan.zip", await zippedShapefile(square));
    assert.equal(parsed.sourceFormat, "shapefile");
    assert.ok(Math.abs(parsed.bbox[0] - 29.765) < 1e-9);
  });

  it("reprojects a TM Rwanda shapefile to WGS84 via its .prj", async () => {
    const tm = [[473860, 4768920], [473860, 4769141], [474082, 4769141], [474082, 4768920], [473860, 4768920]];
    const parsed = await parseBoundaryFile("plan.zip", await zippedShapefile(tm, TM_RWANDA_WKT));
    const [minLon, minLat] = parsed.bbox;
    assert.ok(Math.abs(minLon - 29.765) < 0.0005 && Math.abs(minLat + 2.09) < 0.0005, `bbox ${parsed.bbox}`);
  });

  it("rejects a .zip that is not a zip, and a zip renamed to .geojson", async () => {
    await rejects(parseBoundaryFile("plan.zip", enc({ type: "Polygon", coordinates: [square] })), /not a valid ZIP/);
    await rejects(parseBoundaryFile("plan.geojson", await zippedShapefile(square)), /ZIP archive/);
  });
});
