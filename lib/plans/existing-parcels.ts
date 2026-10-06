import "server-only";

import type { FeatureLayerClient, LayerMetadata } from "../arcgis/feature-layer";
import { fingerprintEsriRings, normalizeUpi, UPI_FIELD, type ExistingParcel, type Fingerprint } from "./duplicates";

const UPI_CHUNK = 100;
/** Envelope margin around the upload's centroids (~110 m): geometry matches need centroids within 1 m. */
const BBOX_MARGIN_DEG = 0.001;

/**
 * Reads the parcels already in the layer that could duplicate the upload: every parcel near the
 * uploaded polygons (for geometry matches) plus every parcel carrying one of the uploaded UPIs.
 */
export async function loadExistingParcels(layer: FeatureLayerClient, meta: LayerMetadata, uploads: Fingerprint[]): Promise<ExistingParcel[]> {
  if (uploads.length === 0) return [];
  const upiField = meta.fields.find((f) => f.name.toLowerCase() === UPI_FIELD)?.name;
  const outFields = [meta.objectIdField, upiField].filter(Boolean).join(",");
  const common = { outFields, returnGeometry: true, outSR: 4326 };

  const xs = uploads.map((u) => u.cx);
  const ys = uploads.map((u) => u.cy);
  const envelope = {
    xmin: Math.min(...xs) - BBOX_MARGIN_DEG,
    ymin: Math.min(...ys) - BBOX_MARGIN_DEG,
    xmax: Math.max(...xs) + BBOX_MARGIN_DEG,
    ymax: Math.max(...ys) + BBOX_MARGIN_DEG,
    spatialReference: { wkid: 4326 },
  };
  const results = await layer.queryAll({
    ...common,
    where: "1=1",
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
  });

  if (upiField) {
    const seen = new Set(results.map((f) => normalizeUpi(f.attributes[upiField])).filter(Boolean));
    const wanted = [...new Set(uploads.map((u) => u.upi).filter((u): u is string => !!u && !seen.has(u)))];
    for (let i = 0; i < wanted.length; i += UPI_CHUNK) {
      const list = wanted
        .slice(i, i + UPI_CHUNK)
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(",");
      results.push(...(await layer.queryAll({ ...common, where: `UPPER(${upiField}) IN (${list})` })));
    }
  }

  const byId = new Map<number, ExistingParcel>();
  for (const f of results) {
    const objectId = Number(f.attributes[meta.objectIdField]);
    const rings = f.geometry?.rings;
    if (!Number.isFinite(objectId) || !rings?.length || byId.has(objectId)) continue;
    byId.set(objectId, { objectId, ...fingerprintEsriRings(rings, upiField ? f.attributes[upiField] : null) });
  }
  return [...byId.values()];
}
