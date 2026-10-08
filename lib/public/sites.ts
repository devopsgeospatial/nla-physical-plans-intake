import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import type { PublicConfig } from "../arcgis/config";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import type { EsriPolygon } from "../geo/esri-geometry";
import { SITE_NAME_FIELD, SITE_STAGE_FIELD, siteNameFromLayer, stageOf, type PlanStatus } from "./stages";

/** A site plan the parcel lies in, with its stage (from the site's `site_stage`). */
export interface SiteSummary {
  name: string;
  stage: number | null;
  status: PlanStatus | null;
}

/**
 * The sites (site-plan boundaries) a geometry falls in. Name from `site_name`, or the layer's name when
 * the field is missing or empty; stage from `site_stage`.
 */
export async function sitesAt(config: PublicConfig, geometry: EsriPolygon): Promise<SiteSummary[]> {
  const tokens: TokenProvider = { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
  const found = await Promise.all(
    config.sitesLayerUrls.map(async (url) => {
      try {
        const layer = new FeatureLayerClient(url, tokens);
        const meta = await layer.getMetadata();
        const field = (name: string) => meta.fields.find((f) => f.name.toLowerCase() === name)?.name;
        const nameField = field(SITE_NAME_FIELD);
        const stageField = field(SITE_STAGE_FIELD);
        const sites = await layer.queryAll({
          where: "1=1",
          geometry: { ...geometry, spatialReference: { wkid: 4326 } },
          geometryType: "esriGeometryPolygon",
          inSR: 4326,
          spatialRel: "esriSpatialRelIntersects",
          outFields: [nameField, stageField].filter(Boolean).join(",") || meta.objectIdField,
          returnGeometry: false,
        });
        return sites.map((s) => {
          const stage = stageField ? stageOf(s.attributes[stageField]) : null;
          const named = nameField ? String(s.attributes[nameField] ?? "").trim() : "";
          return { name: named || siteNameFromLayer(meta.name), stage: stage?.n ?? null, status: stage?.status ?? null };
        });
      } catch (err) {
        console.warn(`[sites] ${url} could not be read`, err);
        return [];
      }
    }),
  );
  return found.flat();
}
