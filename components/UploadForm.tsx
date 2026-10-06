"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { parseUploadFile, UploadValidationError, type ParsedUpload } from "@/lib/geo/parse-upload";
import { AREA_FIELD, AUTO_FIELDS, mapFields, type LayerFieldInfo } from "@/lib/plans/attribute-mapping";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-slate-500">Loading map…</div>,
});

export interface LayerSummary {
  name: string;
  fields: LayerFieldInfo[];
  hasAttachments: boolean;
}

interface AppendSuccess {
  ok: true;
  requestId: string;
  layerName: string;
  objectIds: number[];
  attachmentsPerFeature: number;
}

interface AppendFailure {
  ok: false;
  requestId?: string;
  error: string;
  field?: string;
  signInRequired?: boolean;
  rolledBack?: boolean;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: AppendSuccess }
  | { kind: "error"; failure: AppendFailure };

type FileState =
  | { kind: "empty" }
  | { kind: "reading"; name: string }
  | { kind: "valid"; file: File; parsed: ParsedUpload }
  | { kind: "invalid"; name: string; message: string };

export default function UploadForm({ layer }: { layer: LayerSummary }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [upload, setUpload] = useState<FileState>({ kind: "empty" });
  const [documents, setDocuments] = useState<File[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const mapping = useMemo(
    () => (upload.kind === "valid" ? mapFields(upload.parsed.fieldNames, layer.fields) : null),
    [upload, layer.fields],
  );
  const autoFilled = useMemo(() => {
    const names = new Set(layer.fields.map((f) => f.name.toLowerCase()));
    const list: string[] = [AUTO_FIELDS.createdUser, AUTO_FIELDS.createdDate].filter((n) => names.has(n));
    if (names.has(AREA_FIELD) && !mapping?.matched.some((m) => m.layerField.name.toLowerCase() === AREA_FIELD)) list.push(AREA_FIELD);
    return list;
  }, [layer.fields, mapping]);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setSubmit({ kind: "idle" });
    if (!file) return setUpload({ kind: "empty" });
    setUpload({ kind: "reading", name: file.name });
    try {
      setUpload({ kind: "valid", file, parsed: await parseUploadFile(file.name, await file.arrayBuffer()) });
    } catch (err) {
      const message = err instanceof UploadValidationError ? err.message : `Could not read the file: ${(err as Error).message}`;
      setUpload({ kind: "invalid", name: file.name, message });
    }
  }

  const featureCount = upload.kind === "valid" ? upload.parsed.features.length : 0;
  const canSubmit = upload.kind === "valid" && submit.kind !== "submitting" && submit.kind !== "success";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || upload.kind !== "valid") return;
    const body = new FormData();
    body.set("file", upload.file, upload.file.name);
    for (const doc of documents) body.append("documents", doc, doc.name);

    setSubmit({ kind: "submitting" });
    try {
      const response = await fetch("/api/plans/submit", { method: "POST", body });
      const json = (await response.json().catch(() => null)) as AppendSuccess | AppendFailure | null;
      if (!json) setSubmit({ kind: "error", failure: { ok: false, error: `Server returned HTTP ${response.status}.` } });
      else if (json.ok) setSubmit({ kind: "success", result: json });
      else setSubmit({ kind: "error", failure: json });
    } catch (err) {
      setSubmit({ kind: "error", failure: { ok: false, error: `Network error: ${(err as Error).message}` } });
    }
  }

  function reset() {
    formRef.current?.reset();
    setUpload({ kind: "empty" });
    setDocuments([]);
    setSubmit({ kind: "idle" });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_1fr]">
      <form ref={formRef} onSubmit={onSubmit} className="space-y-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm" noValidate>
        <div>
          <label htmlFor="file" className="mb-1 block text-sm font-medium text-slate-800">
            Plan file
          </label>
          <input id="file" name="file" type="file" accept=".zip,.geojson,.json" onChange={onFileChange} className={fileClass} />
          <p className="mt-1 text-xs text-slate-500">Zipped Shapefile (.shp, .shx, .dbf, .prj) or GeoJSON, with the layer&apos;s attributes.</p>
          {upload.kind === "reading" && <p className="mt-2 text-sm text-slate-500">Reading {upload.name}…</p>}
          {upload.kind === "invalid" && <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{upload.message}</p>}
        </div>

        {upload.kind === "valid" && mapping && (
          <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-900">
              {featureCount} polygon{featureCount === 1 ? "" : "s"} → {featureCount} new record{featureCount === 1 ? "" : "s"} in {layer.name}
            </p>
            <FieldList label="Attributes copied" names={mapping.matched.map((m) => m.layerField.name)} tone="green" empty="none: the file's fields do not match the layer" />
            {autoFilled.length > 0 && <FieldList label="Filled automatically" names={autoFilled} tone="blue" />}
            {mapping.ignored.length > 0 && <FieldList label="Not in layer (ignored)" names={mapping.ignored} tone="slate" />}
            {upload.parsed.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-800">
                {w}
              </p>
            ))}
          </div>
        )}

        <div>
          <label htmlFor="documents" className={`mb-1 block text-sm font-medium ${layer.hasAttachments ? "text-slate-800" : "text-slate-400"}`}>
            Attachments (PDF)
          </label>
          <input
            id="documents"
            name="documents"
            type="file"
            accept=".pdf,application/pdf"
            multiple
            disabled={!layer.hasAttachments}
            onChange={(e) => setDocuments(Array.from(e.target.files ?? []))}
            className={`${fileClass} disabled:opacity-50`}
          />
          {!layer.hasAttachments ? (
            <p className="mt-1 text-xs text-amber-800">Attachments are turned off on {layer.name}. The layer owner can enable them in the item settings.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Optional.{featureCount > 1 ? ` Each PDF is attached to all ${featureCount} new records.` : ""}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {submit.kind === "submitting" ? "Submitting…" : "Submit"}
          </button>
          {(submit.kind === "success" || submit.kind === "error") && (
            <button type="button" onClick={reset} className="text-sm text-slate-600 underline hover:text-slate-900">
              Upload another file
            </button>
          )}
        </div>

        {submit.kind === "success" && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
            <p className="font-medium">
              Appended {submit.result.objectIds.length} record{submit.result.objectIds.length === 1 ? "" : "s"} to {submit.result.layerName}
            </p>
            <p className="mt-1">Object IDs: {submit.result.objectIds.join(", ")}</p>
            {submit.result.attachmentsPerFeature > 0 && <p>{submit.result.attachmentsPerFeature} PDF(s) attached to each record.</p>}
          </div>
        )}
        {submit.kind === "error" && (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
            <p className="font-medium">Not submitted</p>
            <p className="mt-1">{submit.failure.error}</p>
            {submit.failure.signInRequired && (
              <a href="/api/auth/login" className="mt-2 inline-block font-medium underline">
                Sign in again
              </a>
            )}
            {submit.failure.requestId && <p className="mt-2 text-xs text-red-700">Reference: {submit.failure.requestId}</p>}
          </div>
        )}
      </form>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">
          Map{upload.kind === "valid" && <span className="font-normal text-slate-500"> · click a polygon to see its attributes</span>}
        </div>
        <div className="h-[520px] lg:h-[calc(100%-37px)]">
          <UploadPreviewMap features={upload.kind === "valid" ? upload.parsed.features : null} />
        </div>
      </section>
    </div>
  );
}

const fileClass =
  "block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200";

const TONES = {
  green: "bg-emerald-100 text-emerald-900",
  blue: "bg-blue-100 text-blue-900",
  slate: "bg-slate-200 text-slate-700",
} as const;

function FieldList({ label, names, tone, empty }: { label: string; names: string[]; tone: keyof typeof TONES; empty?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {names.length === 0 && empty ? <span className="text-xs text-red-700">{empty}</span> : null}
        {names.map((n) => (
          <span key={n} className={`rounded px-1.5 py-0.5 font-mono text-xs ${TONES[tone]}`}>
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}
