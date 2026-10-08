import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { ownerFilter } from "@/lib/plans/submissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams one attachment of a parcel the signed-in planner submitted (owner check first), or any parcel for a reviewer. */
export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  const config = getArcGisConfig();
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
  if (!session) return NextResponse.json({ ok: false, error: "Please sign in." }, { status: 401 });

  const objectId = Number(request.nextUrl.searchParams.get("oid"));
  const attachmentId = Number(request.nextUrl.searchParams.get("aid"));
  if (!Number.isInteger(objectId) || !Number.isInteger(attachmentId)) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  try {
    const layer = new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session));
    const meta = await layer.getMetadata();
    const owned = await layer.queryAll({
      where: `${ownerFilter(meta, config, session)}${meta.objectIdField} = ${objectId}`,
      outFields: meta.objectIdField,
      returnGeometry: false,
    });
    if (owned.length === 0) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

    const file = await layer.downloadAttachment(objectId, attachmentId);
    const name = (request.nextUrl.searchParams.get("name") ?? `document-${attachmentId}.pdf`).replace(/[^\w.\- ()]+/g, "_");
    return new Response(file.body, {
      headers: {
        "content-type": file.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": `inline; filename="${name}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[attachment]", err);
    return NextResponse.json({ ok: false, error: "The document could not be downloaded." }, { status: 502 });
  }
}
