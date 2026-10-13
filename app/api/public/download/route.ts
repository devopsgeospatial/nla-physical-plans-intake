import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { isDistrictLive } from "@/lib/public/availability";
import { findDistrict } from "@/lib/public/districts";
import { buildExport, EXPORT_FORMATS, type ExportFormat } from "@/lib/public/export";
import { districtBoundary } from "@/lib/public/geo-index";
import { resolvePublicConfig } from "@/lib/public/resolve";
import { STATUSES, type PlanStatus } from "@/lib/public/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Public map downloads: ?district=muhanga&format=csv|geojson|shp|sites, optionally narrowed like
 * Explore: &status=Ongoing|Completed, &stage=0..5, &site=<site key>.
 */
export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  if (getAppMode() !== "public") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const params = request.nextUrl.searchParams;
  const format = params.get("format") as ExportFormat;
  const status = params.get("status") as PlanStatus | null;
  const stage = params.get("stage") === null || params.get("stage") === "" ? null : Number(params.get("stage"));
  if (!EXPORT_FORMATS.includes(format) || (status && !STATUSES.includes(status)) || (stage !== null && !(Number.isInteger(stage) && stage >= 0 && stage <= 5))) {
    return NextResponse.json({ ok: false, error: "Invalid download request." }, { status: 400 });
  }
  // From an embedded map (Experience Builder): the new tab first shows this page, which then starts the
  // download itself. Chrome blocks a file reached straight from a sandboxed frame, even in a new tab.
  if (params.get("start") === "1") {
    const next = new URL(request.nextUrl);
    next.searchParams.delete("start");
    return startPage(`${next.pathname}${next.search}`);
  }

  const config = await resolvePublicConfig(getPublicConfig());
  const district = findDistrict(params.get("district") ?? "");
  if (!district || !(await isDistrictLive(config, district))) {
    return NextResponse.json({ ok: false, error: "This district is not available yet." }, { status: 404 });
  }
  try {
    const boundary = await districtBoundary(config, district.name);
    if (!boundary) throw new Error(`No boundary for ${district.name}`);
    const file = await buildExport(config, district, boundary, { status, stage, site: params.get("site") || null }, format);
    return new Response(typeof file.body === "string" ? file.body : Buffer.from(file.body), {
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "public, max-age=60, s-maxage=300",
      },
    });
  } catch (err) {
    console.error("[public/download]", err);
    return NextResponse.json({ ok: false, error: "The download could not be prepared right now. Please try again." }, { status: 502 });
  }
}

function startPage(fileUrl: string): Response {
  const href = fileUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Downloading… · Physical Plans</title><meta http-equiv="refresh" content="1;url=${href}"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fa;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#14212b">
<main style="max-width:420px;padding:32px;text-align:center;background:#fff;border:1px solid #e6ebef;border-radius:16px">
<p style="margin:0;font-size:18px;font-weight:600">Your download is starting…</p>
<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#51626f">If nothing happens in a few seconds, <a href="${href}" style="color:#0b7fb5">download the file here</a>. You can close this tab afterwards.</p>
</main><script>setTimeout(function(){location.href=${JSON.stringify(fileUrl)}},150)</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
