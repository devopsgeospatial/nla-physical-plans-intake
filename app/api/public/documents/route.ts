import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { isDistrictLive } from "@/lib/public/availability";
import { findDistrict } from "@/lib/public/districts";
import { listDocuments } from "@/lib/public/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public viewer: documents of the district's approved plans (?district=muhanga). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (getAppMode() !== "public") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const config = getPublicConfig();
  const district = findDistrict(request.nextUrl.searchParams.get("district") ?? "");
  if (!district || !(await isDistrictLive(config, district))) {
    return NextResponse.json({ ok: false, error: "This district is not available yet." }, { status: 404 });
  }
  try {
    const documents = await listDocuments(config, district);
    return NextResponse.json({ ok: true, documents }, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (err) {
    console.error("[public/documents]", err);
    return NextResponse.json({ ok: false, error: "The documents could not be loaded right now." }, { status: 502 });
  }
}
