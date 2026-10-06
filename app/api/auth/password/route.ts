import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { SignInError } from "@/lib/auth/oauth";
import { signInWithPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Username/password sign-in form target (plain HTML form POST, works without JavaScript). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  const back = (error: string, username = "") => {
    const url = new URL("/", config.appUrl);
    url.searchParams.set("auth_error", error);
    if (username) url.searchParams.set("u", username);
    return NextResponse.redirect(url, 303);
  };

  // Only accept the form from this app (blocks cross-site login attempts).
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(config.appUrl).origin) return back("Sign-in request came from another site.");

  const form = await request.formData().catch(() => null);
  const username = String(form?.get("username") ?? "").trim();
  const password = String(form?.get("password") ?? "");
  if (!username || !password) return back("Enter your ArcGIS Online username and password.", username);

  try {
    const session = await signInWithPassword(config, username, password);
    const response = NextResponse.redirect(new URL("/", config.appUrl), 303);
    response.cookies.set(SESSION_COOKIE, seal(session, config.sessionSecret), sessionCookieOptions(session));
    console.info(`[auth] signed in ${session.username} (password)`);
    return response;
  } catch (err) {
    if (err instanceof SignInError) return back(err.message, username);
    console.error("[auth] password sign-in failed", err);
    return back("Sign-in failed. Please try again.", username);
  }
}
