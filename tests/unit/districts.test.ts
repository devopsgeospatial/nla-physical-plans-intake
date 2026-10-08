import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISTRICTS, findDistrict, hasCadastre, normalizeUpi } from "../../lib/public/districts";

describe("public viewer districts and UPIs", () => {
  it("lists Rwanda's 30 districts, with Muhanga's cadastre connected", () => {
    assert.equal(DISTRICTS.length, 30);
    assert.equal(new Set(DISTRICTS.map((d) => d.slug)).size, 30);
    assert.ok(hasCadastre(findDistrict("Muhanga")!));
    assert.equal(hasCadastre(findDistrict("huye")!), false);
    assert.equal(findDistrict("atlantis"), undefined);
  });

  it("accepts the usual ways of typing a UPI", () => {
    for (const input of ["2/07/01/01/5833", " 2 / 07 / 01 / 01 / 5833 ", "2-07-01-01-5833", String.raw`2\07\01\01\5833`, "2 07 01 01 5833"]) {
      assert.equal(normalizeUpi(input), "2/07/01/01/5833", input);
    }
  });

  it("rejects anything that is not a five-part UPI (including SQL)", () => {
    for (const input of ["", "2/07/01/5833", "2/07/01/01/5833/9", "2/07/01/01/58a3", "1' OR '1'='1"]) {
      assert.equal(normalizeUpi(input), null, input);
    }
  });
});
