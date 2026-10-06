import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { buildAuthorizeUrl, createPkcePair } from "@/lib/auth/oauth";
import { OAUTH_STATE_COOKIE, seal, type OAuthState } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts ArcGIS sign-in: stores PKCE verifier + state in a short-lived encrypted cookie and redirects. */
export function GET(request: NextRequest): NextResponse {
  const config = getArcGisConfig();
  const { codeVerifier, codeChallenge, state } = createPkcePair();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  const response = NextResponse.redirect(buildAuthorizeUrl(config, state, codeChallenge));
  response.cookies.set(OAUTH_STATE_COOKIE, seal({ state, codeVerifier, returnTo } satisfies OAuthState, config.sessionSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 10 * 60,
  });
  return response;
}

/** Only same-origin relative paths, to avoid an open redirect. */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
