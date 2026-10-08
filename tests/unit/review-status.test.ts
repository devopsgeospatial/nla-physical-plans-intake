import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlannerAttachment, parcelStatus, submissionStatus } from "../../lib/plans/review-status";

describe("NLA decision from the existing fields", () => {
  it("reads one parcel: approval_date wins, a comment alone returns it", () => {
    assert.equal(parcelStatus(null, null), "waiting");
    assert.equal(parcelStatus(null, "Widen the road reserve"), "returned");
    assert.equal(parcelStatus(Date.UTC(2026, 9, 9), "Approved with conditions"), "approved");
  });

  it("gives a submission the status of its parcels", () => {
    assert.equal(submissionStatus(["approved", "approved"]), "approved");
    assert.equal(submissionStatus(["approved", "returned"]), "returned", "the planner has something to fix");
    assert.equal(submissionStatus(["approved", "waiting"]), "partly_approved");
    assert.equal(submissionStatus(["waiting", "waiting"]), "waiting");
    assert.equal(submissionStatus([]), "waiting");
  });

  it("tells planner documents from NLA documents by keyword", () => {
    assert.equal(isPlannerAttachment("planner-submission"), true);
    assert.equal(isPlannerAttachment("nla-review"), false);
    assert.equal(isPlannerAttachment(null), false);
  });
});
