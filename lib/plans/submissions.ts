import "server-only";

import type { FeatureLayerClient, LayerMetadata } from "../arcgis/feature-layer";
import { AUTO_FIELDS, NLA_RESPONSE_FIELDS } from "./attribute-mapping";
import { isPlannerAttachment, parcelStatus, submissionStatus, type ParcelStatus, type SubmissionStatus } from "./review-status";

/**
 * Submissions and NLA's response to each. One submission = one upload: every parcel the app appended
 * in that upload carries the same created_user and created_date.
 *
 * NLA responds on the records themselves (see review-status.ts). Attachments without the planner
 * keyword are documents NLA attached.
 */

export type { SubmissionStatus };

export interface SubmissionDocument {
  objectId: number;
  attachmentId: number;
  name: string;
  size: number | null;
}

export interface Submission {
  /** Username of the planner who submitted it (created_user). */
  planner: string;
  /** created_date of the upload (epoch ms); with `planner`, identifies the submission. */
  submittedAt: number;
  objectIds: number[];
  parcels: { objectId: number; status: ParcelStatus }[];
  districts: string[];
  status: SubmissionStatus;
  approvedCount: number;
  /** Latest approval date among its parcels. */
  approvedAt: number | null;
  /** NLA's comments (distinct remarks across the submission's parcels). */
  comments: string[];
  nlaDocuments: SubmissionDocument[];
  ownDocuments: SubmissionDocument[];
}

interface ParcelRow {
  objectId: number;
  planner: string;
  district: string | null;
  createdAt: number;
  approvedAt: number | null;
  comment: string | null;
}

/** SQL string literal for a where clause. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Actual field names on the layer (names differ in case between layers). */
export function submissionFields(meta: LayerMetadata) {
  const field = (name: string) => meta.fields.find((f) => f.name.toLowerCase() === name)?.name;
  return {
    objectId: meta.objectIdField,
    createdUser: field(AUTO_FIELDS.createdUser),
    createdDate: field(AUTO_FIELDS.createdDate),
    approvalDate: field(NLA_RESPONSE_FIELDS.approvalDate),
    remarks: field(NLA_RESPONSE_FIELDS.comment),
    district: field("district_1"),
  };
}

/**
 * Submissions, newest first: one planner's (`planner`) or everyone's created since `since` (the
 * review queue). Dates are compared here rather than in SQL, which date literals make layer-specific.
 */
export async function loadSubmissions(
  layer: FeatureLayerClient,
  meta: LayerMetadata,
  options: { planner?: string; since?: number },
): Promise<Submission[]> {
  const f = submissionFields(meta);
  const { createdUser, createdDate } = f;
  if (!createdUser || !createdDate) return [];

  const rows: ParcelRow[] = (
    await layer.queryAll({
      where: options.planner ? `${createdUser} = ${sqlString(options.planner)}` : "1=1",
      outFields: [f.objectId, createdUser, createdDate, f.approvalDate, f.remarks, f.district].filter(Boolean).join(","),
      returnGeometry: false,
      orderByFields: `${createdDate} DESC`,
    })
  )
    .map(({ attributes: a }) => ({
      objectId: Number(a[f.objectId]),
      planner: text(a[createdUser]) ?? "",
      district: text(f.district && a[f.district]),
      createdAt: Number(a[createdDate] ?? 0),
      approvedAt: f.approvalDate && typeof a[f.approvalDate] === "number" ? (a[f.approvalDate] as number) : null,
      comment: text(f.remarks && a[f.remarks]),
    }))
    .filter((r) => r.planner && r.createdAt > 0 && r.createdAt >= (options.since ?? 0));

  const attachments = rows.length > 0 ? await layer.queryAttachments(rows.map((r) => r.objectId)) : new Map();

  const groups = new Map<string, ParcelRow[]>();
  for (const row of rows) {
    const key = `${row.planner}\n${row.createdAt}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()]
    .sort((a, b) => b[0]!.createdAt - a[0]!.createdAt)
    .map((parcels) => {
      const statuses = parcels.map((p) => parcelStatus(p.approvedAt, p.comment));
      const approvedCount = statuses.filter((s) => s === "approved").length;
      const docs = parcels.flatMap((p) =>
        (attachments.get(p.objectId) ?? []).map((info: { id: number; name: string; size?: number; keywords?: string | null }) => ({
          own: isPlannerAttachment(info.keywords),
          doc: { objectId: p.objectId, attachmentId: info.id, name: info.name, size: info.size ?? null },
        })),
      );
      return {
        planner: parcels[0]!.planner,
        submittedAt: parcels[0]!.createdAt,
        objectIds: parcels.map((p) => p.objectId),
        parcels: parcels.map((p, i) => ({ objectId: p.objectId, status: statuses[i]! })),
        districts: unique(parcels.map((p) => p.district)),
        status: submissionStatus(statuses),
        approvedCount,
        approvedAt: approvedCount > 0 ? Math.max(...parcels.map((p) => p.approvedAt ?? 0)) : null,
        comments: unique(parcels.map((p) => p.comment)),
        nlaDocuments: docs.filter((d) => !d.own).map((d) => d.doc),
        ownDocuments: docs.filter((d) => d.own).map((d) => d.doc),
      };
    });
}

/** One planner's submission, or null if it does not exist. */
export async function loadSubmission(
  layer: FeatureLayerClient,
  meta: LayerMetadata,
  planner: string,
  submittedAt: number,
): Promise<Submission | null> {
  return (await loadSubmissions(layer, meta, { planner })).find((s) => s.submittedAt === submittedAt) ?? null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/**
 * Start of a where clause limiting a query to the signed-in planner's own parcels. Reviewers (signed in
 * to the review app) see every parcel, so for them it is empty.
 */
export function ownerFilter(meta: LayerMetadata, config: { appMode: string }, session: { username: string; reviewer?: boolean }): string {
  if (config.appMode === "review" && session.reviewer) return "";
  const createdUser = submissionFields(meta).createdUser ?? AUTO_FIELDS.createdUser;
  return `${createdUser} = ${sqlString(session.username)} AND `;
}
