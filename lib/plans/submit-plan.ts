import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import { getArcGisConfig, type ArcGisConfig } from "../arcgis/config";
import { FeatureLayerClient, type AddedAttachment, type LayerField, type LayerMetadata } from "../arcgis/feature-layer";
import { projectPolygon, resolveGeometryServiceUrl } from "../arcgis/geometry-service";
import {
  geoJsonToEsriPolygon,
  projectWgs84PolygonLocally,
  projectWgs84PolygonWithWkt,
  wkidOf,
  type EsriPolygon,
} from "../geo/esri-geometry";
import type { ParsedBoundary } from "../geo/parse-boundary";
import { LAYER_FIELDS, type District, type PlanStatus, type PlanType } from "../plan-options";

export interface PlanSubmission {
  planName: string;
  district: District;
  planType: PlanType;
  boundary: ParsedBoundary;
  documents: { file: Blob; fileName: string }[];
}

export interface PlanSubmissionResult {
  objectId: number;
  globalId: string | null;
  layerUrl: string;
  featureUrl: string;
  attributes: Record<string, string | number>;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    spatialReference: { wkid?: number; latestWkid?: number };
    ringCount: number;
    vertexCount: number;
    areaSqMeters: number;
    bboxWgs84: [number, number, number, number];
  };
  attachments: AddedAttachment[];
  warnings: string[];
}

/** Layer is misconfigured for this workflow (missing field, attachments disabled, ...). */
export class LayerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerSchemaError";
  }
}

/** The feature was created but a later step failed; carries the rollback outcome. */
export class PartialSubmissionError extends Error {
  constructor(
    message: string,
    readonly objectId: number,
    readonly rolledBack: boolean,
    readonly originalError: unknown,
  ) {
    super(message);
    this.name = "PartialSubmissionError";
  }
}

/**
 * Creates the plan feature and its attachments as the signed-in user (`tokens` wraps their OAuth
 * session), so ArcGIS editor tracking records who submitted it.
 */
export async function submitPlan(submission: PlanSubmission, tokens: TokenProvider): Promise<PlanSubmissionResult> {
  const config = getArcGisConfig();
  const layer = new FeatureLayerClient(config.featureLayerUrl, tokens);
  const metadata = await layer.getMetadata();
  const fields = resolveLayerSchema(metadata, submission.documents.length > 0);

  const status: PlanStatus = "SUBMITTED";
  const submissionDate = Date.now();
  const attributes: Record<string, string | number> = {
    [fields.planName.name]: submission.planName,
    [fields.district.name]: submission.district,
    [fields.planType.name]: submission.planType,
    [fields.status.name]: status,
    [fields.submissionDate.name]: submissionDate,
  };
  assertValueFits(fields.planName, submission.planName);
  for (const [field, value] of [
    [fields.district, submission.district],
    [fields.planType, submission.planType],
    [fields.status, status],
  ] as const) {
    assertValueFits(field, value);
    assertInDomain(field, value);
  }

  const geometry = await toLayerGeometry(submission.boundary, await layer.getSpatialReference(), config, tokens);
  const added = await layer.addFeature(geometry, attributes);

  const attachments: AddedAttachment[] = [];
  try {
    for (const doc of submission.documents) {
      attachments.push(await layer.addAttachment(added.objectId, doc.file, doc.fileName));
    }
  } catch (err) {
    let rolledBack = false;
    try {
      await layer.deleteFeature(added.objectId);
      rolledBack = true;
    } catch (rollbackErr) {
      console.error(`[plans] rollback of objectId ${added.objectId} failed`, rollbackErr);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new PartialSubmissionError(
      rolledBack
        ? `Document upload failed, so the plan feature was removed. ${reason}`
        : `Document upload failed and the plan feature (objectId ${added.objectId}) could NOT be removed automatically. ${reason}`,
      added.objectId,
      rolledBack,
      err,
    );
  }

  return {
    objectId: added.objectId,
    globalId: added.globalId,
    layerUrl: config.featureLayerUrl,
    featureUrl: `${config.featureLayerUrl}/${added.objectId}`,
    attributes,
    geometry: {
      type: submission.boundary.geometry.type,
      spatialReference: geometry.spatialReference,
      ringCount: geometry.rings.length,
      vertexCount: submission.boundary.vertexCount,
      areaSqMeters: Math.round(submission.boundary.areaSqMeters * 100) / 100,
      bboxWgs84: submission.boundary.bbox,
    },
    attachments,
    warnings: submission.boundary.warnings,
  };
}

async function toLayerGeometry(
  boundary: ParsedBoundary,
  layerSr: EsriPolygon["spatialReference"],
  config: ArcGisConfig,
  tokens: TokenProvider,
): Promise<EsriPolygon> {
  const wgs84 = geoJsonToEsriPolygon(boundary.geometry);
  const local = projectWgs84PolygonLocally(wgs84, layerSr) ?? projectWgs84PolygonWithWkt(wgs84, layerSr);
  if (local) return local;

  const serviceUrl = await resolveGeometryServiceUrl(config.portalUrl, config.geometryServiceUrl, tokens);
  const outSR = wkidOf(layerSr) !== undefined ? { wkid: wkidOf(layerSr) } : layerSr;
  return projectPolygon(serviceUrl, wgs84, outSR, tokens);
}

type ResolvedFields = Record<keyof typeof LAYER_FIELDS, LayerField>;

export function resolveLayerSchema(meta: LayerMetadata, needsAttachments: boolean): ResolvedFields {
  const problems: string[] = [];
  if (meta.geometryType !== "esriGeometryPolygon") {
    problems.push(`layer geometry type is ${meta.geometryType}, expected esriGeometryPolygon`);
  }
  const caps = meta.capabilities.toLowerCase();
  if (!caps.includes("create") && !caps.includes("editing")) {
    problems.push(`layer capabilities "${meta.capabilities}" do not allow creating features`);
  }
  if (needsAttachments && !meta.hasAttachments) problems.push("attachments are not enabled on the layer");

  const byName = new Map(meta.fields.map((f) => [f.name.toLowerCase(), f]));
  const resolved = {} as ResolvedFields;
  for (const [key, name] of Object.entries(LAYER_FIELDS) as [keyof typeof LAYER_FIELDS, string][]) {
    const field = byName.get(name.toLowerCase());
    if (!field) {
      problems.push(`missing field "${name}"`);
      continue;
    }
    resolved[key] = field;
  }
  if (resolved.submissionDate && resolved.submissionDate.type !== "esriFieldTypeDate") {
    problems.push(`field "${resolved.submissionDate.name}" must be a Date field (is ${resolved.submissionDate.type})`);
  }

  if (problems.length > 0) {
    throw new LayerSchemaError(`Target feature layer "${meta.name}" is not configured correctly: ${problems.join("; ")}.`);
  }
  return resolved;
}

function assertValueFits(field: LayerField, value: string): void {
  if (field.length && value.length > field.length) {
    throw new LayerSchemaError(`Value for "${field.name}" exceeds the field length of ${field.length}.`);
  }
}

function assertInDomain(field: LayerField, value: string): void {
  const domain = field.domain;
  if (!domain || domain.type !== "codedValue" || !("codedValues" in domain)) return;
  if (!domain.codedValues.some((cv) => String(cv.code) === value)) {
    throw new LayerSchemaError(
      `"${value}" is not a valid code in the "${field.name}" domain. Update lib/plan-options.ts or the layer domain so they match.`,
    );
  }
}
