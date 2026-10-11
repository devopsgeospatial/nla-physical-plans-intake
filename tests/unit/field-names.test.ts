import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fieldName, mapFields } from "../../lib/plans/attribute-mapping";

/** Rwanda_Physical_Plans: published from a shapefile, so long names are cut to 10 characters. */
const TRUNCATED = ["plan_id", "parcel_upi", "planning_s", "approval_d", "area_sqm", "remarks", "created_us", "created_da", "district_1"].map((name) => ({
  name,
  type: name === "approval_d" || name === "created_da" ? "esriFieldTypeDate" : name === "area_sqm" ? "esriFieldTypeDouble" : "esriFieldTypeString",
  length: 254,
  editable: true,
}));

describe("field names, full or shapefile-truncated", () => {
  it("finds a layer field by its full name or its 10-character cut", () => {
    assert.equal(fieldName(TRUNCATED, "approval_date"), "approval_d");
    assert.equal(fieldName(TRUNCATED, "created_user"), "created_us");
    assert.equal(fieldName(TRUNCATED, "remarks"), "remarks");
    assert.equal(fieldName([{ name: "approval_date" }], "approval_date"), "approval_date");
    assert.equal(fieldName(TRUNCATED, "zoning"), undefined);
  });

  it("maps a planner's full field names onto the truncated layer", () => {
    const m = mapFields(["plan_id", "planning_status", "district_1"], TRUNCATED);
    assert.deepEqual(m.matched.map((x) => [x.fileField, x.layerField.name]), [["plan_id", "plan_id"], ["planning_status", "planning_s"], ["district_1", "district_1"]]);
  });

  it("never copies NLA's response or the app's own fields from the file, whatever the layer naming", () => {
    const m = mapFields(["approval_date", "remarks", "created_user", "created_date"], TRUNCATED);
    assert.equal(m.matched.length, 0);
    assert.deepEqual(m.automatic.sort(), ["approval_date", "created_date", "created_user", "remarks"]);
  });
});
