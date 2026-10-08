import "server-only";

import type { UploadLimits } from "../arcgis/config";

/** A request a route refuses before doing any work; `field` names the form part at fault. */
export class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function assertContentLength(request: Request, limits: UploadLimits): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  const max = limits.maxRequestBytes;
  if (declared > max) throw new RequestValidationError(`Upload exceeds ${formatBytes(max)} in total.`, undefined, 413);
}

/** The "documents" parts of a multipart form, checked to be real PDFs within the limits. */
export async function readPdfDocuments(form: FormData, limits: UploadLimits): Promise<{ file: Blob; fileName: string }[]> {
  const pdfs = form.getAll("documents").filter((d): d is File => d instanceof File && d.size > 0);
  if (pdfs.length > limits.maxPdfCount) {
    throw new RequestValidationError(`At most ${limits.maxPdfCount} PDF attachments are allowed.`, "documents");
  }
  const documents: { file: Blob; fileName: string }[] = [];
  for (const pdf of pdfs) {
    if (pdf.size > limits.maxPdfBytes) {
      throw new RequestValidationError(`"${pdf.name}" exceeds ${formatBytes(limits.maxPdfBytes)}.`, "documents", 413);
    }
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    if (!isPdf(bytes)) throw new RequestValidationError(`"${pdf.name}" is not a PDF file.`, "documents", 415);
    documents.push({ file: new Blob([bytes], { type: "application/pdf" }), fileName: sanitizeFileName(pdf.name) });
  }
  return documents;
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document.pdf";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "document";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
