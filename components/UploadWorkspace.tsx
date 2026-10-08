"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { parseUploadFile, UploadValidationError, type ParsedUpload, type UploadFeature } from "@/lib/geo/parse-upload";
import { findValueErrors, mapFields, type LayerFieldInfo } from "@/lib/plans/attribute-mapping";
import type { MapSettings } from "@/lib/arcgis/config";
import { uploadFingerprints, type DuplicateMatch } from "@/lib/plans/duplicates";
import AppHeader, { submissionTabs } from "./AppHeader";
import { DropZone, FileRow, formatSize } from "./FileInputs";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#eef2f5]" />,
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
  attachments: { objectId: number; count: number } | null;
  repairedCount: number;
  replacedCount: number;
  duplicates: DuplicateMatch[];
}

/** A submission NLA returned, which this upload revises (its parcels are replaced by the new file). */
export interface Revision {
  submittedAt: number;
  label: string;
  comments: string[];
}

interface AppendFailure {
  ok: false;
  requestId?: string;
  error: string;
  signInRequired?: boolean;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: AppendSuccess }
  | { kind: "error"; failure: AppendFailure };

type DuplicateCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; matches: Map<number, DuplicateMatch> }
  | { kind: "error" };

type FileState =
  | { kind: "empty" }
  | { kind: "reading"; name: string }
  | { kind: "valid"; file: File; parsed: ParsedUpload }
  | { kind: "invalid"; name: string; message: string };

const LABEL_FIELDS = ["parcel_upi", "plan_id", "name"];
const NO_DUPLICATES: ReadonlyMap<number, DuplicateMatch> = new Map();
/** Errors listed in the panel; the rest are summarised as a count. */
const MAX_ERRORS_SHOWN = 30;

export function featureLabel(feature: UploadFeature, index: number): string {
  for (const key of LABEL_FIELDS) {
    const match = Object.keys(feature.properties).find((k) => k.toLowerCase() === key);
    const value = match ? feature.properties[match] : undefined;
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return `Parcel ${index + 1}`;
}

export default function UploadWorkspace({
  layer,
  user,
  maxRequestBytes,
  map,
  revising,
}: {
  layer: LayerSummary;
  user: { fullName: string; username: string };
  /** Largest submission the server accepts (file + PDFs), so oversize uploads are caught before sending. */
  maxRequestBytes: number;
  map: MapSettings;
  revising?: Revision;
}) {
  const [upload, setUpload] = useState<FileState>({ kind: "empty" });
  const [documents, setDocuments] = useState<File[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [selected, setSelected] = useState<number | null>(null);
  const [dupCheck, setDupCheck] = useState<DuplicateCheck>({ kind: "idle" });

  const parsed = upload.kind === "valid" ? upload.parsed : null;
  const done = submit.kind === "success";
  const mapping = useMemo(() => (parsed ? mapFields(parsed.fieldNames, layer.fields) : null), [parsed, layer.fields]);
  const duplicates = useMemo(() => (dupCheck.kind === "done" ? dupCheck.matches : NO_DUPLICATES), [dupCheck]);
  const skipped = useMemo(() => new Set(duplicates.keys()), [duplicates]);
  const valueErrors = useMemo(() => (parsed && mapping ? findValueErrors(parsed.features, mapping, skipped) : []), [parsed, mapping, skipped]);

  const total = parsed?.features.length ?? 0;
  const count = total - duplicates.size; // parcels that will be appended
  const hectares = parsed ? parsed.features.reduce((sum, f, i) => (skipped.has(i) ? sum : sum + f.areaSqMeters), 0) / 10_000 : 0;
  const totalBytes = (upload.kind === "valid" ? upload.file.size : 0) + documents.reduce((n, d) => n + d.size, 0);
  const tooLarge = totalBytes + 32 * 1024 > maxRequestBytes; // small margin for multipart overhead
  const nothingNew = dupCheck.kind === "done" && total > 0 && count === 0;
  const canSubmit =
    !!parsed && count > 0 && valueErrors.length === 0 && !tooLarge && dupCheck.kind !== "checking" && submit.kind !== "submitting" && !done;

  // Unsent work is easy to lose (a stray drop, a closed tab): ask before leaving, and never let a
  // file dropped outside a drop zone replace the app with the browser's own file viewer.
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
  const hasUnsentWork = (upload.kind === "valid" || documents.length > 0) && !done;
  useEffect(() => {
    if (!hasUnsentWork) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsentWork]);

  const loadFile = useCallback(async (file: File) => {
    setSubmit({ kind: "idle" });
    setSelected(null);
    setDupCheck({ kind: "idle" });
    setUpload({ kind: "reading", name: file.name });
    try {
      const result = await parseUploadFile(file.name, await file.arrayBuffer());
      setUpload({ kind: "valid", file, parsed: result });
      void checkDuplicates(result);
    } catch (err) {
      const message = err instanceof UploadValidationError ? err.message : `Could not read the file: ${(err as Error).message}`;
      setUpload({ kind: "invalid", name: file.name, message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Asks the server which parcels already exist in the layer (the append re-checks authoritatively). */
  async function checkDuplicates(result: ParsedUpload) {
    setDupCheck({ kind: "checking" });
    try {
      const response = await fetch("/api/plans/duplicates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: uploadFingerprints(result.features, result.fieldNames, layer.fields), replaces: revising?.submittedAt }),
      });
      const json = (await response.json().catch(() => null)) as { ok: boolean; duplicates?: DuplicateMatch[] } | null;
      if (!json?.ok || !json.duplicates) throw new Error();
      setDupCheck({ kind: "done", matches: new Map(json.duplicates.map((d) => [d.index, d])) });
    } catch {
      setDupCheck({ kind: "error" }); // the append still skips duplicates server-side
    }
  }

  async function onSubmit() {
    if (!canSubmit || upload.kind !== "valid") return;
    const body = new FormData();
    body.set("file", upload.file, upload.file.name);
    for (const doc of documents) body.append("documents", doc, doc.name);
    if (revising) body.set("replaces", String(revising.submittedAt));
    setSubmit({ kind: "submitting" });
    try {
      const response = await fetch("/api/plans/submit", { method: "POST", body });
      const json = (await response.json().catch(() => null)) as AppendSuccess | AppendFailure | null;
      if (!json) {
        const error = response.status === 413 ? `Too large. The maximum is ${formatSize(maxRequestBytes)}.` : `Server error (HTTP ${response.status}).`;
        setSubmit({ kind: "error", failure: { ok: false, error } });
      } else if (json.ok) setSubmit({ kind: "success", result: json });
      else setSubmit({ kind: "error", failure: json });
    } catch (err) {
      setSubmit({ kind: "error", failure: { ok: false, error: `Network error: ${(err as Error).message}` } });
    }
  }

  function reset() {
    // A revision is sent once; the next upload is a new submission.
    if (revising && done) {
      window.location.assign("/");
      return;
    }
    setDupCheck({ kind: "idle" });
    setUpload({ kind: "empty" });
    setDocuments([]);
    setSubmit({ kind: "idle" });
    setSelected(null);
  }

  // Everything the user must fix before submitting, in one list.
  const blocking: { key: string; text: string; index?: number }[] = [];
  if (upload.kind === "invalid") blocking.push({ key: "file", text: upload.message });
  if (nothingNew) blocking.push({ key: "none", text: "All parcels in this file are already in the layer." });
  if (tooLarge && !done) blocking.push({ key: "size", text: `Files too large: ${formatSize(totalBytes)} (max ${formatSize(maxRequestBytes)}).` });
  for (const e of valueErrors.slice(0, MAX_ERRORS_SHOWN)) {
    blocking.push({ key: `${e.index}-${e.field}`, index: e.index, text: `${parsed ? featureLabel(parsed.features[e.index]!, e.index) : ""} · ${e.field} ${e.message}` });
  }
  if (submit.kind === "error") blocking.push({ key: "submit", text: submit.failure.error });

  return (
    <div className="flex h-dvh flex-col bg-white">
      <AppHeader title="Physical Plan Submission" tabs={submissionTabs("submit")} fullName={user.fullName} />

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="relative z-[1000] flex min-h-0 flex-1 flex-col bg-paper lg:w-[360px] lg:flex-none">
          <div className="scroll-slim flex-1 space-y-6 overflow-y-auto p-5">
            {revising && (
              <div className="rounded-lg border-l-[3px] border-nla-light bg-nla-tint px-3 py-2.5">
                <p className="text-[14px] text-ink">Revised plan · {revising.label}</p>
                {revising.comments.map((c) => (
                  <p key={c} className="mt-1 text-[13px] leading-5 text-graphite">
                    NLA: {c}
                  </p>
                ))}
              </div>
            )}

            <Section n={1} title="Plan file">
              {upload.kind === "valid" ? (
                <FileRow name={upload.file.name} size={upload.file.size} onRemove={done ? undefined : reset} />
              ) : (
                <DropZone
                  accept=".zip,.geojson,.json"
                  onFiles={(files) => files[0] && loadFile(files[0])}
                  label={upload.kind === "reading" ? "Reading…" : "Drop plan file"}
                  hint=".zip or .geojson"
                />
              )}
            </Section>

            {parsed && (
              <div className="fade-in grid grid-cols-2 rounded-xl border border-hairline bg-nla-tint text-ink">
                <Indicator
                  value={dupCheck.kind === "checking" ? "…" : count.toLocaleString()}
                  label={duplicates.size > 0 ? `parcels (of ${total.toLocaleString()})` : "parcels"}
                />
                <Indicator value={hectares >= 100 ? hectares.toFixed(0) : hectares.toFixed(2)} label="hectares" divider />
              </div>
            )}

            {blocking.length > 0 && (
              <ul className="fade-in space-y-1.5" role="alert">
                {blocking.map((b) => (
                  <li key={b.key}>
                    <button
                      type="button"
                      disabled={b.index === undefined}
                      onClick={() => b.index !== undefined && setSelected(b.index)}
                      className="w-full border-l-[3px] border-alert bg-[#fdf1f1] px-3 py-2 text-left text-[13px] leading-5 text-[#7a1c1c] enabled:hover:bg-[#fbe4e4]"
                    >
                      {b.text}
                    </button>
                  </li>
                ))}
                {valueErrors.length > MAX_ERRORS_SHOWN && (
                  <li className="px-3 text-[13px] text-alert">+ {valueErrors.length - MAX_ERRORS_SHOWN} more</li>
                )}
              </ul>
            )}

            <Section n={2} title="Attachments">
              {layer.hasAttachments ? (
                <>
                  {!done && (
                    <DropZone accept=".pdf,application/pdf" multiple onFiles={(files) => setDocuments((prev) => addUnique(prev, files))} label="Drop PDF" hint="optional" />
                  )}
                  {documents.map((d) => (
                    <FileRow key={`${d.name}-${d.size}`} name={d.name} size={d.size} onRemove={done ? undefined : () => setDocuments((prev) => prev.filter((p) => p !== d))} />
                  ))}
                </>
              ) : (
                <p className="text-[13px] text-graphite">Turned off on this layer.</p>
              )}
            </Section>

            {submit.kind === "success" && (
              <div className="fade-in border-l-[3px] border-ok bg-[#eef7f1] px-3 py-3" role="status">
                <p className="text-[15px] text-ink">
                  {submit.result.objectIds.length.toLocaleString()} parcel{submit.result.objectIds.length === 1 ? "" : "s"} added
                </p>
                {submit.result.replacedCount > 0 && <p className="mt-0.5 text-[13px] text-graphite">Sent back to NLA for review</p>}
              </div>
            )}
          </div>

          <div className="relative border-t border-hairline p-5">
            {submit.kind === "submitting" && <span className="progress-bar absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden />}
            {done ? (
              <button type="button" onClick={reset} className="h-11 w-full rounded-lg border border-nla text-[15px] text-nla transition hover:bg-nla hover:text-white">
                New upload
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                className="h-11 w-full rounded-lg bg-nla font-semibold text-[15px] text-white transition hover:bg-[#096a97] disabled:cursor-not-allowed disabled:bg-[#dfe5ea]"
              >
                {submit.kind === "submitting" ? "Submitting…" : dupCheck.kind === "checking" ? "Checking…" : "Submit"}
              </button>
            )}
          </div>
        </aside>

        <div className="relative h-[45dvh] shrink-0 lg:h-auto lg:flex-1">
          <UploadPreviewMap
            map={map}
            features={parsed?.features ?? null}
            labels={parsed?.features.map(featureLabel) ?? []}
            hovered={null}
            selected={selected}
            onSelect={setSelected}
            appended={done}
            skipped={skipped}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[16px] text-ink">
        <span className="mr-2 text-nla">{n}.</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Indicator({ value, label, divider }: { value: string; label: string; divider?: boolean }) {
  return (
    <div className={`px-5 py-5 ${divider ? "border-l border-hairline" : ""}`}>
      <p className="text-[36px] leading-none tabular-nums">{value}</p>
      <p className="mt-2 text-[12px] text-graphite">{label}</p>
    </div>
  );
}

function addUnique(existing: File[], added: File[]): File[] {
  return [...existing, ...added.filter((f) => !existing.some((p) => p.name === f.name && p.size === f.size))];
}
