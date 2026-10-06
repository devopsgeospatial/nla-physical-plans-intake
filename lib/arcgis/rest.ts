/**
 * Minimal, typed ArcGIS REST transport. ArcGIS returns most failures as HTTP 200 with an
 * `{ error: { code, message, details } }` body, so both the HTTP status and the payload are checked.
 */

export type RestParamValue = string | number | boolean | Blob | object | undefined | null;

export interface RestFile {
  blob: Blob;
  fileName: string;
}

export interface RestRequestOptions {
  /** Sent as the Referer header; must match the referer the token was issued for. */
  referer: string;
  token?: string;
  timeoutMs?: number;
  /** Multipart file parts (e.g. `attachment` for addAttachment). Forces multipart/form-data. */
  files?: Record<string, RestFile>;
  method?: "GET" | "POST";
}

export class ArcGisRequestError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly code?: number,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ArcGisRequestError";
  }

  /** 498 = invalid/expired token, 499 = token required. */
  get isTokenError(): boolean {
    return this.code === 498 || this.code === 499;
  }
}

interface ArcGisErrorBody {
  error?: { code?: number; message?: string; messageCode?: string; details?: unknown };
}

export async function arcgisRequest<T>(
  url: string,
  params: Record<string, RestParamValue>,
  options: RestRequestOptions,
): Promise<T> {
  const method = options.method ?? "POST";
  const merged: Record<string, RestParamValue> = { ...params, f: "json" };
  if (options.token) merged.token = options.token;

  const headers: Record<string, string> = { Referer: options.referer, Accept: "application/json" };
  let requestUrl = url;
  let body: BodyInit | undefined;

  if (method === "GET") {
    requestUrl = `${url}?${toSearchParams(merged).toString()}`;
  } else if (options.files && Object.keys(options.files).length > 0) {
    const form = new FormData();
    for (const [key, value] of Object.entries(merged)) {
      const encoded = encodeValue(value);
      if (encoded !== undefined) form.append(key, encoded);
    }
    for (const [key, file] of Object.entries(options.files)) form.append(key, file.blob, file.fileName);
    body = form; // fetch sets the multipart boundary header
  } else {
    body = toSearchParams(merged);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    throw new ArcGisRequestError(`Network error calling ArcGIS (${redact(url)}): ${cause}`, redact(url));
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ArcGisRequestError(
      `ArcGIS returned a non-JSON response (HTTP ${response.status}) from ${redact(url)}: ${text.slice(0, 200)}`,
      redact(url),
      response.status,
    );
  }

  const error = (json as ArcGisErrorBody).error;
  if (error) {
    const details = Array.isArray(error.details) ? error.details.map(String) : [];
    const message = [error.message ?? "ArcGIS request failed", ...details].join(" ");
    throw new ArcGisRequestError(message, redact(url), error.code, details);
  }
  if (!response.ok) {
    throw new ArcGisRequestError(`ArcGIS HTTP ${response.status} from ${redact(url)}`, redact(url), response.status);
  }
  return json as T;
}

function toSearchParams(params: Record<string, RestParamValue>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const encoded = encodeValue(value);
    if (encoded === undefined) continue;
    if (typeof encoded !== "string") throw new Error(`Parameter "${key}" is binary; pass it via options.files.`);
    search.append(key, encoded);
  }
  return search;
}

function encodeValue(value: RestParamValue): string | Blob | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Blob) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Strips query strings (which may carry tokens) from URLs used in error messages. */
function redact(url: string): string {
  return url.split("?")[0] ?? url;
}
