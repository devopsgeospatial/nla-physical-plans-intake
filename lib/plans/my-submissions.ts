import "server-only";

import type { FeatureLayerClient, LayerMetadata } from "../arcgis/feature-layer";
import { AUTO_FIELDS, NLA_RESPONSE_FIELDS, PLANNER_ATTACHMENT_KEYWORD } from "./attribute-mapping";

/**
 * A planner's submissions and NLA's response to each. One submission = one upload: every parcel the
 * app appended in that upload carries the same created_user and created_date.
 *
 * NLA responds on the record itself (see NLA_RESPONSE_FIELDS): approval_date set = approved, remarks =
 * NLA's comment. Attachments without the planner keyword are documents NLA attached.
 */

export type SubmissionStatus = "waiting" | "responded" | "partly_approved" | "approved";

export interface SubmissionDocument {
  objectId: number;
  attachmentId: number;
  name: string;
  size: number | null;
}

export interface Submission {
  /** created_date of the upload (epoch ms), also its id. */
  submittedAt: number;
  objectIds: number[];
  planIds: string[];
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
  planId: string | null;
  district: string | null;
  createdAt: number;
  approvedAt: number | null;
  comment: string | null;
}

/** SQL string literal for a where clause. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function loadMySubmissions(layer: FeatureLayerClient, meta: LayerMetadata, username: string): Promise<Submission[]> {
  const field = (name: string) => meta.fields.find((f) => f.name.toLowerCase() === name)?.name;
  const oid = meta.objectIdField;
  const createdUser = field(AUTO_FIELDS.createdUser);
  const createdDate = field(AUTO_FIELDS.createdDate);
  if (!createdUser || !createdDate) return [];
  const approval = field(NLA_RESPONSE_FIELDS.approvalDate);
  const remarks = field(NLA_RESPONSE_FIELDS.comment);
  const planId = field("plan_id");
  const district = field("district_1");

  const rows: ParcelRow[] = (
    await layer.queryAll({
      where: `${createdUser} = ${sqlString(username)}`,
      outFields: [oid, createdDate, approval, remarks, planId, district].filter(Boolean).join(","),
      returnGeometry: false,
      orderByFields: `${createdDate} DESC`,
    })
  ).map(({ attributes: a }) => ({
    objectId: Number(a[oid]),
    planId: text(planId && a[planId]),
    district: text(district && a[district]),
    createdAt: Number(a[createdDate] ?? 0),
    approvedAt: approval && typeof a[approval] === "number" ? (a[approval] as number) : null,
    comment: text(remarks && a[remarks]),
  }));

  const attachments = rows.length > 0 ? await layer.queryAttachments(rows.map((r) => r.objectId)) : new Map();

  const groups = new Map<number, ParcelRow[]>();
  for (const row of rows) groups.set(row.createdAt, [...(groups.get(row.createdAt) ?? []), row]);

  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([submittedAt, parcels]) => {
      const approvedCount = parcels.filter((p) => p.approvedAt !== null).length;
      const comments = unique(parcels.map((p) => p.comment));
      const docs = parcels.flatMap((p) =>
        (attachments.get(p.objectId) ?? []).map((info: { id: number; name: string; size?: number; keywords?: string | null }) => ({
          own: (info.keywords ?? "").split(/[,;\s]+/).includes(PLANNER_ATTACHMENT_KEYWORD),
          doc: { objectId: p.objectId, attachmentId: info.id, name: info.name, size: info.size ?? null },
        })),
      );
      const status: SubmissionStatus =
        approvedCount === parcels.length ? "approved" : approvedCount > 0 ? "partly_approved" : comments.length > 0 || docs.some((d) => !d.own) ? "responded" : "waiting";
      return {
        submittedAt,
        objectIds: parcels.map((p) => p.objectId),
        planIds: unique(parcels.map((p) => p.planId)),
        districts: unique(parcels.map((p) => p.district)),
        status,
        approvedCount,
        approvedAt: approvedCount > 0 ? Math.max(...parcels.map((p) => p.approvedAt ?? 0)) : null,
        comments,
        nlaDocuments: docs.filter((d) => !d.own).map((d) => d.doc),
        ownDocuments: docs.filter((d) => d.own).map((d) => d.doc),
      };
    });
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}
