import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import { fieldName } from "../plans/attribute-mapping";
import type { District } from "./districts";
import type { DistrictBoundary } from "./geo-index";
import type { ResolvedPublicConfig } from "./resolve";
import { SITE_NAME_FIELD, SITE_STAGE_FIELD, siteNameFromLayer, stageOf, type PlanStatus } from "./stages";

/**
 * Everything the public map's Insights and Explore need about one district, computed on the server
 * (close to ArcGIS) and cached, so a visitor's browser makes one request instead of a chain of
 * ArcGIS round trips.
 */

export interface SiteData {
  key: string;
  name: string;
  /** 1–5 from `site_stage`, or null when not recorded yet. */
  stage: number | null;
  status: PlanStatus | null;
  /** The site layer and the site's feature in it (for map filters). */
  layerUrl: string;
  objectId: number;
  /** Approved parcels inside the site (its subdivided parcels). */
  parcelIds: number[];
  parcels: number;
  hectares: number;
  /** Boundary in WGS84, simplified to ~1 m. */
  rings: number[][][];
  /** [xmin, ymin, xmax, ymax] in WGS84. */
  extent: [number, number, number, number];
}

export interface DistrictSummary {
  /** Approved planned parcels lying in the district. */
  totals: { parcels: number; hectares: number };
  /** Extent of those parcels in WGS84, or null when there are none. */
  planExtent: [number, number, number, number] | null;
  sites: SiteData[];
}

const TTL_MS = 5 * 60 * 1000;
/** ~1 m in degrees: plenty for drawing and framing a site, and keeps the response small. */
const SITE_OFFSET_DEG = 0.00001;
const cache = new Map<string, { value: Promise<DistrictSummary>; expiresAt: number }>();

export function districtSummary(config: ResolvedPublicConfig, district: District, boundary: DistrictBoundary): Promise<DistrictSummary> {
  const key = `${config.planLayerUrl}|${district.slug}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = compute(config, boundary);
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  value.catch(() => cache.delete(key));
  return value;
}

async function compute(config: ResolvedPublicConfig, boundary: DistrictBoundary): Promise<DistrictSummary> {
  const tokens: TokenProvider = { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
  const plans = new FeatureLayerClient(config.planLayerUrl, tokens);
  const meta = await plans.getMetadata();
  const inDistrict = { where: config.planFilter, geometry: boundary.esri, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects" };
  const stats = (where: string, geometry: object) =>
    plans.queryAll({
      where,
      geometry,
      geometryType: "esriGeometryPolygon",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
      outStatistics: [
        { statisticType: "count", onStatisticField: meta.objectIdField, outStatisticFieldName: "n" },
        { statisticType: "sum", onStatisticField: config.fields.area, outStatisticFieldName: "a" },
      ],
    });

  const [totalsRow, extent, sites] = await Promise.all([
    stats(config.planFilter, boundary.esri),
    plans.queryExtent({ ...inDistrict, outSR: 4326 }),
    Promise.all(config.sitesLayerUrls.map((url) => sitesOf(url, tokens, boundary, plans, config))).then((all) => all.flat()),
  ]);
  const t = totalsRow[0]?.attributes ?? {};
  return {
    totals: { parcels: Number(t.n ?? 0), hectares: Number(t.a ?? 0) / 10_000 },
    planExtent: extent,
    sites: sites.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The sites of one site layer in the district, each with its approved parcels. */
async function sitesOf(url: string, tokens: TokenProvider, boundary: DistrictBoundary, plans: FeatureLayerClient, config: ResolvedPublicConfig): Promise<SiteData[]> {
  try {
    const layer = new FeatureLayerClient(url, tokens);
    const meta = await layer.getMetadata();
    const nameField = fieldName(meta.fields, SITE_NAME_FIELD);
    const stageField = fieldName(meta.fields, SITE_STAGE_FIELD);
    const found = await layer.queryAll({
      where: "1=1",
      geometry: boundary.esri,
      geometryType: "esriGeometryPolygon",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
      outFields: [meta.objectIdField, nameField, stageField].filter(Boolean).join(","),
      returnGeometry: true,
      outSR: 4326,
      maxAllowableOffset: SITE_OFFSET_DEG,
    });
    const layerName = siteNameFromLayer(meta.name);
    const unnamed = found.filter((f) => !String((nameField && f.attributes[nameField]) ?? "").trim()).length;
    let n = 0;
    const sites = await Promise.all(
      found.map(async (f) => {
        const rings = f.geometry?.rings ?? [];
        const geometry = { rings, spatialReference: { wkid: 4326 } };
        const where = { where: config.planFilter, geometry, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects" };
        const [ids, area] = await Promise.all([
          plans.queryObjectIds(where),
          plans.queryAll({ ...where, outStatistics: [{ statisticType: "sum", onStatisticField: config.fields.area, outStatisticFieldName: "a" }] }),
        ]);
        return { f, rings, ids, hectares: Number(area[0]?.attributes.a ?? 0) / 10_000 };
      }),
    );
    return sites.map(({ f, rings, ids, hectares }) => {
      const named = nameField ? String(f.attributes[nameField] ?? "").trim() : "";
      const stage = stageField ? stageOf(f.attributes[stageField]) : null;
      const xs = rings.flat().map((p) => p[0]!);
      const ys = rings.flat().map((p) => p[1]!);
      const objectId = Number(f.attributes[meta.objectIdField]);
      return {
        key: `${url}#${objectId}`,
        name: named || (unnamed > 1 ? `${layerName} ${++n}` : layerName),
        stage: stage?.n ?? null,
        status: stage?.status ?? null,
        layerUrl: url,
        objectId,
        parcelIds: ids,
        parcels: ids.length,
        hectares,
        rings,
        extent: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
      };
    });
  } catch (err) {
    console.warn(`[summary] site layer ${url} could not be read`, err);
    return [];
  }
}
