import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { esriRingsToGeoJson } from "@/lib/geo/esri-geometry";
import { ownerFilter } from "@/lib/plans/submissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 5_000;
/** What a planner or reviewer sees when clicking a submitted parcel. */
const POPUP_FIELDS = ["plan_id", "parcel_upi", "gen_lu", "zone_code", "zoning", "planning_status", "area_sqm", "district_1", "sector_1", "cell_1", "approval_date", "remarks"];

function popupProperties(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of POPUP_FIELDS) {
    const key = Object.keys(attributes).find((k) => k.toLowerCase() === name);
    if (!key) continue;
    const value = attributes[key];
    // Dates arrive as epoch milliseconds; show the calendar day.
    out[name] = name.endsWith("_date") && typeof value === "number" ? new Date(value).toISOString().slice(0, 10) : value;
  }
  return out;
}

/** Parcel shapes (WGS84 GeoJSON) for a submission: a planner's own parcels only; any parcel for a reviewer. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
  if (!session) return NextResponse.json({ ok: false, error: "Please sign in." }, { status: 401 });

  const ids = (request.nextUrl.searchParams.get("oids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ ok: true, features: [] });

  try {
    const layer = new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session));
    const meta = await layer.getMetadata();
    const rows = await layer.queryAll({
      where: `${ownerFilter(meta, config, session)}${meta.objectIdField} IN (${ids.join(",")})`,
      outFields: "*", // trimmed to POPUP_FIELDS below (field names vary in case between layers)
      returnGeometry: true,
      outSR: 4326,
    });
    const features = rows
      .filter((r) => r.geometry?.rings?.length)
      .map((r) => ({ properties: popupProperties(r.attributes), geometry: esriRingsToGeoJson(r.geometry!.rings!) }));
    return NextResponse.json({ ok: true, features });
  } catch (err) {
    console.error("[mine/parcels]", err);
    return NextResponse.json({ ok: false, error: "Parcels could not be loaded." }, { status: 502 });
  }
}
