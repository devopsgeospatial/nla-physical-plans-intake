import "server-only";

import shpwrite from "@mapbox/shp-write";
import type { TokenProvider } from "../arcgis/auth";
import { FeatureLayerClient, type QueryFeature } from "../arcgis/feature-layer";
import { esriRingsToGeoJson } from "../geo/esri-geometry";
import type { District } from "./districts";
import type { DistrictBoundary } from "./geo-index";
import type { ResolvedPublicConfig } from "./resolve";
import { PRIVATE_FIELDS, selectSites, type SiteSelection } from "./selection";
import { STAGES } from "./stages";
import { districtSummary, type SiteData } from "./summary";

/**
 * Downloads of the public map, built on the server: the approved plans of a district (or of the sites
 * chosen in Explore) as CSV, GeoJSON or Shapefile, and the list of sites as CSV. Built here rather than
 * in the browser so they also work inside an Experience Builder page, whose frame blocks downloads.
 */

export type ExportFormat = "csv" | "geojson" | "shp" | "sites";
export const EXPORT_FORMATS: ExportFormat[] = ["csv", "geojson", "shp", "sites"];

export interface ExportFile {
  body: Uint8Array | string;
  contentType: string;
  filename: string;
}

/** 1 cm in degrees is plenty, and halves the size of the boundaries. */
const GEOMETRY_PRECISION = 7;
const NOT_EXPORTED_TYPES = new Set(["esriFieldTypeGeometry", "esriFieldTypeBlob", "esriFieldTypeRaster", "esriFieldTypeXML", "esriFieldTypeGlobalID"]);

export async function buildExport(
  config: ResolvedPublicConfig,
  district: District,
  boundary: DistrictBoundary,
  selection: SiteSelection,
  format: ExportFormat,
): Promise<ExportFile> {
  const summary = await districtSummary(config, district, boundary);
  const chosen = selectSites(summary.sites, selection);
  const label = fileLabel(district, selection, chosen);
  const stamp = new Date().toISOString().slice(0, 10);
  const stageName = (s: SiteData | undefined) => STAGES.find((x) => x.n === s?.stage)?.name ?? "";

  if (format === "sites") {
    const lines = ["Site,Stage,Status,Planned parcels,Area (ha)"].concat(
      (chosen ?? summary.sites).map((s) => [csv(s.name), csv(stageName(s) || "Not recorded"), s.status ?? "", s.parcels, s.hectares.toFixed(2)].join(",")),
    );
    return { body: `﻿${lines.join("\r\n")}`, contentType: "text/csv; charset=utf-8", filename: `physical-plans_sites_${label}_${stamp}.csv` };
  }

  const tokens: TokenProvider = { referer: config.appUrl, getToken: async () => config.apiKey ?? "", invalidate() {} };
  const layer = new FeatureLayerClient(config.planLayerUrl, tokens);
  const meta = await layer.getMetadata();
  const fields = meta.fields.filter((f) => !NOT_EXPORTED_TYPES.has(f.type) && !PRIVATE_FIELDS.test(f.name));
  const withGeometry = format !== "csv";
  const common = { outFields: fields.map((f) => f.name).join(","), returnGeometry: withGeometry, outSR: 4326, geometryPrecision: GEOMETRY_PRECISION };

  let records: QueryFeature[];
  if (chosen) {
    const ids = [...new Set(chosen.flatMap((s) => s.parcelIds))];
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
    records = (await Promise.all(chunks.map((chunk) => layer.queryAll({ ...common, where: config.planFilter, objectIds: chunk.join(",") })))).flat();
  } else {
    records = await layer.queryAll({
      ...common,
      where: config.planFilter,
      geometry: boundary.esri,
      geometryType: "esriGeometryPolygon",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
    });
  }

  const siteOf = new Map<number, SiteData>();
  for (const s of summary.sites) for (const id of s.parcelIds) siteOf.set(id, s);
  const value = (type: string, v: unknown) => (v === null || v === undefined ? "" : type === "esriFieldTypeDate" ? new Date(v as number).toISOString().slice(0, 10) : String(v));
  const row = (r: QueryFeature) => {
    const site = siteOf.get(Number(r.attributes[meta.objectIdField]));
    const props: Record<string, string> = Object.fromEntries(fields.map((f) => [f.name, value(f.type, r.attributes[f.name])]));
    props.site_name = site?.name ?? "";
    props.site_stage = stageName(site);
    return props;
  };

  if (format === "csv") {
    const head = fields.map((f) => csv(f.alias || f.name)).concat("Site", "Site stage").join(",");
    const body = records.map((r) => Object.values(row(r)).map(csv).join(","));
    return { body: `﻿${[head, ...body].join("\r\n")}`, contentType: "text/csv; charset=utf-8", filename: `physical-plans_${label}_${stamp}.csv` };
  }

  const collection = {
    type: "FeatureCollection" as const,
    features: records
      .filter((r) => r.geometry?.rings?.length)
      .map((r) => ({ type: "Feature" as const, properties: row(r), geometry: esriRingsToGeoJson(r.geometry!.rings!) })),
  };
  if (format === "geojson") {
    return { body: JSON.stringify(collection), contentType: "application/geo+json", filename: `physical-plans_${label}_${stamp}.geojson` };
  }

  // Shapefile (zipped .shp, .shx, .dbf and .prj in WGS 84): opens in ArcGIS Pro, QGIS and AutoCAD Map.
  const name = `physical-plans_${label}_${stamp}`;
  const zip = (await shpwrite.zip(collection, {
    outputType: "nodebuffer",
    compression: "DEFLATE",
    folder: name,
    filename: name,
    types: { polygon: name },
  })) as unknown as Uint8Array;
  return { body: zip, contentType: "application/zip", filename: `${name}_shapefile.zip` };
}

function fileLabel(district: District, selection: SiteSelection, chosen: SiteData[] | null): string {
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const site = selection.site ? chosen?.[0]?.name : undefined;
  return [district.slug, selection.status?.toLowerCase(), selection.stage ? `stage-${selection.stage}` : selection.stage === 0 ? "stage-not-recorded" : null, site ? slug(site) : null]
    .filter(Boolean)
    .join("_");
}

function csv(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
