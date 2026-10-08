/**
 * NLA's decision lives on the parcel records themselves, in the layer's existing fields:
 *
 *   approval_date set             → approved (and shown on the public map: `approval_date IS NOT NULL`)
 *   remarks set, no approval_date → returned to the planner with NLA's comment
 *   neither                       → waiting for NLA
 *
 * A submission (one upload) takes the status of its parcels.
 */

export type ParcelStatus = "waiting" | "returned" | "approved";
export type SubmissionStatus = "waiting" | "returned" | "partly_approved" | "approved";

export function parcelStatus(approvedAt: number | null, comment: string | null): ParcelStatus {
  if (approvedAt !== null) return "approved";
  return comment ? "returned" : "waiting";
}

export function submissionStatus(parcels: ParcelStatus[]): SubmissionStatus {
  if (parcels.length > 0 && parcels.every((p) => p === "approved")) return "approved";
  if (parcels.some((p) => p === "returned")) return "returned";
  return parcels.some((p) => p === "approved") ? "partly_approved" : "waiting";
}

/** Attachment keywords: who added the document. Anything without the planner keyword counts as from NLA. */
export const PLANNER_ATTACHMENT_KEYWORD = "planner-submission";
export const REVIEWER_ATTACHMENT_KEYWORD = "nla-review";

export function isPlannerAttachment(keywords: string | null | undefined): boolean {
  return (keywords ?? "").split(/[,;\s]+/).includes(PLANNER_ATTACHMENT_KEYWORD);
}
