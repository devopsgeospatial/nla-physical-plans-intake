import "server-only";

import type { AttributeValue, FeatureLayerClient, LayerMetadata } from "../arcgis/feature-layer";
import { REVIEWER_ATTACHMENT_KEYWORD } from "./review-status";
import { loadSubmission, submissionFields, type Submission } from "./submissions";

export type Decision = "approve" | "return";

export interface DecisionRequest {
  planner: string;
  submittedAt: number;
  decision: Decision;
  comment: string;
  documents: { file: Blob; fileName: string }[];
}

/** The decision cannot be recorded as asked (unknown submission, missing comment, ...). */
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

const BATCH_SIZE = 200;
/** remarks is a 255-character text field on Physical_Plans. */
export const MAX_COMMENT_LENGTH = 255;

/**
 * Records NLA's decision on every parcel of a submission that is not approved yet, in the layer's
 * existing fields:
 * - approve: approval_date = today, remarks = the comment (or cleared). The parcels then appear on the
 *   public map, which filters on `approval_date IS NOT NULL`.
 * - return:  remarks = the comment (required), approval_date cleared. The planner sees the comment
 *   under My submissions and can send a revised plan, which replaces these parcels.
 * Documents are attached to the first of those parcels, tagged as NLA's.
 */
export async function recordDecision(layer: FeatureLayerClient, meta: LayerMetadata, request: DecisionRequest): Promise<Submission> {
  const fields = submissionFields(meta);
  if (!fields.approvalDate || !fields.remarks) {
    throw new ReviewError(`"${meta.name}" has no approval_date / remarks fields to record the decision in.`, 500);
  }
  const comment = request.comment.trim();
  if (request.decision === "return" && !comment) throw new ReviewError("Write what the planner needs to change.");
  const maxLength = meta.fields.find((f) => f.name === fields.remarks)?.length ?? MAX_COMMENT_LENGTH;
  if (comment.length > maxLength) throw new ReviewError(`The comment is too long (${comment.length}/${maxLength} characters).`);
  if (request.documents.length > 0 && !meta.hasAttachments) throw new ReviewError(`Attachments are turned off on "${meta.name}".`);

  const submission = await loadSubmission(layer, meta, request.planner, request.submittedAt);
  if (!submission) throw new ReviewError("This submission no longer exists. The planner may have replaced it with a revised plan.", 404);
  const open = submission.parcels.filter((p) => p.status !== "approved").map((p) => p.objectId);
  if (open.length === 0) throw new ReviewError("Every parcel of this submission is already approved.", 409);

  const values: Record<string, AttributeValue> =
    request.decision === "approve"
      ? { [fields.approvalDate]: todayInKigali(), [fields.remarks]: comment || null }
      : { [fields.approvalDate]: null, [fields.remarks]: comment };
  for (let i = 0; i < open.length; i += BATCH_SIZE) {
    await layer.updateFeatures(open.slice(i, i + BATCH_SIZE).map((objectId) => ({ attributes: { [fields.objectId]: objectId, ...values } })));
  }
  for (const doc of request.documents) await layer.addAttachment(open[0]!, doc.file, doc.fileName, REVIEWER_ATTACHMENT_KEYWORD);

  return (await loadSubmission(layer, meta, request.planner, request.submittedAt)) ?? submission;
}

/** approval_date holds a calendar day: today in Rwanda (UTC+2, no daylight saving), stored as midnight UTC. */
function todayInKigali(): number {
  const now = new Date(Date.now() + 2 * 3600_000);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
