import { NextResponse, type NextRequest } from "next/server";
import { getArcGisConfig, getUploadLimits } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider, SessionExpiredError } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { assertContentLength, readPdfDocuments, RequestValidationError } from "@/lib/http/uploads";
import { recordDecision, ReviewError, type Decision } from "@/lib/plans/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Review app: approves a submission or returns it to the planner with a comment (multipart form:
 * planner, submittedAt, decision = approve | return, comment, documents = PDFs from NLA).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getArcGisConfig();
  if (config.appMode !== "review") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
  if (!session) return NextResponse.json({ ok: false, error: "Please sign in again.", signInRequired: true }, { status: 401 });

  const tokens = createUserTokenProvider(config, session);
  try {
    const limits = getUploadLimits();
    assertContentLength(request, limits);
    const form = await request.formData().catch(() => {
      throw new RequestValidationError("Request body must be multipart/form-data.");
    });
    const planner = String(form.get("planner") ?? "");
    const submittedAt = Number(form.get("submittedAt"));
    const decision = String(form.get("decision") ?? "") as Decision;
    if (!planner || !Number.isInteger(submittedAt) || !["approve", "return"].includes(decision)) {
      throw new RequestValidationError("Invalid request.");
    }

    const layer = new FeatureLayerClient(config.featureLayerUrl, tokens);
    const submission = await recordDecision(layer, await layer.getMetadata(), {
      planner,
      submittedAt,
      decision,
      comment: String(form.get("comment") ?? ""),
      documents: await readPdfDocuments(form, limits),
    });
    console.info(`[review] ${session.username} ${decision === "approve" ? "approved" : "returned"} ${planner}'s submission of ${new Date(submittedAt).toISOString()}`);

    const response = NextResponse.json({ ok: true, submission });
    if (tokens.refreshed) response.cookies.set(SESSION_COOKIE, seal(tokens.session, config.sessionSecret), sessionCookieOptions(tokens.session));
    return response;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      const response = NextResponse.json({ ok: false, error: err.message, signInRequired: true }, { status: 401 });
      response.cookies.delete(SESSION_COOKIE);
      return response;
    }
    if (err instanceof RequestValidationError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    if (err instanceof ReviewError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[review]", err);
    if (err instanceof ArcGisRequestError && (err.code === 403 || /permission/i.test(err.message))) {
      return NextResponse.json({ ok: false, error: "Your ArcGIS account may not edit the Physical_Plans layer." }, { status: 403 });
    }
    const message = err instanceof ArcGisRequestError ? `ArcGIS Online rejected the request: ${err.message}` : "The decision could not be saved.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
