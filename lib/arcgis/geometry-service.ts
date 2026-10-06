/**
 * Server-side projection via an ArcGIS Geometry Service. Only used when the target layer is in a
 * spatial reference other than WGS84 / Web Mercator (e.g. a State Plane or UTM layer).
 */
import type { EsriPolygon, EsriSpatialReference } from "../geo/esri-geometry";
import { withToken, type TokenProvider } from "./auth";
import { ArcGisRequestError, arcgisRequest } from "./rest";

interface PortalSelf {
  helperServices?: { geometry?: { url?: string } };
}

interface ProjectResponse {
  geometries?: { rings?: [number, number][][] }[];
}

export async function resolveGeometryServiceUrl(
  portalUrl: string,
  configured: string | undefined,
  tokens: TokenProvider,
): Promise<string> {
  if (configured) return configured;
  const self = await withToken(tokens, (token) =>
    arcgisRequest<PortalSelf>(`${portalUrl}/sharing/rest/portals/self`, {}, { referer: tokens.referer, token, method: "GET" }),
  );
  const url = self.helperServices?.geometry?.url;
  if (!url) {
    throw new ArcGisRequestError(
      "The target layer is not in WGS84/Web Mercator and no geometry service is available. Set ARCGIS_GEOMETRY_SERVICE_URL or configure the portal's geometry utility service.",
      `${portalUrl}/sharing/rest/portals/self`,
    );
  }
  return url.replace(/\/+$/, "");
}

export async function projectPolygon(
  geometryServiceUrl: string,
  polygon: EsriPolygon,
  outSR: EsriSpatialReference,
  tokens: TokenProvider,
): Promise<EsriPolygon> {
  const url = `${geometryServiceUrl}/project`;
  const response = await withToken(tokens, (token) =>
    arcgisRequest<ProjectResponse>(
      url,
      {
        inSR: polygon.spatialReference,
        outSR,
        geometries: { geometryType: "esriGeometryPolygon", geometries: [{ rings: polygon.rings }] },
      },
      { referer: tokens.referer, token },
    ),
  );
  const rings = response.geometries?.[0]?.rings;
  if (!rings || rings.length === 0) throw new ArcGisRequestError("Geometry service returned an empty projection.", url);
  return { rings, spatialReference: outSR };
}

interface SimplifyResponse {
  geometries?: { rings?: [number, number][][] }[];
}

/**
 * Repairs polygons with the ArcGIS geometry service "simplify" operation (the engine behind ArcGIS
 * Repair Geometry): resolves self-intersections, fixes ring orientation and removes duplicate
 * vertices. Results are in input order; a polygon that collapses to nothing comes back with no rings.
 */
export async function simplifyPolygons(
  geometryServiceUrl: string,
  polygons: EsriPolygon[],
  sr: EsriSpatialReference,
  tokens: TokenProvider,
): Promise<EsriPolygon[]> {
  const url = `${geometryServiceUrl}/simplify`;
  const results: EsriPolygon[] = [];
  const BATCH = 200;
  for (let start = 0; start < polygons.length; start += BATCH) {
    const batch = polygons.slice(start, start + BATCH);
    const response = await withToken(tokens, (token) =>
      arcgisRequest<SimplifyResponse>(
        url,
        { sr, geometries: { geometryType: "esriGeometryPolygon", geometries: batch.map((p) => ({ rings: p.rings })) } },
        { referer: tokens.referer, token, timeoutMs: 120_000 },
      ),
    );
    const out = response.geometries ?? [];
    if (out.length !== batch.length) throw new ArcGisRequestError(`simplify returned ${out.length} geometries for ${batch.length}.`, url);
    out.forEach((g) => results.push({ rings: g.rings ?? [], spatialReference: sr }));
  }
  return results;
}
