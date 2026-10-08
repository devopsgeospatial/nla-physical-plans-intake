import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { isDistrictLive } from "@/lib/public/availability";
import { findDistrict } from "@/lib/public/districts";
import { isPublicRecord, publicPlans } from "@/lib/public/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public viewer: one document of an approved plan (?district=&oid=&aid=&name=). */
export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  if (getAppMode() !== "public") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const config = getPublicConfig();
  const params = request.nextUrl.searchParams;
  const district = findDistrict(params.get("district") ?? "");
  const objectId = Number(params.get("oid"));
  const attachmentId = Number(params.get("aid"));
  if (!district || !Number.isInteger(objectId) || !Number.isInteger(attachmentId) || !(await isDistrictLive(config, district))) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  try {
    // Only documents of plans the public may see: approved, in this district.
    if (!(await isPublicRecord(config, district, objectId))) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    const file = await publicPlans(config).downloadAttachment(objectId, attachmentId);
    const name = (params.get("name") ?? `document-${attachmentId}.pdf`).replace(/[^\w.\- ()]+/g, "_");
    return new Response(file.body, {
      headers: {
        "content-type": file.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": `inline; filename="${name}"`,
        "cache-control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("[public/document]", err);
    return NextResponse.json({ ok: false, error: "The document could not be downloaded." }, { status: 502 });
  }
}
