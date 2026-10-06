import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceValue, mapFields, type LayerFieldInfo } from "../../lib/plans/attribute-mapping";

const s = (name: string, length = 255): LayerFieldInfo => ({ name, type: "esriFieldTypeString", length, editable: true });

/** The real Physical_Plans schema. */
const LAYER: LayerFieldInfo[] = [
  { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
  s("plan_id"), s("parcel_upi"), s("gen_lu"), s("zone_code"), s("zoning"), s("planning_status"),
  { name: "approval_date", type: "esriFieldTypeDate", editable: true },
  { name: "area_sqm", type: "esriFieldTypeDouble", editable: true },
  s("sl"), s("remarks"), s("created_user"),
  { name: "created_date", type: "esriFieldTypeDate", editable: true },
  s("last_edited_user"),
  { name: "last_edited_date", type: "esriFieldTypeDate", editable: true },
  s("province", 50), s("district_1", 50), s("sector_1", 50), s("cell_1", 50),
  { name: "Shape__Area", type: "esriFieldTypeDouble", editable: false },
];

describe("mapFields", () => {
  it("matches case-insensitively and resolves 10-character DBF truncations", () => {
    const m = mapFields(["PLAN_ID", "planning_s", "approval_d", "District_1"], LAYER);
    assert.deepEqual(
      m.matched.map((x) => [x.fileField, x.layerField.name]),
      [["PLAN_ID", "plan_id"], ["planning_s", "planning_status"], ["approval_d", "approval_date"], ["District_1", "district_1"]],
    );
  });

  it("ignores unknown, read-only and ambiguous fields, and flags automatic ones", () => {
    const m = mapFields(["surveyor", "OBJECTID", "Shape__Area", "last_edite", "created_us", "created_date"], LAYER);
    assert.deepEqual(m.matched, []);
    assert.deepEqual(m.ignored, ["surveyor", "OBJECTID", "Shape__Area", "last_edite"]); // last_edite is ambiguous (user/date)
    assert.deepEqual(m.automatic, ["created_us", "created_date"]);
  });

  it("does not map two file fields onto the same layer field", () => {
    const m = mapFields(["plan_id", "PLAN_ID"], LAYER);
    assert.equal(m.matched.length, 1);
    assert.deepEqual(m.ignored, ["PLAN_ID"]);
  });
});

describe("coerceValue", () => {
  const field = (name: string) => LAYER.find((f) => f.name === name)!;

  it("converts text, numbers and empty values", () => {
    assert.equal(coerceValue("  R1 ", field("zone_code")), "R1");
    assert.equal(coerceValue(12, field("plan_id")), "12");
    assert.equal(coerceValue("", field("remarks")), null);
    assert.equal(coerceValue(undefined, field("remarks")), null);
    assert.equal(coerceValue("1234,5", field("area_sqm")), 1234.5);
  });

  it("converts dates (DBF Date objects keep their calendar day; ISO strings; epoch ms)", () => {
    assert.equal(coerceValue(new Date(2026, 2, 15), field("approval_date")), Date.UTC(2026, 2, 15));
    assert.equal(coerceValue("2026-03-15", field("approval_date")), Date.UTC(2026, 2, 15));
    assert.equal(coerceValue(1773532800000, field("approval_date")), 1773532800000);
  });

  it("rejects values the field cannot hold", () => {
    assert.throws(() => coerceValue("abc", field("area_sqm")), /not a number/);
    assert.throws(() => coerceValue("not a date", field("approval_date")), /not a date/);
    assert.throws(() => coerceValue("x".repeat(51), field("district_1")), /allows 50/);
  });
});
