import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import { getArcGisConfig, type ArcGisConfig } from "../arcgis/config";
import { FeatureLayerClient, FeatureRejectedError, type LayerMetadata } from "../arcgis/feature-layer";
import { projectPolygon, resolveGeometryServiceUrl, simplifyPolygons } from "../arcgis/geometry-service";
import {
  geoJsonToEsriPolygon,
  isWebMercator,
  isWgs84,
  projectWgs84PolygonLocally,
  projectWgs84PolygonWithWkt,
  wkidOf,
  type EsriPolygon,
  type EsriSpatialReference,
} from "../geo/esri-geometry";
import type { ParsedUpload, UploadFeature } from "../geo/parse-upload";
import { AREA_FIELD, AUTO_FIELDS, coerceValue, mapFields, writableFields, type AttributeValue, type FieldMapping } from "./attribute-mapping";
import { findDuplicates, uploadFingerprints, type DuplicateMatch } from "./duplicates";
import { loadExistingParcels } from "./existing-parcels";

export interface AppendRequest {
  upload: ParsedUpload;
  documents: { file: Blob; fileName: string }[];
  username: string;
}

export interface AppendResult {
  layerUrl: string;
  layerName: string;
  objectIds: number[];
  /** The PDFs are attached to one record only: the first one appended (first non-duplicate in file order). */
  attachments: { objectId: number; count: number } | null;
  /** Polygons that were self-intersecting and repaired with ArcGIS Simplify before appending. */
  repairedCount: number;
  /** Polygons skipped because they are already in the layer or repeat an earlier polygon in the file. */
  duplicates: DuplicateMatch[];
  matchedFields: { file: string; layer: string }[];
  ignoredFields: string[];
  warnings: string[];
}

/** The target layer cannot accept this append (geometry type, capabilities, attachments off, ...). */
export class LayerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerSchemaError";
  }
}

/** Every polygon in the upload is already in the layer (or repeated in the file). */
export class NothingToAppendError extends Error {
  constructor(
    message: string,
    readonly duplicates: DuplicateMatch[],
  ) {
    super(message);
    this.name = "NothingToAppendError";
  }
}

/** A value in the file cannot be stored in the layer field it maps to. */
export class AttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

/** Features were created but a later step failed; carries the rollback outcome. */
export class PartialSubmissionError extends Error {
  constructor(
    message: string,
    readonly objectIds: number[],
    readonly rolledBack: boolean,
  ) {
    super(message);
    this.name = "PartialSubmissionError";
  }
}

const BATCH_SIZE = 200;
const ATTACHMENT_CONCURRENCY = 4;

/**
 * Appends every polygon in the upload as its own feature, as the signed-in user, carrying the
 * file's attributes. Attaches the PDFs to the first new feature only. All-or-nothing: on any failure the
 * features already created are deleted again.
 */
export async function appendFeatures(request: AppendRequest, tokens: TokenProvider): Promise<AppendResult> {
  const config = getArcGisConfig();
  const layer = new FeatureLayerClient(config.featureLayerUrl, tokens);
  const meta = await layer.getMetadata();
  assertLayerAccepts(meta, request.documents.length > 0);

  const mapping = mapFields(request.upload.fieldNames, meta.fields);
  const writable = writableFields(meta.fields);
  const has = (name: string) => writable.some((f) => f.name.toLowerCase() === name);
  const areaField = has(AREA_FIELD) && !mapping.matched.some((m) => m.layerField.name.toLowerCase() === AREA_FIELD) ? AREA_FIELD : null;

  const layerSr = await layer.getSpatialReference();

  // Duplicates are never appended: skip polygons already in the layer or repeated in the file.
  const fingerprints = uploadFingerprints(request.upload.features, request.upload.fieldNames, meta.fields);
  const duplicates = findDuplicates(fingerprints, await loadExistingParcels(layer, meta, fingerprints));
  const skip = new Set(duplicates.map((d) => d.index));
  if (skip.size === request.upload.features.length) {
    throw new NothingToAppendError(
      `Nothing to append: all ${skip.size} polygon${skip.size === 1 ? " is" : "s are"} already in ${meta.name}.`,
      duplicates,
    );
  }
  // Keep original indexes so messages ("Feature 2020 …") refer to the file's numbering.
  const kept = request.upload.features.map((feature, index) => ({ feature, index })).filter(({ index }) => !skip.has(index));
  const features = kept.map((k) => k.feature);
  // Validate attributes first: a bad value should fail fast, before any geometry service calls.
  const attributeSets = kept.map(({ feature, index }) => buildAttributes(feature, index, mapping));

  const geometries: EsriPolygon[] = [];
  for (const feature of features) geometries.push(await toLayerGeometry(feature, layerSr, config, tokens));

  const toRepair = features.flatMap((f, i) => (f.selfIntersection ? [i] : []));
  if (toRepair.length > 0) {
    const serviceUrl = await resolveGeometryServiceUrl(config.portalUrl, config.geometryServiceUrl, tokens);
    const repaired = await simplifyPolygons(serviceUrl, toRepair.map((i) => geometries[i]!), layerSr, tokens);
    toRepair.forEach((featureIndex, k) => {
      if (repaired[k]!.rings.length === 0) {
        throw new AttributeError(`Feature ${kept[featureIndex]!.index + 1} has no area left after repairing its self-intersections. Fix it in the source data.`);
      }
      geometries[featureIndex] = repaired[k]!;
    });
  }

  const now = Date.now();
  const adds: { geometry: EsriPolygon; attributes: Record<string, AttributeValue> }[] = [];
  for (const [index, feature] of features.entries()) {
    const geometry = geometries[index]!;
    const attributes = attributeSets[index]!;
    if (areaField) attributes[areaField] = round2(storedArea(feature, geometry, layerSr));
    if (has(AUTO_FIELDS.createdUser)) attributes[AUTO_FIELDS.createdUser] = request.username;
    if (has(AUTO_FIELDS.createdDate)) attributes[AUTO_FIELDS.createdDate] = now;
    adds.push({ geometry, attributes });
  }

  const objectIds: number[] = [];
  try {
    for (let start = 0; start < adds.length; start += BATCH_SIZE) {
      try {
        const added = await layer.addFeatures(adds.slice(start, start + BATCH_SIZE));
        objectIds.push(...added.map((a) => a.objectId));
      } catch (err) {
        if (err instanceof FeatureRejectedError) {
          const fileIndex = kept[start + err.featureIndex]!.index;
          throw new FeatureRejectedError(fileIndex, `Feature ${fileIndex + 1}: ${err.message}`, err.url, err.code);
        }
        throw err;
      }
    }

    // PDFs go on the first appended record only; the other records get no attachments.
    const firstObjectId = objectIds[0]!;
    const jobs = request.documents.map((doc) => () => layer.addAttachment(firstObjectId, doc.file, doc.fileName));
    await runWithConcurrency(jobs, ATTACHMENT_CONCURRENCY);
  } catch (err) {
    if (objectIds.length === 0) throw err;
    let rolledBack = false;
    try {
      await layer.deleteFeatures(objectIds);
      rolledBack = true;
    } catch (rollbackErr) {
      console.error(`[append] rollback of ${objectIds.length} features failed`, rollbackErr);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new PartialSubmissionError(
      rolledBack
        ? `Nothing was appended: ${reason}`
        : `The upload failed part-way and ${objectIds.length} feature(s) could NOT be removed automatically (object IDs ${objectIds.join(", ")}). ${reason}`,
      objectIds,
      rolledBack,
    );
  }

  return {
    layerUrl: config.featureLayerUrl,
    layerName: meta.name,
    objectIds,
    attachments: request.documents.length > 0 ? { objectId: objectIds[0]!, count: request.documents.length } : null,
    repairedCount: toRepair.length,
    duplicates,
    matchedFields: mapping.matched.map((m) => ({ file: m.fileField, layer: m.layerField.name })),
    ignoredFields: mapping.ignored,
    warnings: request.upload.warnings,
  };
}

function assertLayerAccepts(meta: LayerMetadata, needsAttachments: boolean): void {
  if (meta.geometryType !== "esriGeometryPolygon") {
    throw new LayerSchemaError(`"${meta.name}" is a ${meta.geometryType} layer; only polygon layers are supported.`);
  }
  const caps = meta.capabilities.toLowerCase();
  if (!caps.includes("create") && !caps.includes("editing")) {
    throw new LayerSchemaError(`"${meta.name}" does not allow adding features (capabilities: ${meta.capabilities}).`);
  }
  if (needsAttachments && !meta.hasAttachments) {
    throw new LayerSchemaError(`Attachments are turned off on "${meta.name}". Ask the layer owner to enable them, or submit without PDFs.`);
  }
}

function buildAttributes(feature: UploadFeature, index: number, mapping: FieldMapping): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const { fileField, layerField } of mapping.matched) {
    try {
      attributes[layerField.name] = coerceValue(feature.properties[fileField], layerField);
    } catch (err) {
      throw new AttributeError(`Feature ${index + 1}, field "${fileField}" → ${layerField.name}: ${(err as Error).message}.`);
    }
  }
  return attributes;
}

async function toLayerGeometry(
  feature: UploadFeature,
  layerSr: EsriSpatialReference,
  config: ArcGisConfig,
  tokens: TokenProvider,
): Promise<EsriPolygon> {
  const wgs84 = geoJsonToEsriPolygon(feature.geometry);
  const local = projectWgs84PolygonLocally(wgs84, layerSr) ?? projectWgs84PolygonWithWkt(wgs84, layerSr);
  if (local) return local;
  const serviceUrl = await resolveGeometryServiceUrl(config.portalUrl, config.geometryServiceUrl, tokens);
  const outSR = wkidOf(layerSr) !== undefined ? { wkid: wkidOf(layerSr) } : layerSr;
  return projectPolygon(serviceUrl, wgs84, outSR, tokens);
}

/**
 * Area to store in area_sqm: planar area in the layer's projected grid (matches ArcGIS Shape__Area),
 * or geodesic area when the layer is geographic / Web Mercator (where planar metres are meaningless).
 */
function storedArea(feature: UploadFeature, geometry: EsriPolygon, layerSr: EsriSpatialReference): number {
  if (isWgs84(layerSr) || isWebMercator(layerSr)) return feature.areaSqMeters;
  // Esri rings: exterior clockwise (negative shoelace), holes counter-clockwise (positive).
  return Math.abs(geometry.rings.reduce((sum, ring) => sum + signedArea(ring), 0));
}

function signedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return sum / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function runWithConcurrency(jobs: (() => Promise<unknown>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}
