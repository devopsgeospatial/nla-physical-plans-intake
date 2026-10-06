import { NextResponse, type NextRequest } from "next/server";
import { ConfigurationError, getArcGisConfig, getUploadLimits, type UploadLimits } from "@/lib/arcgis/config";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider, SessionExpiredError } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, seal, sessionCookieOptions } from "@/lib/auth/session";
import { BoundaryValidationError, parseBoundaryFile } from "@/lib/geo/parse-boundary";
import { isDistrict, isPlanType, PLAN_NAME_MAX_LENGTH } from "@/lib/plan-options";
import { LayerSchemaError, PartialSubmissionError, submitPlan, type PlanSubmission } from "@/lib/plans/submit-plan";

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  try {
    const config = getArcGisConfig();
    const session = readSession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
    if (!session) throw new SessionExpiredError("Please sign in with your ArcGIS account to submit a plan.");
    const tokens = createUserTokenProvider(config, session);

    const limits = getUploadLimits();
    assertContentLength(request, limits);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new RequestValidationError("Request body must be multipart/form-data.");
    }

    const submission = await readSubmission(form, limits);
    const result = await submitPlan(submission, tokens);

    console.info(
      `[plans:${requestId}] ${session.username} created objectId=${result.objectId} attachments=${result.attachments.length}`,
    );
    const response = NextResponse.json({ ok: true, requestId, submittedBy: session.username, ...result }, { status: 201 });
    if (tokens.refreshed) {
      response.cookies.set(SESSION_COOKIE, seal(tokens.session, config.sessionSecret), sessionCookieOptions(tokens.session));
    }
    return response;
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

async function readSubmission(form: FormData, limits: UploadLimits): Promise<PlanSubmission> {
  const planName = readText(form, "plan_name");
  if (planName.length > PLAN_NAME_MAX_LENGTH) {
    throw new RequestValidationError(`plan_name must be at most ${PLAN_NAME_MAX_LENGTH} characters.`, "plan_name");
  }
  const district = readText(form, "district");
  if (!isDistrict(district)) throw new RequestValidationError(`Unknown district "${district}".`, "district");
  const planType = readText(form, "plan_type");
  if (!isPlanType(planType)) throw new RequestValidationError(`Unknown plan_type "${planType}".`, "plan_type");

  const boundaryFile = form.get("boundary");
  if (!(boundaryFile instanceof File) || boundaryFile.size === 0) {
    throw new RequestValidationError("A boundary file is required.", "boundary");
  }
  if (boundaryFile.size > limits.maxBoundaryBytes) {
    throw new RequestValidationError(`Boundary file exceeds ${formatBytes(limits.maxBoundaryBytes)}.`, "boundary", 413);
  }
  // The client preview is advisory only; the server re-parses and validates the geometry itself.
  const boundary = await parseBoundaryFile(boundaryFile.name, await boundaryFile.arrayBuffer());

  const documents = form.getAll("documents").filter((d): d is File => d instanceof File && d.size > 0);
  if (documents.length === 0) throw new RequestValidationError("At least one PDF document is required.", "documents");
  if (documents.length > limits.maxPdfCount) {
    throw new RequestValidationError(`At most ${limits.maxPdfCount} PDF documents may be attached.`, "documents");
  }

  const docs: PlanSubmission["documents"] = [];
  for (const doc of documents) {
    if (doc.size > limits.maxPdfBytes) {
      throw new RequestValidationError(`"${doc.name}" exceeds ${formatBytes(limits.maxPdfBytes)}.`, "documents", 413);
    }
    const bytes = new Uint8Array(await doc.arrayBuffer());
    if (!isPdf(bytes)) throw new RequestValidationError(`"${doc.name}" is not a PDF file.`, "documents", 415);
    docs.push({ file: new Blob([bytes], { type: "application/pdf" }), fileName: sanitizeFileName(doc.name) });
  }

  return { planName, district, planType, boundary, documents: docs };
}

function readText(form: FormData, name: string): string {
  const value = form.get(name);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new RequestValidationError(`${name} is required.`, name);
  return text;
}

function assertContentLength(request: Request, limits: UploadLimits): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  const max = limits.maxBoundaryBytes + limits.maxPdfBytes * limits.maxPdfCount + 64 * 1024;
  if (declared > max) throw new RequestValidationError(`Upload exceeds ${formatBytes(max)} in total.`, undefined, 413);
}

function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" may be preceded by a little junk in the first 1 KB per the PDF spec's leniency.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document.pdf";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  const withName = cleaned || "document";
  return withName.toLowerCase().endsWith(".pdf") ? withName : `${withName}.pdf`;
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
  if (err instanceof BoundaryValidationError) return body(422, err.message, { field: "boundary" });

  console.error(`[plans:${requestId}]`, err);

  if (err instanceof PartialSubmissionError) {
    return body(502, err.message, { objectId: err.objectId, rolledBack: err.rolledBack });
  }
  if (err instanceof ArcGisRequestError && (err.code === 403 || /permission/i.test(err.message))) {
    return body(403, "Your ArcGIS account does not have edit access to the plan submissions layer. Ask your administrator to share it with you.", { arcgisCode: err.code });
  }
  if (err instanceof ArcGisRequestError) {
    return body(502, `ArcGIS Online rejected the request: ${err.message}`, { arcgisCode: err.code });
  }
  if (err instanceof ConfigurationError || err instanceof LayerSchemaError) {
    return body(500, `Server configuration error: ${err.message}`);
  }
  return body(500, "Unexpected server error. Reference the requestId when reporting this.");
}
