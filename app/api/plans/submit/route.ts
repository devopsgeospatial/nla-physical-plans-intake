import { NextResponse, type NextRequest } from "next/server";
import { ConfigurationError, getArcGisConfig, getUploadLimits, type UploadLimits } from "@/lib/arcgis/config";
import { FeatureRejectedError } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider, SessionExpiredError } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { parseUploadFile, UploadValidationError } from "@/lib/geo/parse-upload";
import {
  appendFeatures,
  AttributeError,
  LayerSchemaError,
  PartialSubmissionError,
  type AppendRequest,
} from "@/lib/plans/append-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Appends the uploaded polygons (with their file attributes) and PDFs to the feature layer. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  try {
    const config = getArcGisConfig();
    const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
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

    const result = await appendFeatures({ ...(await readUpload(form, limits)), username: session.username }, tokens);
    console.info(
      `[append:${requestId}] ${session.username} appended ${result.objectIds.length} feature(s) to ${result.layerName}, ${result.attachmentsPerFeature} PDF(s) each`,
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

async function readUpload(form: FormData, limits: UploadLimits): Promise<Omit<AppendRequest, "username">> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new RequestValidationError("Choose a Shapefile (.zip) or GeoJSON file.", "file");
  if (file.size > limits.maxBoundaryBytes) {
    throw new RequestValidationError(`The file exceeds ${formatBytes(limits.maxBoundaryBytes)}.`, "file", 413);
  }
  // The browser preview is advisory only; the server parses and validates the file itself.
  const upload = await parseUploadFile(file.name, await file.arrayBuffer());

  const pdfs = form.getAll("documents").filter((d): d is File => d instanceof File && d.size > 0);
  if (pdfs.length > limits.maxPdfCount) {
    throw new RequestValidationError(`At most ${limits.maxPdfCount} PDF attachments are allowed.`, "documents");
  }
  const documents: AppendRequest["documents"] = [];
  for (const pdf of pdfs) {
    if (pdf.size > limits.maxPdfBytes) {
      throw new RequestValidationError(`"${pdf.name}" exceeds ${formatBytes(limits.maxPdfBytes)}.`, "documents", 413);
    }
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    if (!isPdf(bytes)) throw new RequestValidationError(`"${pdf.name}" is not a PDF file.`, "documents", 415);
    documents.push({ file: new Blob([bytes], { type: "application/pdf" }), fileName: sanitizeFileName(pdf.name) });
  }
  return { upload, documents };
}

function assertContentLength(request: Request, limits: UploadLimits): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  const max = limits.maxRequestBytes;
  if (declared > max) throw new RequestValidationError(`Upload exceeds ${formatBytes(max)} in total.`, undefined, 413);
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document.pdf";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "document";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
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
