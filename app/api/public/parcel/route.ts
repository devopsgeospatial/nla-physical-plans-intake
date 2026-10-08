import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { isDistrictLive } from "@/lib/public/availability";
import { findDistrict, normalizeUpi } from "@/lib/public/districts";
import { lookupAtPoint, lookupByUpi } from "@/lib/public/parcel-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Public viewer: one parcel against the approved physical plan. ?district=muhanga and either
 * &upi=2/07/01/01/5833 or &lon=..&lat=.. (a point on the map). No sign-in.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (getAppMode() !== "public") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const config = getPublicConfig();
  const params = request.nextUrl.searchParams;

  const district = findDistrict(params.get("district") ?? "");
  if (!district || !(await isDistrictLive(config, district))) {
    return NextResponse.json({ ok: false, error: "This district is not available yet." }, { status: 404 });
  }

  const rawUpi = params.get("upi");
  const lon = Number(params.get("lon"));
  const lat = Number(params.get("lat"));
  const upi = rawUpi !== null ? normalizeUpi(rawUpi) : null;
  if (rawUpi !== null && !upi) {
    return NextResponse.json({ ok: false, error: "A UPI has five parts, like 2/07/01/01/5833." }, { status: 400 });
  }
  if (!upi && !(Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && params.has("lon") && params.has("lat"))) {
    return NextResponse.json({ ok: false, error: "Enter a UPI." }, { status: 400 });
  }

  try {
    const parcel = upi ? await lookupByUpi(config, district, upi) : await lookupAtPoint(config, district, lon, lat);
    if (!parcel) {
      const error = upi ? `No parcel with UPI ${upi} in ${district.name} District.` : "No registered parcel here.";
      return NextResponse.json({ ok: false, notFound: true, error }, { status: 404 });
    }
    // Plans change only when NLA approves one: a few minutes of caching keeps the layers unburdened.
    return NextResponse.json({ ok: true, parcel }, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (err) {
    console.error("[public/parcel]", err);
    return NextResponse.json({ ok: false, error: "The parcel could not be looked up right now. Please try again." }, { status: 502 });
  }
}
