/**
 * Typed client for a single hosted feature layer: metadata, applyEdits and addAttachment.
 */
import type { EsriPolygon, EsriSpatialReference } from "../geo/esri-geometry";
import { withToken, type TokenProvider } from "./auth";
import { ArcGisRequestError, arcgisRequest } from "./rest";

export interface CodedValueDomain {
  type: "codedValue";
  name?: string;
  codedValues: { name: string; code: string | number }[];
}

export interface LayerField {
  name: string;
  type: string;
  alias?: string;
  length?: number;
  nullable?: boolean;
  editable?: boolean;
  domain?: CodedValueDomain | { type: string } | null;
}

export interface LayerMetadata {
  id: number;
  name: string;
  type: string;
  geometryType: string;
  objectIdField: string;
  globalIdField?: string;
  hasAttachments: boolean;
  capabilities: string;
  fields: LayerField[];
  maxRecordCount?: number;
  extent?: { spatialReference?: EsriSpatialReference };
  spatialReference?: EsriSpatialReference;
  sourceSpatialReference?: EsriSpatialReference;
}

interface EditResult {
  objectId: number;
  globalId?: string | null;
  success: boolean;
  error?: { code: number; description: string } | null;
}

interface ApplyEditsResponse {
  addResults?: EditResult[];
  updateResults?: EditResult[];
  deleteResults?: EditResult[];
}

interface AddAttachmentResponse {
  addAttachmentResult?: EditResult;
}

export type AttributeValue = string | number | null;

export interface QueryFeature {
  attributes: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
  /** With returnCentroid=true. */
  centroid?: { x: number; y: number };
}

export interface AttachmentInfo {
  id: number;
  name: string;
  contentType?: string;
  size?: number;
  keywords?: string | null;
}

interface QueryAttachmentsResponse {
  attachmentGroups?: { parentObjectId: number; attachmentInfos?: AttachmentInfo[] }[];
}

interface QueryResponse {
  features?: QueryFeature[];
  exceededTransferLimit?: boolean;
}

export interface AddedFeature {
  objectId: number;
  globalId: string | null;
}

export interface AddedAttachment {
  attachmentId: number;
  globalId: string | null;
  fileName: string;
  size: number;
  url: string;
}

const METADATA_TTL_MS = 5 * 60 * 1000;
/** ArcGIS requests run at most this many at a time. */
const PARALLEL_REQUESTS = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
/** Layer JSON is identical for every user, so it is cached per process and layer URL. */
const metadataCache = new Map<string, { value: Promise<LayerMetadata>; expiresAt: number }>();

export class FeatureLayerClient {
  constructor(
    readonly layerUrl: string,
    private readonly tokens: TokenProvider,
  ) {}

  /** Layer JSON, cached for 5 minutes per process so schema changes are picked up without a restart. */
  getMetadata(): Promise<LayerMetadata> {
    const hit = metadataCache.get(this.layerUrl);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = withToken(this.tokens, (token) =>
      arcgisRequest<LayerMetadata>(this.layerUrl, {}, { referer: this.tokens.referer, token, method: "GET" }),
    ).catch((err) => {
      metadataCache.delete(this.layerUrl);
      throw err;
    });
    metadataCache.set(this.layerUrl, { value, expiresAt: Date.now() + METADATA_TTL_MS });
    return value;
  }

  async getSpatialReference(): Promise<EsriSpatialReference> {
    const meta = await this.getMetadata();
    const sr = meta.sourceSpatialReference ?? meta.spatialReference ?? meta.extent?.spatialReference;
    if (!sr) throw new ArcGisRequestError("Layer metadata does not expose a spatial reference.", this.layerUrl);
    return sr;
  }

  /**
   * Adds features in one applyEdits call with rollbackOnFailure: either all are created or none.
   * Returns object IDs in input order.
   */
  async addFeatures(features: { geometry: EsriPolygon; attributes: Record<string, AttributeValue> }[]): Promise<AddedFeature[]> {
    const url = `${this.layerUrl}/applyEdits`;
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<ApplyEditsResponse>(url, { adds: features, rollbackOnFailure: true }, { referer: this.tokens.referer, token, timeoutMs: 180_000 }),
    );
    const results = response.addResults ?? [];
    if (results.length !== features.length) {
      throw new ArcGisRequestError(`applyEdits returned ${results.length} results for ${features.length} features.`, url);
    }
    const failedIndex = results.findIndex((r) => !r.success);
    if (failedIndex >= 0) {
      const failed = results[failedIndex]!;
      throw new FeatureRejectedError(
        failedIndex,
        `applyEdits rejected the feature: ${failed.error?.description ?? "unknown error"}`,
        url,
        failed.error?.code,
      );
    }
    return results.map((r) => ({ objectId: r.objectId, globalId: r.globalId ?? null }));
  }

  /** Updates attributes of existing features in one applyEdits call with rollbackOnFailure. */
  async updateFeatures(updates: { attributes: Record<string, AttributeValue> }[]): Promise<void> {
    if (updates.length === 0) return;
    const url = `${this.layerUrl}/applyEdits`;
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<ApplyEditsResponse>(url, { updates, rollbackOnFailure: true }, { referer: this.tokens.referer, token, timeoutMs: 180_000 }),
    );
    const results = response.updateResults ?? [];
    const failed = results.find((r) => !r.success);
    if (failed || results.length !== updates.length) {
      throw new ArcGisRequestError(`applyEdits could not update the records: ${failed?.error?.description ?? "unexpected response"}`, url, failed?.error?.code);
    }
  }

  async addAttachment(objectId: number, file: Blob, fileName: string, keywords?: string): Promise<AddedAttachment> {
    const url = `${this.layerUrl}/${objectId}/addAttachment`;
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<AddAttachmentResponse>(
        url,
        keywords ? { keywords } : {},
        { referer: this.tokens.referer, token, files: { attachment: { blob: file, fileName } }, timeoutMs: 180_000 },
      ),
    );

    const result = response.addAttachmentResult;
    if (!result?.success) {
      throw new ArcGisRequestError(
        `addAttachment failed for "${fileName}": ${result?.error?.description ?? "no addAttachmentResult returned"}`,
        url,
        result?.error?.code,
      );
    }
    return {
      attachmentId: result.objectId,
      globalId: result.globalId ?? null,
      fileName,
      size: file.size,
      url: `${this.layerUrl}/${objectId}/attachments/${result.objectId}`,
    };
  }

  /**
   * Runs a layer query (POST, so long WHERE clauses are fine), following pagination until all
   * matching features are read.
   */
  async queryAll(params: Record<string, string | number | boolean | object>): Promise<QueryFeature[]> {
    const meta = await this.getMetadata();
    const pageSize = Math.min(meta.maxRecordCount ?? 1000, 2000);
    const url = `${this.layerUrl}/query`;
    // A stable order, so pages fetched in parallel neither overlap nor skip records.
    // (Statistics and distinct-value queries are left as they are: ArcGIS refuses an order on them.)
    const ordered = params.outStatistics || params.returnDistinctValues ? params : { orderByFields: meta.objectIdField, ...params };
    const page = (offset: number) =>
      withToken(this.tokens, (token) =>
        arcgisRequest<QueryResponse>(url, { ...ordered, resultOffset: offset, resultRecordCount: pageSize }, { referer: this.tokens.referer, token }),
      );
    // Statistics come back in one small answer, and ArcGIS refuses paging on them with a spatial filter.
    if (params.outStatistics) {
      const stats = await withToken(this.tokens, (token) => arcgisRequest<QueryResponse>(url, params, { referer: this.tokens.referer, token }));
      return stats.features ?? [];
    }
    const first = await page(0);
    const features = [...(first.features ?? [])];
    if (!first.exceededTransferLimit || features.length === 0) return features;

    // More pages: count them, then fetch them a few at a time instead of one after another.
    const { geometry, geometryType, inSR, spatialRel, where } = params as Record<string, string | number | boolean | object>;
    const counted = await withToken(this.tokens, (token) =>
      arcgisRequest<{ count?: number }>(url, { where: where ?? "1=1", geometry, geometryType, inSR, spatialRel, returnCountOnly: true }, { referer: this.tokens.referer, token }),
    );
    const total = counted.count ?? 0;
    const offsets: number[] = [];
    for (let offset = features.length; offset < total; offset += pageSize) offsets.push(offset);
    const pages = await mapWithConcurrency(offsets, PARALLEL_REQUESTS, page);
    for (const p of pages) features.push(...(p.features ?? []));
    return features;
  }

  /** Object IDs of the matching features (one request; no record limit applies). */
  async queryObjectIds(params: Record<string, string | number | boolean | object>): Promise<number[]> {
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<{ objectIds?: number[] | null }>(`${this.layerUrl}/query`, { ...params, returnIdsOnly: true }, { referer: this.tokens.referer, token }),
    );
    return response.objectIds ?? [];
  }

  /** Extent of the matching features as [xmin, ymin, xmax, ymax], or null when none match. */
  async queryExtent(params: Record<string, string | number | boolean | object>): Promise<[number, number, number, number] | null> {
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<{ count?: number; extent?: { xmin: number; ymin: number; xmax: number; ymax: number } | null }>(
        `${this.layerUrl}/query`,
        { ...params, returnExtentOnly: true },
        { referer: this.tokens.referer, token },
      ),
    );
    const e = response.extent;
    return e && Number.isFinite(e.xmin) && (response.count ?? 1) > 0 ? [e.xmin, e.ymin, e.xmax, e.ymax] : null;
  }

  /** Attachment metadata (name, size, keywords) for the given features, grouped by feature. */
  async queryAttachments(objectIds: number[]): Promise<Map<number, AttachmentInfo[]>> {
    const url = `${this.layerUrl}/queryAttachments`;
    const chunks: number[][] = [];
    for (let i = 0; i < objectIds.length; i += 500) chunks.push(objectIds.slice(i, i + 500));
    const responses = await mapWithConcurrency(chunks, PARALLEL_REQUESTS, (chunk) =>
      withToken(this.tokens, (token) =>
        arcgisRequest<QueryAttachmentsResponse>(url, { objectIds: chunk.join(","), returnMetadata: true }, { referer: this.tokens.referer, token }),
      ),
    );
    const byFeature = new Map<number, AttachmentInfo[]>();
    for (const response of responses) for (const group of response.attachmentGroups ?? []) byFeature.set(group.parentObjectId, group.attachmentInfos ?? []);
    return byFeature;
  }

  /**
   * Attachments of every feature matching `where`, in one request (only features that have attachments
   * come back). Falls back to querying by IDs if ArcGIS caps the answer.
   */
  async queryAttachmentsWhere(where: string, objectIds: () => number[]): Promise<Map<number, AttachmentInfo[]>> {
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<QueryAttachmentsResponse & { exceededTransferLimit?: boolean }>(
        `${this.layerUrl}/queryAttachments`,
        { definitionExpression: where, returnMetadata: true },
        { referer: this.tokens.referer, token },
      ),
    );
    if (response.exceededTransferLimit) return this.queryAttachments(objectIds());
    const byFeature = new Map<number, AttachmentInfo[]>();
    for (const group of response.attachmentGroups ?? []) byFeature.set(group.parentObjectId, group.attachmentInfos ?? []);
    return byFeature;
  }

  /** Downloads one attachment's bytes (the REST endpoint streams the file itself, not JSON). */
  async downloadAttachment(objectId: number, attachmentId: number): Promise<Response> {
    const token = await this.tokens.getToken();
    // Public layers are read without a token.
    const url = `${this.layerUrl}/${objectId}/attachments/${attachmentId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const response = await fetch(url, { headers: { Referer: this.tokens.referer }, cache: "no-store", signal: AbortSignal.timeout(120_000) });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("json")) {
      throw new ArcGisRequestError(`Attachment ${attachmentId} of feature ${objectId} could not be downloaded.`, `${this.layerUrl}/${objectId}/attachments/${attachmentId}`, response.status);
    }
    return response;
  }

  /** Compensating delete used to roll back features whose append could not be completed. */
  async deleteFeatures(objectIds: number[]): Promise<void> {
    if (objectIds.length === 0) return;
    const url = `${this.layerUrl}/applyEdits`;
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<ApplyEditsResponse>(url, { deletes: objectIds }, { referer: this.tokens.referer, token, timeoutMs: 180_000 }),
    );
    const failed = (response.deleteResults ?? []).filter((r) => !r.success).map((r) => r.objectId);
    if (failed.length > 0 || (response.deleteResults ?? []).length !== objectIds.length) {
      throw new ArcGisRequestError(`Rollback could not delete object IDs: ${failed.join(", ") || "unknown"}`, url);
    }
  }
}

/** applyEdits refused one feature of a batch (so, with rollbackOnFailure, none were added). */
export class FeatureRejectedError extends ArcGisRequestError {
  constructor(
    readonly featureIndex: number,
    message: string,
    url: string,
    code?: number,
  ) {
    super(message, url, code);
    this.name = "FeatureRejectedError";
  }
}
