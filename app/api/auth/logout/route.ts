import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { arcgisRequest } from "@/lib/arcgis/rest";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clears the session cookie and revokes the refresh token (best effort). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (session) {
    await arcgisRequest(
      `${config.portalUrl}/sharing/rest/oauth2/revokeToken`,
      { client_id: config.oauthClientId, auth_token: session.refreshToken, token_type_hint: "refresh_token" },
      { referer: config.appUrl },
    ).catch((err) => console.warn("[auth] refresh token revocation failed", err));
  }
  const response = NextResponse.redirect(new URL("/", config.appUrl), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
