import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { isDistrictLive } from "@/lib/public/availability";
import { findDistrict } from "@/lib/public/districts";
import { districtBoundary } from "@/lib/public/geo-index";
import { resolvePublicConfig } from "@/lib/public/resolve";
import { districtSummary } from "@/lib/public/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Public viewer: a district's totals, plan extent and sites (?district=muhanga), cached at the edge. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (getAppMode() !== "public") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const config = await resolvePublicConfig(getPublicConfig());
  const district = findDistrict(request.nextUrl.searchParams.get("district") ?? "");
  if (!district || !(await isDistrictLive(config, district))) {
    return NextResponse.json({ ok: false, error: "This district is not available yet." }, { status: 404 });
  }
  try {
    const boundary = await districtBoundary(config, district.name);
    if (!boundary) throw new Error(`No boundary for ${district.name}`);
    const summary = await districtSummary(config, district, boundary);
    // Plans change only when NLA approves one: cache 5 minutes, and serve the last answer while refreshing.
    return NextResponse.json({ ok: true, ...summary }, { headers: { "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400" } });
  } catch (err) {
    console.error("[public/summary]", err);
    return NextResponse.json({ ok: false, error: "The district's figures could not be loaded right now." }, { status: 502 });
  }
}
