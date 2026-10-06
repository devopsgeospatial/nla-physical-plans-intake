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

  async addAttachment(objectId: number, file: Blob, fileName: string): Promise<AddedAttachment> {
    const url = `${this.layerUrl}/${objectId}/addAttachment`;
    const response = await withToken(this.tokens, (token) =>
      arcgisRequest<AddAttachmentResponse>(
        url,
        {},
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
    const features: QueryFeature[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await withToken(this.tokens, (token) =>
        arcgisRequest<QueryResponse>(url, { ...params, resultOffset: offset, resultRecordCount: pageSize }, { referer: this.tokens.referer, token }),
      );
      features.push(...(page.features ?? []));
      if (!page.exceededTransferLimit || (page.features ?? []).length === 0) return features;
    }
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
