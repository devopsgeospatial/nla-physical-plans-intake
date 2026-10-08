import "server-only";

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { MultiPolygon, Polygon } from "geojson";
import type { TokenProvider } from "../arcgis/auth";
import type { PublicConfig } from "../arcgis/config";
import { FeatureLayerClient } from "../arcgis/feature-layer";
import { esriRingsToGeoJson, geoJsonToEsriPolygon, type EsriPolygon } from "../geo/esri-geometry";

/**
 * Where approved plans are, by district. The district comes from where a plan lies (its parcels'
 * centre points against Rwanda's district boundaries), not from the `district_1` attribute, which
 * planners often leave empty. So a district appears in the app as soon as NLA approves a plan in it.
 */

export interface DistrictBoundary {
  name: string;
  geometry: Polygon | MultiPolygon;
  /** Same boundary as ArcGIS JSON (WGS84), for spatial queries. */
  esri: EsriPolygon;
  bbox: [number, number, number, number];
}

const BOUNDARY_TTL_MS = 6 * 60 * 60 * 1000;
const PLANS_TTL_MS = 5 * 60 * 1000;
/** Boundaries are generalised to ~30 m: plenty for "which district is this plan in" and map extents. */
const BOUNDARY_OFFSET_DEG = 0.0003;

let boundaries: { value: Promise<Map<string, DistrictBoundary>>; expiresAt: number } | null = null;
let planCounts: { value: Promise<Map<string, number>>; expiresAt: number } | null = null;

function anonymous(config: PublicConfig): TokenProvider {
  return { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
}

const key = (name: string) => name.trim().toLowerCase();

/** Rwanda's 30 districts, keyed by lower-case name. */
export function districtBoundaries(config: PublicConfig): Promise<Map<string, DistrictBoundary>> {
  if (boundaries && boundaries.expiresAt > Date.now()) return boundaries.value;
  const value = (async () => {
    const layer = new FeatureLayerClient(config.districtsLayerUrl, anonymous(config));
    const meta = await layer.getMetadata();
    const nameField = meta.fields.find((f) => f.name.toLowerCase() === "district")?.name ?? "district";
    const features = await layer.queryAll({ where: "1=1", outFields: nameField, returnGeometry: true, outSR: 4326, maxAllowableOffset: BOUNDARY_OFFSET_DEG });
    const out = new Map<string, DistrictBoundary>();
    for (const f of features) {
      const name = String(f.attributes[nameField] ?? "").trim();
      const rings = f.geometry?.rings;
      if (!name || !rings?.length) continue;
      const geometry = esriRingsToGeoJson(rings);
      const xs = rings.flat().map((p) => p[0]!);
      const ys = rings.flat().map((p) => p[1]!);
      out.set(key(name), {
        name,
        geometry,
        esri: { ...geoJsonToEsriPolygon(geometry), spatialReference: { wkid: 4326 } },
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    }
    return out;
  })();
  boundaries = { value, expiresAt: Date.now() + BOUNDARY_TTL_MS };
  value.catch(() => (boundaries = null));
  return value;
}

export async function districtBoundary(config: PublicConfig, name: string): Promise<DistrictBoundary | null> {
  return (await districtBoundaries(config)).get(key(name)) ?? null;
}

/** Number of approved planned parcels in each district (lower-case name → count), refreshed every 5 minutes. */
export function approvedPlansByDistrict(config: PublicConfig): Promise<Map<string, number>> {
  if (planCounts && planCounts.expiresAt > Date.now()) return planCounts.value;
  const value = (async () => {
    const plans = new FeatureLayerClient(config.planLayerUrl, anonymous(config));
    const meta = await plans.getMetadata();
    const [points, districts] = await Promise.all([
      plans.queryAll({ where: config.planFilter, outFields: meta.objectIdField, returnGeometry: false, returnCentroid: true, outSR: 4326 }),
      districtBoundaries(config),
    ]);
    const counts = new Map<string, number>();
    const list = [...districts.entries()];
    for (const { centroid } of points) {
      if (!centroid) continue;
      const [x, y] = [centroid.x, centroid.y];
      const hit = list.find(([, d]) => x >= d.bbox[0] && x <= d.bbox[2] && y >= d.bbox[1] && y <= d.bbox[3] && booleanPointInPolygon([x, y], d.geometry));
      if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
    }
    return counts;
  })();
  planCounts = { value, expiresAt: Date.now() + PLANS_TTL_MS };
  value.catch(() => (planCounts = null));
  return value;
}
