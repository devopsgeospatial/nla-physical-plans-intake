import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteNameFromLayer, stageOf, stagesFor } from "../../lib/public/stages";

describe("site stages (from site_stage)", () => {
  it("recognises the stage however it is written", () => {
    assert.equal(stageOf("Initial Proposal and Conceptualization")?.n, 1);
    assert.equal(stageOf("draft review")?.n, 2);
    assert.equal(stageOf("Technical assessment")?.n, 2);
    assert.equal(stageOf("Public Consultation & Provisional Approval")?.n, 3);
    assert.equal(stageOf("Executive review and final approval")?.n, 4);
    assert.equal(stageOf("Gazettement")?.n, 5);
    assert.equal(stageOf("Implementation monitoring")?.n, 5);
  });

  it("accepts a stage number", () => {
    assert.equal(stageOf(3)?.n, 3);
    assert.equal(stageOf("4")?.n, 4);
    assert.equal(stageOf("Stage 2")?.n, 2);
  });

  it("treats other values as stage not recorded", () => {
    for (const v of ["Resurvey", "", " ", null, undefined, 9, "7"]) assert.equal(stageOf(v), null);
  });

  it("gives ongoing sites stages 1–4 and completed sites stage 5", () => {
    assert.deepEqual(stagesFor("Ongoing").map((s) => s.n), [1, 2, 3, 4]);
    assert.deepEqual(stagesFor("Completed").map((s) => s.n), [5]);
    assert.equal(stagesFor(null).length, 5);
    assert.equal(stageOf("Gazettement")?.status, "Completed");
    assert.equal(stageOf("Draft review")?.status, "Ongoing");
  });

  it("names a site without site_name after its layer", () => {
    assert.equal(siteNameFromLayer("Karama_physical"), "Karama Physical");
    assert.equal(siteNameFromLayer("  kigali  site-plan "), "Kigali Site Plan");
  });
});
