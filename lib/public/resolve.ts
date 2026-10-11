import "server-only";

import type { PublicConfig } from "../arcgis/config";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import { fieldName } from "../plans/attribute-mapping";

/** Logical plan fields the public app reads, as named on the layer (full or shapefile-truncated). */
export interface PlanFields {
  approvalDate: string;
  zoning: string;
  zoneCode: string;
  landUse: string;
  cell: string;
  upi: string;
  area: string;
}

export interface ResolvedPublicConfig extends PublicConfig {
  fields: PlanFields;
}

/**
 * The public configuration with the plan filter and field names matched to the plans layer, so the
 * app works with either layer naming. Layer metadata is cached for 5 minutes by FeatureLayerClient.
 */
export async function resolvePublicConfig(config: PublicConfig): Promise<ResolvedPublicConfig> {
  const layer = new FeatureLayerClient(config.planLayerUrl, { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} });
  const meta = await layer.getMetadata();
  const name = (n: string) => fieldName(meta.fields, n) ?? n;
  const fields: PlanFields = {
    approvalDate: name("approval_date"),
    zoning: name("zoning"),
    zoneCode: name("zone_code"),
    landUse: name("gen_lu"),
    cell: name("cell_1"),
    upi: name("parcel_upi"),
    area: name("area_sqm"),
  };
  return { ...config, fields, planFilter: config.planFilter.replace(/\{(\w+)\}/g, (_, n: string) => name(n)) };
}
