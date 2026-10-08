import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import type { PublicConfig } from "../arcgis/config";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import { isPlannerAttachment } from "../plans/review-status";
import type { District } from "./districts";
import { districtBoundary } from "./geo-index";

/**
 * Documents of the approved plans of one district: the PDFs the district submitted with its plan and
 * the documents NLA attached when reviewing it. Only records the public may see are ever read.
 */

export interface PublicDocument {
  objectId: number;
  attachmentId: number;
  name: string;
  size: number | null;
  /** Submitted by the district with the plan, or attached by NLA. */
  source: "district" | "nla";
  approvedAt: number | null;
  cell: string | null;
}

export function publicPlans(config: PublicConfig): FeatureLayerClient {
  const tokens: TokenProvider = { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
  return new FeatureLayerClient(config.planLayerUrl, tokens);
}

/**
 * Query for the plans of a district the public may see: approved, and lying in the district (by
 * location, so plans whose district attribute was left empty are included).
 */
export async function districtPlansQuery(config: PublicConfig, district: District): Promise<Record<string, string | number | object>> {
  const boundary = await districtBoundary(config, district.name);
  if (!boundary) throw new Error(`No boundary found for ${district.name} District.`);
  return { where: config.planFilter, geometry: boundary.esri, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects" };
}

export async function listDocuments(config: PublicConfig, district: District): Promise<PublicDocument[]> {
  const layer = publicPlans(config);
  const meta = await layer.getMetadata();
  if (!meta.hasAttachments) return [];
  const plans = await layer.queryAll({ ...(await districtPlansQuery(config, district)), outFields: `${meta.objectIdField},approval_date,cell_1`, returnGeometry: false });
  const info = new Map(plans.map((p) => [Number(p.attributes[meta.objectIdField]), p.attributes]));
  const attachments = await layer.queryAttachments([...info.keys()]);

  const seen = new Set<string>();
  const docs: PublicDocument[] = [];
  for (const [objectId, list] of attachments) {
    const a = info.get(objectId) ?? {};
    for (const att of list) {
      // A revised plan carries copies of NLA's earlier documents: list each file once.
      const key = `${att.name}|${att.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        objectId,
        attachmentId: att.id,
        name: att.name,
        size: att.size ?? null,
        source: isPlannerAttachment(att.keywords) || !att.keywords ? "district" : "nla",
        approvedAt: typeof a.approval_date === "number" ? a.approval_date : null,
        cell: typeof a.cell_1 === "string" ? a.cell_1 : null,
      });
    }
  }
  return docs.sort((x, y) => (y.approvedAt ?? 0) - (x.approvedAt ?? 0) || x.name.localeCompare(y.name));
}

/** True when the record is one the public may see (approved, in this district). */
export async function isPublicRecord(config: PublicConfig, district: District, objectId: number): Promise<boolean> {
  const layer = publicPlans(config);
  const meta = await layer.getMetadata();
  const query = await districtPlansQuery(config, district);
  const found = await layer.queryAll({ ...query, where: `(${query.where}) AND ${meta.objectIdField} = ${objectId}`, outFields: meta.objectIdField, returnGeometry: false });
  return found.length > 0;
}
