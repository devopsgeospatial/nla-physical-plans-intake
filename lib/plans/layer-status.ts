import "server-only";

import type { TokenProvider } from "../arcgis/auth";
import { getArcGisConfig } from "../arcgis/config";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import { ArcGisRequestError } from "../arcgis/rest";
import { LayerSchemaError, resolveLayerSchema } from "./submit-plan";

export type LayerStatus =
  | { state: "ready"; layerName: string }
  | { state: "missing"; message: string; serviceName: string }
  | { state: "no_access"; message: string }
  | { state: "misconfigured"; message: string };

/** Checks, as the signed-in user, that the configured intake layer exists and has the expected schema. */
export async function checkLayerStatus(tokens: TokenProvider): Promise<LayerStatus> {
  const config = getArcGisConfig();
  try {
    const meta = await new FeatureLayerClient(config.featureLayerUrl, tokens).getMetadata();
    resolveLayerSchema(meta, true);
    return { state: "ready", layerName: meta.name };
  } catch (err) {
    if (err instanceof LayerSchemaError) return { state: "misconfigured", message: err.message };
    if (err instanceof ArcGisRequestError && err.code === 400 && /invalid url/i.test(err.message)) {
      return {
        state: "missing",
        serviceName: serviceNameFromUrl(config.featureLayerUrl),
        message: `The intake layer does not exist yet: ${config.featureLayerUrl}`,
      };
    }
    if (err instanceof ArcGisRequestError && (err.code === 403 || err.code === 499)) {
      return { state: "no_access", message: "The intake layer exists but is not shared with your account." };
    }
    throw err;
  }
}

export function serviceNameFromUrl(layerUrl: string): string {
  return layerUrl.match(/\/services\/(?:Hosted\/)?([^/]+)\/FeatureServer/i)?.[1] ?? "Physical_Plan_Submissions";
}
