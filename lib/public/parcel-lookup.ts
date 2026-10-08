import "server-only";

import turfArea from "@turf/area";
import { feature, featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type { MultiPolygon, Polygon } from "geojson";
import type { TokenProvider } from "../arcgis/auth";
import type { PublicConfig } from "../arcgis/config";
import { FeatureLayerClient, type QueryFeature } from "../arcgis/feature-layer";
import { esriRingsToGeoJson, geoJsonToEsriPolygon } from "../geo/esri-geometry";
import type { District } from "./districts";
import { sitesAt, type SiteSummary } from "./sites";

/**
 * What a citizen learns about one parcel: where it is, how much of it the approved physical plan covers
 * zone by zone, and the site plan (with its stage) it belongs to. Plans come from Physical_Plans
 * filtered to what the public may see. Districts without a connected cadastre are searched in the
 * approved planned parcels themselves (their `parcel_upi`).
 */

export type Coverage = "within" | "partly" | "outside";

export interface PlanZone {
  zoning: string | null;
  zoneCode: string | null;
  landUse: string | null;
  /** Share of the parcel's area in this zone (0–100). */
  sharePct: number;
  approvedAt: number | null;
}

export interface ParcelReport {
  /**
   * Only when the citizen searched by UPI (they already have it). A tap on the map never reveals the
   * UPI: it identifies someone's land, and you should only learn it from the owner's own papers.
   */
  upi: string | null;
  village: string | null;
  cell: string | null;
  sector: string | null;
  district: string | null;
  areaSqm: number;
  geometry: Polygon | MultiPolygon;
  coverage: Coverage;
  /** Share of the parcel covered by the approved plan (0–100). */
  coveredPct: number;
  zones: PlanZone[];
  /** The site plan(s) the parcel lies in; the stage belongs to the site. */
  sites: SiteSummary[];
}

/** Below this share a zone only touches the parcel's edge (digitising tolerance), so it is ignored. */
const MIN_ZONE_PCT = 0.5;
const WITHIN_PCT = 95;

export async function lookupByUpi(config: PublicConfig, district: District, upi: string): Promise<ParcelReport | null> {
  const value = `'${upi.replace(/'/g, "''")}'`;
  const found = district.parcelsLayerUrl
    ? await cadastre(config, district).queryAll({ where: `${district.upiField ?? "upi"} = ${value}`, outFields: "*", returnGeometry: true, outSR: 4326 })
    : await plansLayer(config).queryAll({ where: `(${config.planFilter}) AND UPPER(parcel_upi) = ${value.toUpperCase()}`, outFields: "*", returnGeometry: true, outSR: 4326 });
  return found[0] ? report(config, district, found[0], true) : null;
}

/** The parcel under a point on the map (WGS84), without its UPI. */
export async function lookupAtPoint(config: PublicConfig, district: District, lon: number, lat: number): Promise<ParcelReport | null> {
  const layer = district.parcelsLayerUrl ? cadastre(config, district) : plansLayer(config);
  const found = await layer.queryAll({
    where: district.parcelsLayerUrl ? "1=1" : config.planFilter,
    geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } },
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: true,
    outSR: 4326,
  });
  return found[0] ? report(config, district, found[0], false) : null;
}

function anonymous(config: PublicConfig): TokenProvider {
  return { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
}

function plansLayer(config: PublicConfig): FeatureLayerClient {
  return new FeatureLayerClient(config.planLayerUrl, anonymous(config));
}

function cadastre(config: PublicConfig, district: District): FeatureLayerClient {
  if (!district.parcelsLayerUrl) throw new Error(`${district.name} has no cadastre configured.`);
  return new FeatureLayerClient(district.parcelsLayerUrl, anonymous(config));
}

async function report(config: PublicConfig, district: District, parcel: QueryFeature, revealUpi: boolean): Promise<ParcelReport | null> {
  const rings = parcel.geometry?.rings;
  if (!rings?.length) return null;
  const geometry = esriRingsToGeoJson(rings);
  const parcelArea = turfArea(geometry);
  const a = attributesLowercase(parcel.attributes);

  const plans = new FeatureLayerClient(config.planLayerUrl, anonymous(config));
  const zones = await plans.queryAll({
    where: config.planFilter,
    geometry: { ...geoJsonToEsriPolygon(geometry), spatialReference: { wkid: 4326 } },
    geometryType: "esriGeometryPolygon",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    outFields: "zoning,zone_code,gen_lu,approval_date",
    returnGeometry: true,
    outSR: 4326,
  });

  // Zones of the same kind (many R2 polygons, say) are reported once, with their shares added up.
  const byKind = new Map<string, PlanZone>();
  for (const zone of zones) {
    if (!zone.geometry?.rings?.length) continue;
    const overlap = intersect(featureCollection([feature(geometry), feature(esriRingsToGeoJson(zone.geometry.rings))]));
    const share = overlap && parcelArea > 0 ? (turfArea(overlap) / parcelArea) * 100 : 0;
    if (share <= 0) continue;
    const z = attributesLowercase(zone.attributes);
    const zoning = text(z.zoning);
    const zoneCode = text(z.zone_code);
    const key = `${zoneCode}|${zoning}`;
    const approvedAt = typeof z.approval_date === "number" ? z.approval_date : null;
    const prev = byKind.get(key);
    byKind.set(key, {
      zoning,
      zoneCode,
      landUse: text(z.gen_lu),
      sharePct: (prev?.sharePct ?? 0) + share,
      approvedAt: Math.max(prev?.approvedAt ?? 0, approvedAt ?? 0) || null,
    });
  }
  const kept = [...byKind.values()].filter((z) => z.sharePct >= MIN_ZONE_PCT).sort((x, y) => y.sharePct - x.sharePct);
  const coveredPct = Math.min(100, kept.reduce((sum, z) => sum + z.sharePct, 0));
  const sites = await sitesAt(config, geoJsonToEsriPolygon(geometry)).catch(() => []);

  return {
    upi: revealUpi ? (text(a[(district.upiField ?? "upi").toLowerCase()]) ?? text(a.parcel_upi)) : null,
    village: text(a.village),
    cell: text(a.cell) ?? text(a.cell_1),
    sector: text(a.sector) ?? text(a.sector_1),
    district: text(a.district) ?? district.name,
    areaSqm: typeof a.size === "number" ? a.size : typeof a.area_sqm === "number" ? a.area_sqm : parcelArea,
    geometry,
    coverage: coveredPct >= WITHIN_PCT ? "within" : coveredPct >= MIN_ZONE_PCT ? "partly" : "outside",
    coveredPct: Math.round(coveredPct * 10) / 10,
    zones: kept.map((z) => ({ ...z, sharePct: Math.round(Math.min(100, z.sharePct) * 10) / 10 })),
    sites,
  };
}

function attributesLowercase(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k.toLowerCase(), v]));
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}
