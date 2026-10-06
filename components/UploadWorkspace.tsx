"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { parseUploadFile, UploadValidationError, type ParsedUpload, type UploadFeature } from "@/lib/geo/parse-upload";
import { AREA_FIELD, AUTO_FIELDS, mapFields, type LayerFieldInfo } from "@/lib/plans/attribute-mapping";
import { uploadFingerprints, type DuplicateMatch } from "@/lib/plans/duplicates";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#1a1a1a]" />,
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
  duplicates: DuplicateMatch[];
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
  | { kind: "error"; message: string };

type FileState =
  | { kind: "empty" }
  | { kind: "reading"; name: string }
  | { kind: "valid"; file: File; parsed: ParsedUpload }
  | { kind: "invalid"; name: string; message: string };

const LABEL_FIELDS = ["parcel_upi", "plan_id", "name"];
const NO_DUPLICATES: ReadonlyMap<number, DuplicateMatch> = new Map();
/** Rows rendered in the polygon list; flagged polygons are always listed first. */
const MAX_LIST_ROWS = 400;

export function featureLabel(feature: UploadFeature, index: number): string {
  for (const key of LABEL_FIELDS) {
    const match = Object.keys(feature.properties).find((k) => k.toLowerCase() === key);
    const value = match ? feature.properties[match] : undefined;
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return `Polygon ${index + 1}`;
}

export default function UploadWorkspace({
  layer,
  user,
  portalHost,
  maxRequestBytes,
}: {
  layer: LayerSummary;
  user: { fullName: string; username: string };
  portalHost: string;
  /** Largest submission the server accepts (file + PDFs), so oversize uploads are caught before sending. */
  maxRequestBytes: number;
}) {
  const [upload, setUpload] = useState<FileState>({ kind: "empty" });
  const [documents, setDocuments] = useState<File[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [dupCheck, setDupCheck] = useState<DuplicateCheck>({ kind: "idle" });
  const outcomeRef = useRef<HTMLDivElement>(null);

  // Bring the result (success or error) into view in the scrollable panel.
  useEffect(() => {
    if (submit.kind === "success" || submit.kind === "error") outcomeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [submit.kind]);

  const parsed = upload.kind === "valid" ? upload.parsed : null;
  const mapping = useMemo(() => (parsed ? mapFields(parsed.fieldNames, layer.fields) : null), [parsed, layer.fields]);
  const autoFilled = useMemo(() => {
    const names = new Set(layer.fields.map((f) => f.name.toLowerCase()));
    const list: string[] = [AUTO_FIELDS.createdUser, AUTO_FIELDS.createdDate].filter((n) => names.has(n));
    if (names.has(AREA_FIELD) && !mapping?.matched.some((m) => m.layerField.name.toLowerCase() === AREA_FIELD)) list.push(AREA_FIELD);
    return list;
  }, [layer.fields, mapping]);

  const total = parsed?.features.length ?? 0;
  const duplicates = useMemo(() => (dupCheck.kind === "done" ? dupCheck.matches : NO_DUPLICATES), [dupCheck]);
  const skipped = useMemo(() => new Set(duplicates.keys()), [duplicates]);
  const count = total - duplicates.size; // polygons that will actually be appended
  const inLayerCount = [...duplicates.values()].filter((d) => d.existingObjectId !== undefined).length;
  const inFileCount = duplicates.size - inLayerCount;
  // The PDFs go on the first record that will be appended (first non-duplicate in file order).
  const firstNewIndex = parsed ? parsed.features.findIndex((_, i) => !skipped.has(i)) : -1;
  const firstNewLabel = parsed && firstNewIndex >= 0 ? `${firstNewIndex + 1} · ${featureLabel(parsed.features[firstNewIndex]!, firstNewIndex)}` : "";
  const listOrder = useMemo(() => {
    if (!parsed) return [];
    const indexes = parsed.features.map((_, i) => i);
    const rank = (i: number) => (skipped.has(i) ? 2 : parsed.features[i]!.selfIntersection ? 0 : 1); // repairs, new, duplicates
    return indexes.sort((a, b) => rank(a) - rank(b) || a - b).slice(0, MAX_LIST_ROWS);
  }, [parsed, skipped]);
  const totalHa = parsed ? parsed.features.reduce((sum, f, i) => (skipped.has(i) ? sum : sum + f.areaSqMeters), 0) / 10_000 : 0;
  const done = submit.kind === "success";
  // Multipart overhead is small; keep a 32 KB margin under the server limit.
  const totalBytes = (upload.kind === "valid" ? upload.file.size : 0) + documents.reduce((n, d) => n + d.size, 0);
  const tooLarge = totalBytes + 32 * 1024 > maxRequestBytes;
  const canSubmit = !!parsed && count > 0 && dupCheck.kind !== "checking" && !tooLarge && submit.kind !== "submitting" && !done;

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

  /** Asks the server which polygons already exist in the layer (the append re-checks authoritatively). */
  async function checkDuplicates(result: ParsedUpload) {
    setDupCheck({ kind: "checking" });
    try {
      const items = uploadFingerprints(result.features, result.fieldNames, layer.fields);
      const response = await fetch("/api/plans/duplicates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const json = (await response.json().catch(() => null)) as { ok: boolean; duplicates?: DuplicateMatch[]; error?: string } | null;
      if (!json?.ok || !json.duplicates) throw new Error(json?.error ?? `HTTP ${response.status}`);
      setDupCheck({ kind: "done", matches: new Map(json.duplicates.map((d) => [d.index, d])) });
    } catch (err) {
      setDupCheck({ kind: "error", message: (err as Error).message });
    }
  }

  async function onSubmit() {
    if (!canSubmit || upload.kind !== "valid") return;
    const body = new FormData();
    body.set("file", upload.file, upload.file.name);
    for (const doc of documents) body.append("documents", doc, doc.name);
    setSubmit({ kind: "submitting" });
    try {
      const response = await fetch("/api/plans/submit", { method: "POST", body });
      const json = (await response.json().catch(() => null)) as AppendSuccess | AppendFailure | null;
      if (!json) {
        const error =
          response.status === 413
            ? `The upload is larger than the server accepts (${formatSize(maxRequestBytes)}). Remove or compress PDFs and try again.`
            : `Server returned HTTP ${response.status}.`;
        setSubmit({ kind: "error", failure: { ok: false, error } });
      }
      else if (json.ok) setSubmit({ kind: "success", result: json });
      else setSubmit({ kind: "error", failure: json });
    } catch (err) {
      setSubmit({ kind: "error", failure: { ok: false, error: `Network error: ${(err as Error).message}` } });
    }
  }

  function reset() {
    setDupCheck({ kind: "idle" });
    setUpload({ kind: "empty" });
    setDocuments([]);
    setSubmit({ kind: "idle" });
    setSelected(null);
  }

  const statusLine =
    dupCheck.kind === "checking"
      ? `Checking ${layer.name} for parcels that already exist…`
      : dupCheck.kind === "done" && duplicates.size > 0
        ? `${duplicates.size.toLocaleString()} duplicate${duplicates.size === 1 ? "" : "s"} will be skipped: ${[
            inLayerCount > 0 ? `${inLayerCount.toLocaleString()} already in ${layer.name}` : "",
            inFileCount > 0 ? `${inFileCount.toLocaleString()} repeated in this file` : "",
          ]
            .filter(Boolean)
            .join(", ")}.`
        : null;

  return (
    <div className="flex h-dvh flex-col bg-night">
      {/* Header */}
      <header className="relative z-[1001] flex h-16 shrink-0 items-center justify-between gap-4 bg-hub px-5 text-white sm:px-8">
        <div className="flex min-w-0 items-baseline gap-5">
          <h1 className="truncate text-[17px] font-normal">Physical Plan Submission</h1>
          <span className="hidden truncate text-[14px] text-white/55 md:inline">
            {layer.name} · {portalHost}
          </span>
        </div>
        <div className="flex items-center gap-5">
          <p className="hidden text-right text-[14px] leading-tight sm:block">
            <span className="block text-white">{user.fullName}</span>
            <span className="block text-[12px] text-white/55">{user.username}</span>
          </p>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="h-9 rounded-none border border-white/45 px-4 text-[14px] text-white transition hover:bg-white/10">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        {/* Panel */}
        <aside className="relative z-[1000] flex min-h-0 flex-1 flex-col bg-paper lg:w-[480px] lg:flex-none">
          <div className="scroll-slim flex-1 overflow-y-auto">
            <Section n={1} title="Plan file">
              {upload.kind === "valid" ? (
                <FileRow name={upload.file.name} size={upload.file.size} onRemove={done ? undefined : reset} />
              ) : (
                <DropZone
                  accept=".zip,.geojson,.json"
                  onFiles={(files) => files[0] && loadFile(files[0])}
                  title={upload.kind === "reading" ? `Reading ${upload.name}…` : "Drop a zipped Shapefile or GeoJSON here"}
                  hint="The .zip must contain the .shp, .shx, .dbf and .prj files."
                  inputId="file"
                />
              )}
              {upload.kind === "invalid" && (
                <Remark tone="alert" title={`${upload.name} can't be used`}>
                  {upload.message}
                </Remark>
              )}
            </Section>

            {parsed && mapping && (
              <div className="fade-in">
                <div className="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
                  <Figure value={dupCheck.kind === "checking" ? "–" : count.toLocaleString()} label={`new record${count === 1 ? "" : "s"}`} accent />
                  <Figure value={totalHa >= 100 ? totalHa.toFixed(0) : totalHa.toFixed(2)} label="hectares" />
                  <Figure value={parsed.vertexCount.toLocaleString()} label="vertices" />
                </div>

                <div className="space-y-4 border-b border-hairline px-6 py-5">
                  {statusLine && <Remark tone={dupCheck.kind === "checking" ? "info" : "muted"}>{statusLine}</Remark>}
                  {dupCheck.kind === "done" && count === 0 && (
                    <Remark tone="warn" title="Nothing new in this file">
                      Every polygon is already in {layer.name}.
                    </Remark>
                  )}
                  {dupCheck.kind === "error" && (
                    <Remark tone="warn" title="Duplicates could not be checked yet">
                      {dupCheck.message}. They are still detected and skipped when you submit.
                    </Remark>
                  )}
                  {parsed.repairCount > 0 && (
                    <Remark tone="alert" title={`${parsed.repairCount} polygon${parsed.repairCount === 1 ? "" : "s"} cross${parsed.repairCount === 1 ? "es" : ""} itself`}>
                      Marked in red on the map. ArcGIS repairs {parsed.repairCount === 1 ? "it" : "them"} before appending.
                    </Remark>
                  )}
                  {parsed.warnings.map((w) => (
                    <Remark key={w} tone="muted">
                      {w}
                    </Remark>
                  ))}

                  <dl className="space-y-3 text-[14px] leading-6">
                    <FieldLine label={`Copied from the file (${mapping.matched.length})`}>
                      {mapping.matched.length > 0 ? mapping.matched.map((m) => m.layerField.name).join(", ") : <span className="text-warn">None of the file&apos;s fields match the layer.</span>}
                    </FieldLine>
                    {autoFilled.length > 0 && <FieldLine label="Filled in by the app">{autoFilled.join(", ")}</FieldLine>}
                    {mapping.ignored.length > 0 && (
                      <FieldLine label="Not in the layer, ignored">
                        <span className="text-graphite line-through decoration-graphite/40">{mapping.ignored.join(", ")}</span>
                      </FieldLine>
                    )}
                  </dl>
                </div>

                <table className="w-full border-b border-hairline text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-hairline text-[12px] text-graphite">
                      <th className="w-12 py-2.5 pl-6 font-semibold">#</th>
                      <th className="py-2.5 font-semibold">Parcel</th>
                      <th className="py-2.5 pr-6 text-right font-semibold">Area</th>
                    </tr>
                  </thead>
                  <tbody onMouseLeave={() => setHovered(null)}>
                    {listOrder.map((i) => {
                      const f = parsed.features[i]!;
                      const dup = duplicates.get(i);
                      return (
                        <tr
                          key={i}
                          onMouseEnter={() => setHovered(i)}
                          onClick={() => setSelected(i)}
                          className={`cursor-pointer border-b border-hairline/70 transition last:border-0 ${
                            selected === i ? "bg-nla-tint" : "hover:bg-mist"
                          } ${dup ? "text-graphite" : "text-ink"}`}
                        >
                          <td className="py-2.5 pl-6 tabular-nums text-graphite">{i + 1}</td>
                          <td className="max-w-0 py-2.5 pr-3">
                            <span className="block truncate">
                              {featureLabel(f, i)}
                              {i === firstNewIndex && documents.length > 0 && <span className="ml-2 text-[12px] text-nla">+ PDF</span>}
                            </span>
                            {dup && (
                              <span className="block text-[12px]">
                                {dup.existingObjectId !== undefined
                                  ? `Already in the layer (OBJECTID ${dup.existingObjectId}), skipped`
                                  : `Repeat of #${dup.sameFileAs! + 1}, skipped`}
                              </span>
                            )}
                            {!dup && f.selfIntersection && <span className="block text-[12px] text-alert">Crosses itself, repaired on submit</span>}
                          </td>
                          <td className="whitespace-nowrap py-2.5 pr-6 text-right tabular-nums">
                            {/* A self-crossing shape has no meaningful area until ArcGIS repairs it. */}
                            {f.selfIntersection ? "–" : formatArea(f.areaSqMeters)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {total > listOrder.length && (
                  <p className="border-b border-hairline px-6 py-3 text-[13px] text-graphite">
                    {(total - listOrder.length).toLocaleString()} more parcels are shown on the map.
                  </p>
                )}
              </div>
            )}

            <Section n={2} title="Attachments" note="optional">
              {!layer.hasAttachments ? (
                <p className="text-[14px] leading-6 text-graphite">
                  Attachments are turned off on {layer.name}. The layer owner can turn them on in the item settings.
                </p>
              ) : (
                <>
                  <DropZone
                    accept=".pdf,application/pdf"
                    multiple
                    disabled={done}
                    onFiles={(files) => setDocuments((prev) => [...prev, ...files.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))])}
                    title="Drop PDF documents here"
                    hint={count > 1 ? `Attached to the first new record (#${firstNewIndex + 1}) only.` : "PDF only."}
                    inputId="documents"
                  />
                  {documents.map((d) => (
                    <FileRow
                      key={`${d.name}-${d.size}`}
                      name={d.name}
                      size={d.size}
                      onRemove={done ? undefined : () => setDocuments((prev) => prev.filter((p) => p !== d))}
                    />
                  ))}
                </>
              )}
            </Section>

            {tooLarge && !done && (
              <div className="px-6 pt-5">
                <Remark tone="warn" title={`This upload is ${formatSize(totalBytes)}`}>
                  One submission can be at most {formatSize(maxRequestBytes)}, plan file and PDFs together. Remove or compress some PDFs.
                </Remark>
              </div>
            )}

            <div ref={outcomeRef} className="scroll-mb-6 px-6 py-6">
              {submit.kind === "success" && (
                <div className="fade-in border-l-4 border-ok pl-4" role="status">
                  <p className="text-[20px] font-normal leading-snug text-ink">
                    {submit.result.objectIds.length.toLocaleString()} record{submit.result.objectIds.length === 1 ? "" : "s"} appended to {submit.result.layerName}.
                  </p>
                  <p className="mt-2 text-[14px] leading-6 text-graphite">
                    {[
                      submit.result.duplicates.length > 0 &&
                        `${submit.result.duplicates.length} duplicate${submit.result.duplicates.length === 1 ? "" : "s"} skipped`,
                      submit.result.repairedCount > 0 && `${submit.result.repairedCount} repaired`,
                      submit.result.attachments &&
                        `${submit.result.attachments.count} PDF${submit.result.attachments.count === 1 ? "" : "s"} attached to OBJECTID ${submit.result.attachments.objectId}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No duplicates, nothing to repair."}
                  </p>
                  <p className="mt-1 text-[13px] text-graphite">OBJECTID {formatIdRange(submit.result.objectIds)}</p>
                </div>
              )}
              {submit.kind === "error" && (
                <Remark tone="alert" title="Nothing was appended">
                  {submit.failure.error}
                  {submit.failure.signInRequired && (
                    <a href="/" className="ml-1 underline underline-offset-2">
                      Sign in again
                    </a>
                  )}
                  {submit.failure.requestId && <span className="mt-1 block text-[12px] text-graphite">Reference {submit.failure.requestId}</span>}
                </Remark>
              )}
            </div>
          </div>

          {/* Action */}
          <div className="relative border-t border-hairline bg-paper px-6 py-4">
            {submit.kind === "submitting" && <span className="progress-bar absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden />}
            {done ? (
              <button
                type="button"
                onClick={reset}
                className="h-12 w-full rounded-none border border-nla text-[16px] text-nla transition hover:bg-nla hover:text-white"
              >
                Upload another plan
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                className="h-12 w-full rounded-none bg-nla text-[16px] text-white transition hover:bg-[#0b6299] disabled:cursor-not-allowed disabled:bg-[#cfcfcf]"
              >
                {submit.kind === "submitting"
                  ? "Appending…"
                  : dupCheck.kind === "checking"
                    ? "Checking for duplicates…"
                    : parsed && count > 0
                      ? `Submit ${count.toLocaleString()} new record${count === 1 ? "" : "s"}`
                      : "Submit"}
              </button>
            )}
          </div>
        </aside>

        {/* Map */}
        <div className="relative h-[42dvh] shrink-0 lg:h-auto lg:flex-1">
          <UploadPreviewMap
            features={parsed?.features ?? null}
            labels={parsed?.features.map(featureLabel) ?? []}
            hovered={hovered}
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

function Section({ n, title, note, children }: { n: number; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-b border-hairline px-6 py-6">
      <h2 className="flex items-baseline gap-3 text-[19px] font-normal text-ink">
        <span className="text-[19px] tabular-nums text-nla">{n}.</span>
        {title}
        {note && <span className="text-[13px] font-normal text-graphite">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function DropZone(props: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  title: string;
  hint: string;
  inputId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!props.disabled) props.onFiles(Array.from(e.dataTransfer.files));
  };
  return (
    <label
      htmlFor={props.inputId}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`block cursor-pointer border border-dashed px-5 py-6 transition ${
        over ? "border-nla bg-nla-tint" : "border-[#bdbdbd] bg-mist hover:border-nla"
      } ${props.disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      <span className="block text-[15px] text-ink">{props.title}</span>
      <span className="mt-1 block text-[13px] text-graphite">
        or <span className="text-nla underline underline-offset-2">browse your files</span>. {props.hint}
      </span>
      <input
        ref={inputRef}
        id={props.inputId}
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        disabled={props.disabled}
        className="sr-only"
        onChange={(e) => {
          props.onFiles(Array.from(e.target.files ?? []));
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </label>
  );
}

function FileRow({ name, size, onRemove }: { name: string; size: number; onRemove?: () => void }) {
  return (
    <div className="fade-in flex items-baseline justify-between gap-4 border-b border-hairline pb-3">
      <span className="min-w-0">
        <span className="block truncate text-[15px] text-ink">{name}</span>
        <span className="block text-[13px] text-graphite">{formatSize(size)}</span>
      </span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="shrink-0 text-[13px] text-graphite underline underline-offset-2 hover:text-alert">
          Remove
        </button>
      )}
    </div>
  );
}

function Figure({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="px-6 py-5">
      <p className={`text-[34px] font-normal leading-none tabular-nums ${accent ? "text-nla" : "text-ink"}`}>{value}</p>
      <p className="mt-2 text-[13px] text-graphite">{label}</p>
    </div>
  );
}

function FieldLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-graphite">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

const REMARK_TONES = {
  info: "border-nla text-ink",
  muted: "border-[#bdbdbd] text-[#3d3d3d]",
  warn: "border-warn text-ink",
  alert: "border-alert text-ink",
} as const;

function Remark({ tone, title, children }: { tone: keyof typeof REMARK_TONES; title?: string; children: ReactNode }) {
  return (
    <div className={`fade-in border-l-2 pl-3 text-[14px] leading-6 ${REMARK_TONES[tone]}`} role={tone === "alert" ? "alert" : undefined}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "text-[#3d3d3d]" : ""}>{children}</div>
    </div>
  );
}

/** "1, 2, 3" for a few IDs; "1001–3212 (2,212)" for long consecutive runs. */
function formatIdRange(ids: number[]): string {
  if (ids.length <= 12) return ids.join(", ");
  const sorted = [...ids].sort((a, b) => a - b);
  const consecutive = sorted.every((id, i) => i === 0 || id === sorted[i - 1]! + 1);
  return consecutive
    ? `${sorted[0]}–${sorted[sorted.length - 1]} (${ids.length.toLocaleString()})`
    : `${sorted.slice(0, 10).join(", ")} … +${(ids.length - 10).toLocaleString()} more`;
}

function formatArea(m2: number): string {
  return m2 >= 10_000 ? `${(m2 / 10_000).toFixed(2)} ha` : `${Math.round(m2).toLocaleString()} m²`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
