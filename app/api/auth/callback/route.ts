import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { exchangeCode, SignInError } from "@/lib/auth/oauth";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, seal, sessionCookieOptions, unseal, type OAuthState } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth redirect target: validates state, exchanges the code (PKCE) and sets the session cookie. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const params = request.nextUrl.searchParams;
  const pending = unseal<OAuthState>(request.cookies.get(OAUTH_STATE_COOKIE)?.value, config.sessionSecret);

  const fail = (message: string) => {
    const url = new URL("/", config.appUrl);
    url.searchParams.set("auth_error", message);
    const response = NextResponse.redirect(url);
    response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth" });
    return response;
  };

  if (params.get("error")) {
    return fail(params.get("error_description") || `Sign-in was cancelled (${params.get("error")}).`);
  }
  const code = params.get("code");
  if (!code || !pending || params.get("state") !== pending.state) {
    return fail("Sign-in could not be verified (expired or mismatched state). Please try again.");
  }

  try {
    const session = await exchangeCode(config, code, pending.codeVerifier);
    const response = NextResponse.redirect(new URL(pending.returnTo, config.appUrl));
    response.cookies.set(SESSION_COOKIE, seal(session, config.sessionSecret), sessionCookieOptions(session));
    response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth" });
    console.info(`[auth] signed in ${session.username}`);
    return response;
  } catch (err) {
    if (err instanceof SignInError) return fail(err.message);
    console.error("[auth] code exchange failed", err);
    return fail(err instanceof ArcGisRequestError ? `ArcGIS sign-in failed: ${err.message}` : "Sign-in failed unexpectedly.");
  }
}
