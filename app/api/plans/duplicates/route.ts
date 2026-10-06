import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { MAX_FEATURES } from "@/lib/geo/parse-upload";
import { findDuplicates, type Fingerprint } from "@/lib/plans/duplicates";
import { loadExistingParcels } from "@/lib/plans/existing-parcels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Preview check: which uploaded polygons are already in the layer (or repeated in the file).
 * Takes fingerprints computed in the browser (small JSON instead of re-sending the file). The append
 * itself re-checks from the file on the server, so this endpoint only drives what the user sees.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (!session) return NextResponse.json({ ok: false, error: "Please sign in.", signInRequired: true }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const items = Array.isArray(body?.items) ? (body.items as unknown[]) : null;
  if (!items || items.length > MAX_FEATURES || !items.every(isFingerprint)) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const tokens = createUserTokenProvider(config, session);
  try {
    const layer = new FeatureLayerClient(config.featureLayerUrl, tokens);
    const existing = await loadExistingParcels(layer, await layer.getMetadata(), items);
    const response = NextResponse.json({ ok: true, duplicates: findDuplicates(items, existing), compared: existing.length });
    if (tokens.refreshed) response.cookies.set(SESSION_COOKIE, seal(tokens.session, config.sessionSecret), sessionCookieOptions(tokens.session));
    return response;
  } catch (err) {
    console.error("[duplicates]", err);
    const message = err instanceof ArcGisRequestError ? err.message : "Duplicate check failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.upi === null || (typeof v.upi === "string" && v.upi.length <= 255)) &&
    [v.cx, v.cy, v.areaSqMeters].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Math.abs(v.cx as number) <= 180 &&
    Math.abs(v.cy as number) <= 90
  );
}
