import "server-only";

import { NextResponse } from "next/server";

/**
 * Refuses requests that change data when they come from another site's page. Browsers send Origin on
 * every cross-site POST; the app's own pages (also when embedded in an Experience Builder page) post
 * from the app's origin. Needed because session cookies are SameSite=None (see cookieBase).
 */
export function refuseForeignOrigin(request: Request, appUrl: string): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(appUrl).origin) return null;
  return NextResponse.json({ ok: false, error: "This request must come from the app itself." }, { status: 403 });
}
