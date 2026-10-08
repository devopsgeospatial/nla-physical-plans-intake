import { NextResponse, type NextRequest } from "next/server";
import { ConfigurationError, getArcGisConfig, getUploadLimits, type UploadLimits } from "@/lib/arcgis/config";
import { FeatureRejectedError } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider, SessionExpiredError } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { parseUploadFile, UploadValidationError } from "@/lib/geo/parse-upload";
import { assertContentLength, formatBytes, readPdfDocuments, RequestValidationError } from "@/lib/http/uploads";
import {
  appendFeatures,
  AttributeError,
  LayerSchemaError,
  NothingToAppendError,
  PartialSubmissionError,
  RevisionError,
  type AppendRequest,
} from "@/lib/plans/append-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Appends the uploaded polygons (with their file attributes) and PDFs to the feature layer. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  try {
    const config = getArcGisConfig();
    if (config.appMode !== "submission") return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
    if (!session) throw new SessionExpiredError("Please sign in with your ArcGIS account.");
    const tokens = createUserTokenProvider(config, session);

    const limits = getUploadLimits();
    assertContentLength(request, limits);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new RequestValidationError("Request body must be multipart/form-data.");
    }

    const replaces = readReplaces(form);
    const result = await appendFeatures({ ...(await readUpload(form, limits)), username: session.username, replaces }, tokens);
    console.info(
      `[append:${requestId}] ${session.username} ${replaces === undefined ? "" : `revised submission ${replaces} (replaced ${result.replacedCount}), `}appended ${result.objectIds.length} feature(s) to ${result.layerName}, skipped ${result.duplicates.length} duplicate(s), ${result.attachments ? `${result.attachments.count} PDF(s) on OBJECTID ${result.attachments.objectId}` : "no PDFs"}`,
    );

    const response = NextResponse.json({ ok: true, requestId, ...result }, { status: 201 });
    if (tokens.refreshed) {
      response.cookies.set(SESSION_COOKIE, seal(tokens.session, config.sessionSecret), sessionCookieOptions(tokens.session));
    }
    return response;
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

/** Set when the upload is the revised plan for a submission NLA returned. */
function readReplaces(form: FormData): number | undefined {
  const raw = form.get("replaces");
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new RequestValidationError("Invalid submission to revise.");
  return value;
}

async function readUpload(form: FormData, limits: UploadLimits): Promise<Omit<AppendRequest, "username">> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new RequestValidationError("Choose a Shapefile (.zip) or GeoJSON file.", "file");
  if (file.size > limits.maxBoundaryBytes) {
    throw new RequestValidationError(`The file exceeds ${formatBytes(limits.maxBoundaryBytes)}.`, "file", 413);
  }
  // The browser preview is advisory only; the server parses and validates the file itself.
  const upload = await parseUploadFile(file.name, await file.arrayBuffer());

  const documents = await readPdfDocuments(form, limits);
  return { upload, documents };
}

function errorResponse(err: unknown, requestId: string): NextResponse {
  const body = (status: number, error: string, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ ok: false, requestId, error, ...extra }, { status });

  if (err instanceof SessionExpiredError) {
    const response = body(401, err.message, { signInRequired: true });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
  if (err instanceof RequestValidationError) return body(err.status, err.message, { field: err.field });
  if (err instanceof UploadValidationError || err instanceof AttributeError) return body(422, err.message, { field: "file" });
  if (err instanceof FeatureRejectedError) return body(422, `ArcGIS rejected the data: ${err.message}`, { field: "file" });
  if (err instanceof LayerSchemaError) return body(422, err.message);
  if (err instanceof RevisionError) return body(409, err.message);
  if (err instanceof NothingToAppendError) return body(409, err.message, { duplicates: err.duplicates });

  console.error(`[append:${requestId}]`, err);

  if (err instanceof PartialSubmissionError) {
    return body(502, err.message, { objectIds: err.objectIds, rolledBack: err.rolledBack });
  }
  if (err instanceof ArcGisRequestError && (err.code === 403 || /permission/i.test(err.message))) {
    return body(403, "Your ArcGIS account does not have edit access to this layer. Ask the layer owner to share it with you.", {
      arcgisCode: err.code,
    });
  }
  if (err instanceof ArcGisRequestError) return body(502, `ArcGIS Online rejected the request: ${err.message}`, { arcgisCode: err.code });
  if (err instanceof ConfigurationError) return body(500, `Server configuration error: ${err.message}`);
  return body(500, "Unexpected server error. Reference the requestId when reporting this.");
}
