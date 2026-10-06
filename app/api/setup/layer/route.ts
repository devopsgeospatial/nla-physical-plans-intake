import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { ProvisionError, provisionLayer } from "@/lib/arcgis/provision";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { checkLayerStatus, serviceNameFromUrl } from "@/lib/plans/layer-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-time setup: creates the intake layer as the signed-in user (who must be a publisher),
 * matching the reference layer's spatial reference. Refuses if the configured layer already exists.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (!session) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
  const tokens = createUserTokenProvider(config, session);

  const log: string[] = [];
  try {
    const status = await checkLayerStatus(tokens);
    if (status.state !== "missing") {
      return NextResponse.json({ ok: false, error: `Not creating a layer: current status is "${status.state}".` }, { status: 409 });
    }
    const result = await provisionLayer({
      portalUrl: config.portalUrl,
      username: session.username,
      tokens,
      serviceName: serviceNameFromUrl(config.featureLayerUrl),
      referenceLayerUrl: process.env.ARCGIS_REFERENCE_LAYER_URL || undefined,
      log: (line) => {
        log.push(line);
        console.info(`[setup] ${line}`);
      },
    });
    const response = NextResponse.json({
      ok: true,
      ...result,
      matchesConfig: result.layerUrl.toLowerCase() === config.featureLayerUrl.toLowerCase(),
      log,
    });
    if (tokens.refreshed) response.cookies.set(SESSION_COOKIE, seal(tokens.session, config.sessionSecret), sessionCookieOptions(tokens.session));
    return response;
  } catch (err) {
    console.error("[setup] provisioning failed", err);
    const message =
      err instanceof ProvisionError || err instanceof ArcGisRequestError
        ? err.message
        : "Unexpected error while creating the layer.";
    const hint =
      err instanceof ArcGisRequestError && err.code === 403
        ? " Your account needs the Publisher role (create content + publish hosted feature layers)."
        : "";
    return NextResponse.json({ ok: false, error: message + hint, log }, { status: 502 });
  }
}
