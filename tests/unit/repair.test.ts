import assert from "node:assert/strict";
import { describe, it } from "node:test";
import kinks from "@turf/kinks";
import type { Polygon } from "geojson";
import { repairSelfIntersections } from "../../lib/geo/repair";

describe("local repair of self-intersecting polygons (when the geometry service is unavailable)", () => {
  it("splits a figure-eight into its two loops, with no crossings left", () => {
    const bowtie: Polygon = { type: "Polygon", coordinates: [[[29.71, -2.2], [29.7102, -2.1998], [29.7102, -2.2], [29.71, -2.1998], [29.71, -2.2]]] };
    const repaired = repairSelfIntersections(bowtie);
    assert.equal(repaired.type, "MultiPolygon");
    assert.equal(repaired.coordinates.length, 2);
    for (const coords of repaired.coordinates as number[][][][]) {
      assert.equal(kinks({ type: "Polygon", coordinates: coords }).features.length, 0);
    }
  });

  it("leaves a valid polygon as it is", () => {
    const square: Polygon = { type: "Polygon", coordinates: [[[30, -2], [30.001, -2], [30.001, -1.999], [30, -1.999], [30, -2]]] };
    const repaired = repairSelfIntersections(square);
    assert.equal(repaired.type, "Polygon");
    assert.deepEqual(repaired.coordinates[0]!.length, 5);
  });
});
