"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { parseUploadFile, UploadValidationError, type ParsedUpload, type UploadFeature } from "@/lib/geo/parse-upload";
import { AREA_FIELD, AUTO_FIELDS, mapFields, type LayerFieldInfo } from "@/lib/plans/attribute-mapping";
import {
  BrandMark,
  IconAlert,
  IconCheck,
  IconFile,
  IconLayers,
  IconLock,
  IconLogout,
  IconPaperclip,
  IconPolygon,
  IconSpinner,
  IconUpload,
  IconX,
} from "./icons";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-ink-900" />,
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
  signInRequired?: boolean;
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

const LABEL_FIELDS = ["parcel_upi", "plan_id", "name"];

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
}: {
  layer: LayerSummary;
  user: { fullName: string; username: string };
  portalHost: string;
}) {
  const [upload, setUpload] = useState<FileState>({ kind: "empty" });
  const [documents, setDocuments] = useState<File[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
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

  const count = parsed?.features.length ?? 0;
  const totalHa = parsed ? parsed.features.reduce((sum, f) => sum + f.areaSqMeters, 0) / 10_000 : 0;
  const done = submit.kind === "success";
  const canSubmit = !!parsed && submit.kind !== "submitting" && !done;

  const loadFile = useCallback(async (file: File) => {
    setSubmit({ kind: "idle" });
    setSelected(null);
    setUpload({ kind: "reading", name: file.name });
    try {
      setUpload({ kind: "valid", file, parsed: await parseUploadFile(file.name, await file.arrayBuffer()) });
    } catch (err) {
      const message = err instanceof UploadValidationError ? err.message : `Could not read the file: ${(err as Error).message}`;
      setUpload({ kind: "invalid", name: file.name, message });
    }
  }, []);

  async function onSubmit() {
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
    setUpload({ kind: "empty" });
    setDocuments([]);
    setSubmit({ kind: "idle" });
    setSelected(null);
  }

  return (
    <main className="relative flex min-h-dvh flex-col lg:block lg:h-dvh lg:overflow-hidden">
      {/* Map: full-bleed on desktop, top half on small screens */}
      <div className="relative h-[46dvh] lg:absolute lg:inset-0 lg:h-auto">
        <UploadPreviewMap
          features={parsed?.features ?? null}
          labels={parsed?.features.map(featureLabel) ?? []}
          hovered={hovered}
          selected={selected}
          onSelect={setSelected}
          appended={done}
        />
      </div>

      {/* Top bar */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex items-start justify-between gap-3 p-3 sm:p-4">
        <div className="glass pointer-events-auto flex items-center gap-3 rounded-2xl py-2 pl-2 pr-4">
          <BrandMark className="size-9" />
          <div className="leading-tight">
            <p className="text-sm font-semibold">Physical Plans</p>
            <p className="flex items-center gap-1 text-[11px] text-slate-400">
              <IconLayers width={12} height={12} /> {layer.name} · {portalHost}
            </p>
          </div>
        </div>
        <div className="glass pointer-events-auto flex items-center gap-2 rounded-2xl py-1.5 pl-1.5 pr-1.5">
          <span className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-sky/80 to-hill/80 text-xs font-bold">
            {initials(user.fullName)}
          </span>
          <span className="hidden pr-1 text-sm leading-tight sm:block">
            <span className="block font-medium">{user.fullName}</span>
            <span className="block font-mono text-[10px] text-slate-400">{user.username}</span>
          </span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" title="Sign out" className="grid size-8 place-items-center rounded-xl text-slate-300 hover:bg-white/10 hover:text-white">
              <IconLogout width={17} height={17} />
            </button>
          </form>
        </div>
      </header>

      {/* Upload panel */}
      <aside className="glass relative z-[999] flex flex-col rounded-t-3xl lg:absolute lg:bottom-4 lg:left-4 lg:top-[84px] lg:w-[420px] lg:rounded-3xl">
        <div className="scroll-slim flex-1 space-y-6 overflow-y-auto p-5 sm:p-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Upload a plan</h1>
            <p className="mt-0.5 text-[13px] text-slate-400">Each polygon is appended to {layer.name} with its own attributes.</p>
          </div>

          {/* Step 1: file */}
          <Step n={1} title="Plan file" done={!!parsed}>
            {upload.kind === "valid" ? (
              <FileChip name={upload.file.name} size={upload.file.size} onRemove={done ? undefined : reset} />
            ) : (
              <DropZone
                accept=".zip,.geojson,.json"
                onFiles={(files) => files[0] && loadFile(files[0])}
                icon={upload.kind === "reading" ? <IconSpinner /> : <IconUpload />}
                title={upload.kind === "reading" ? `Reading ${upload.name}…` : "Drop a Shapefile or GeoJSON"}
                hint="Zipped .shp + .shx + .dbf + .prj, or .geojson · click to browse"
                inputId="file"
              />
            )}
            {upload.kind === "invalid" && (
              <Callout tone="red" title={`${upload.name} can't be used`}>
                {upload.message}
              </Callout>
            )}
          </Step>

          {parsed && mapping && (
            <div className="animate-rise space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <Stat value={count.toLocaleString()} label={count === 1 ? "record" : "records"} accent />
                <Stat value={totalHa >= 100 ? totalHa.toFixed(0) : totalHa.toFixed(2)} label="hectares" />
                <Stat value={parsed.vertexCount.toLocaleString()} label="vertices" />
              </div>

              <div className="space-y-2.5 rounded-2xl border border-line bg-ink-950/40 p-3.5">
                <ChipRow label="Copied from the file" names={mapping.matched.map((m) => m.layerField.name)} tone="green" empty="No file fields match the layer" />
                {autoFilled.length > 0 && <ChipRow label="Filled automatically" names={autoFilled} tone="sky" />}
                {mapping.ignored.length > 0 && <ChipRow label="Not in the layer, ignored" names={mapping.ignored} tone="muted" />}
              </div>

              <ul className="scroll-slim max-h-48 space-y-1 overflow-y-auto pr-1" onMouseLeave={() => setHovered(null)}>
                {parsed.features.map((f, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onMouseEnter={() => setHovered(i)}
                      onClick={() => setSelected(i)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition ${
                        selected === i ? "bg-plan/15 ring-1 ring-plan/40" : "hover:bg-white/5"
                      }`}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-plan/15 font-mono text-[10px] text-plan">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-200">{featureLabel(f, i)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-slate-500">{formatArea(f.areaSqMeters)}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {parsed.warnings.length > 0 && (
                <Callout tone="amber" title="Notes">
                  {parsed.warnings.map((w) => (
                    <span key={w} className="block">
                      {w}
                    </span>
                  ))}
                </Callout>
              )}
            </div>
          )}

          {/* Step 2: attachments */}
          <Step n={2} title="Attachments" done={documents.length > 0} optional>
            {!layer.hasAttachments ? (
              <div className="flex gap-3 rounded-2xl border border-dashed border-white/10 p-4 text-[13px] text-slate-400">
                <IconLock className="mt-0.5 shrink-0 text-slate-500" width={18} height={18} />
                <span>
                  Attachments are turned off on <b className="font-medium text-slate-300">{layer.name}</b>. The layer owner can enable them in the item
                  settings.
                </span>
              </div>
            ) : (
              <>
                <DropZone
                  accept=".pdf,application/pdf"
                  multiple
                  compact
                  disabled={done}
                  onFiles={(files) => setDocuments((prev) => [...prev, ...files.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))])}
                  icon={<IconPaperclip />}
                  title="Add PDF documents"
                  hint={count > 1 ? `Attached to all ${count} records` : "Drop or click to browse"}
                  inputId="documents"
                />
                {documents.map((d) => (
                  <FileChip
                    key={`${d.name}-${d.size}`}
                    name={d.name}
                    size={d.size}
                    onRemove={done ? undefined : () => setDocuments((prev) => prev.filter((p) => p !== d))}
                  />
                ))}
              </>
            )}
          </Step>

          <div ref={outcomeRef} className="scroll-mb-4">
          {submit.kind === "success" && (
            <div className="animate-rise rounded-2xl border border-hill/30 bg-hill/10 p-4" role="status">
              <div className="flex items-center gap-3">
                <span className="grid size-10 animate-pop place-items-center rounded-full bg-hill text-white">
                  <IconCheck width={22} height={22} />
                </span>
                <div>
                  <p className="font-semibold">
                    {submit.result.objectIds.length} record{submit.result.objectIds.length === 1 ? "" : "s"} appended
                  </p>
                  <p className="text-[13px] text-slate-300">
                    to {submit.result.layerName}
                    {submit.result.attachmentsPerFeature > 0 && ` · ${submit.result.attachmentsPerFeature} PDF each`}
                  </p>
                </div>
              </div>
              <p className="mt-3 font-mono text-[11px] leading-5 text-slate-400">OBJECTID {submit.result.objectIds.join(", ")}</p>
            </div>
          )}
          {submit.kind === "error" && (
            <Callout tone="red" title="Nothing was appended">
              {submit.failure.error}
              {submit.failure.signInRequired && (
                <a href="/api/auth/login" className="mt-2 block font-semibold underline">
                  Sign in again
                </a>
              )}
              {submit.failure.requestId && <span className="mt-2 block font-mono text-[10px] opacity-70">ref {submit.failure.requestId}</span>}
            </Callout>
          )}
          </div>
        </div>

        {/* Action bar */}
        <div className="border-t border-line p-4 sm:px-6">
          {done ? (
            <button type="button" onClick={reset} className="h-12 w-full rounded-xl border border-white/15 text-sm font-semibold hover:bg-white/5">
              Upload another plan
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              className="btn-primary relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {submit.kind === "submitting" && <span className="shimmer absolute inset-0" aria-hidden />}
              {submit.kind === "submitting" ? <IconSpinner width={18} height={18} /> : <IconUpload width={18} height={18} />}
              {submit.kind === "submitting" ? "Appending…" : count > 0 ? `Submit ${count} record${count === 1 ? "" : "s"}` : "Submit"}
            </button>
          )}
        </div>
      </aside>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------

function Step({ n, title, done, optional, children }: { n: number; title: string; done?: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={`grid size-6 place-items-center rounded-full font-mono text-[11px] transition ${
            done ? "bg-hill text-white" : "bg-white/10 text-slate-300"
          }`}
        >
          {done ? <IconCheck width={14} height={14} /> : n}
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {optional && <span className="text-[11px] text-slate-500">optional</span>}
      </div>
      {children}
    </section>
  );
}

function DropZone(props: {
  accept: string;
  multiple?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  icon: ReactNode;
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
      className={`group flex cursor-pointer items-center gap-4 rounded-2xl border border-dashed transition ${
        props.compact ? "p-3.5" : "p-5"
      } ${over ? "border-sky bg-sky/10" : "border-white/15 bg-white/[0.02] hover:border-sky/60 hover:bg-sky/5"} ${
        props.disabled ? "pointer-events-none opacity-40" : ""
      }`}
    >
      <span
        className={`grid shrink-0 place-items-center rounded-xl bg-sky/15 text-sky transition group-hover:scale-105 ${
          props.compact ? "size-10" : "size-12"
        }`}
      >
        {props.icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-100">{props.title}</span>
        <span className="block text-xs text-slate-400">{props.hint}</span>
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

function FileChip({ name, size, onRemove }: { name: string; size: number; onRemove?: () => void }) {
  return (
    <div className="flex animate-rise items-center gap-3 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/5 text-slate-300">
        {name.toLowerCase().endsWith(".pdf") ? <IconFile width={18} height={18} /> : <IconPolygon width={18} height={18} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block font-mono text-[11px] text-slate-500">{formatSize(size)}</span>
      </span>
      {onRemove && (
        <button type="button" onClick={onRemove} title="Remove" className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white">
          <IconX width={16} height={16} />
        </button>
      )}
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-3 ${accent ? "border-plan/30 bg-plan/10" : "border-line bg-white/[0.03]"}`}>
      <p className={`font-mono text-xl font-semibold tracking-tight ${accent ? "text-plan" : "text-white"}`}>{value}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  );
}

const CHIP_TONES = {
  green: "bg-hill/15 text-emerald-300 ring-hill/30",
  sky: "bg-sky/15 text-sky-300 ring-sky/30",
  muted: "bg-white/5 text-slate-400 ring-white/10 line-through decoration-slate-600",
} as const;

function ChipRow({ label, names, tone, empty }: { label: string; names: string[]; tone: keyof typeof CHIP_TONES; empty?: string }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0 && empty && <span className="text-xs text-amber-300">{empty}</span>}
        {names.map((n) => (
          <span key={n} className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ${CHIP_TONES[tone]}`}>
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function Callout({ tone, title, children }: { tone: "red" | "amber"; title: string; children: ReactNode }) {
  const tones = { red: "border-red-400/25 bg-red-500/10 text-red-100", amber: "border-amber-400/25 bg-amber-400/10 text-amber-100" };
  return (
    <div className={`flex animate-rise gap-3 rounded-2xl border p-3.5 text-[13px] leading-5 ${tones[tone]}`} role={tone === "red" ? "alert" : undefined}>
      <IconAlert className="mt-0.5 shrink-0" width={16} height={16} />
      <div>
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5 opacity-90">{children}</div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function formatArea(m2: number): string {
  return m2 >= 10_000 ? `${(m2 / 10_000).toFixed(2)} ha` : `${Math.round(m2).toLocaleString()} m²`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
