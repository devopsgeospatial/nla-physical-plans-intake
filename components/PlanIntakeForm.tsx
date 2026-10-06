"use client";

import dynamic from "next/dynamic";
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { BoundaryValidationError, parseBoundaryFile, type ParsedBoundary } from "@/lib/geo/parse-boundary";
import { DISTRICTS, PLAN_NAME_MAX_LENGTH, PLAN_TYPES } from "@/lib/plan-options";

const BoundaryPreviewMap = dynamic(() => import("./BoundaryPreviewMap"), {
  ssr: false,
  loading: () => <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-slate-500">Loading map…</div>,
});

interface SubmitSuccess {
  ok: true;
  requestId: string;
  objectId: number;
  globalId: string | null;
  featureUrl: string;
  attributes: Record<string, string | number>;
  geometry: { spatialReference: { wkid?: number; latestWkid?: number; wkt?: string }; ringCount: number; areaSqMeters: number };
  attachments: { attachmentId: number; fileName: string; size: number }[];
  warnings: string[];
}

interface SubmitFailure {
  ok: false;
  signInRequired?: boolean;
  requestId?: string;
  error: string;
  field?: string;
  objectId?: number;
  rolledBack?: boolean;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: SubmitSuccess }
  | { kind: "error"; failure: SubmitFailure };

type BoundaryState =
  | { kind: "empty" }
  | { kind: "parsing"; fileName: string }
  | { kind: "valid"; file: File; parsed: ParsedBoundary }
  | { kind: "invalid"; fileName: string; message: string };

export default function PlanIntakeForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [planName, setPlanName] = useState("");
  const [district, setDistrict] = useState("");
  const [planType, setPlanType] = useState("");
  const [boundary, setBoundary] = useState<BoundaryState>({ kind: "empty" });
  const [documents, setDocuments] = useState<File[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  async function onBoundaryChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setBoundary({ kind: "empty" });
      return;
    }
    setBoundary({ kind: "parsing", fileName: file.name });
    try {
      const parsed = await parseBoundaryFile(file.name, await file.arrayBuffer());
      setBoundary({ kind: "valid", file, parsed });
    } catch (err) {
      const message = err instanceof BoundaryValidationError ? err.message : `Could not read file: ${(err as Error).message}`;
      setBoundary({ kind: "invalid", fileName: file.name, message });
    }
  }

  function onDocumentsChange(event: ChangeEvent<HTMLInputElement>) {
    setDocuments(Array.from(event.target.files ?? []));
  }

  const canSubmit =
    planName.trim() !== "" &&
    district !== "" &&
    planType !== "" &&
    boundary.kind === "valid" &&
    documents.length > 0 &&
    submit.kind !== "submitting" &&
    submit.kind !== "success"; // one submission per form; "Start a new submission" resets it

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || boundary.kind !== "valid") return;

    const body = new FormData();
    body.set("plan_name", planName.trim());
    body.set("district", district);
    body.set("plan_type", planType);
    body.set("boundary", boundary.file, boundary.file.name);
    for (const doc of documents) body.append("documents", doc, doc.name);

    setSubmit({ kind: "submitting" });
    try {
      const response = await fetch("/api/plans/submit", { method: "POST", body });
      const json = (await response.json().catch(() => null)) as SubmitSuccess | SubmitFailure | null;
      if (!json) {
        setSubmit({ kind: "error", failure: { ok: false, error: `Server returned HTTP ${response.status} with no JSON body.` } });
      } else if (json.ok) {
        setSubmit({ kind: "success", result: json });
      } else {
        setSubmit({ kind: "error", failure: json });
      }
    } catch (err) {
      setSubmit({ kind: "error", failure: { ok: false, error: `Network error: ${(err as Error).message}` } });
    }
  }

  function resetForm() {
    formRef.current?.reset();
    setPlanName("");
    setDistrict("");
    setPlanType("");
    setBoundary({ kind: "empty" });
    setDocuments([]);
    setSubmit({ kind: "idle" });
  }

  const fieldError = submit.kind === "error" ? submit.failure.field : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <form ref={formRef} onSubmit={onSubmit} className="space-y-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm" noValidate>
        <Field label="Plan name" htmlFor="plan_name" invalid={fieldError === "plan_name"}>
          <input
            id="plan_name"
            name="plan_name"
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            maxLength={PLAN_NAME_MAX_LENGTH}
            required
            className={inputClass}
            placeholder="e.g. Riverside Mixed-Use Master Plan"
          />
        </Field>

        <Field label="District" htmlFor="district" invalid={fieldError === "district"}>
          <select id="district" name="district" value={district} onChange={(e) => setDistrict(e.target.value)} required className={inputClass}>
            <option value="" disabled>
              Select a district…
            </option>
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Plan type" htmlFor="plan_type" invalid={fieldError === "plan_type"}>
          <select id="plan_type" name="plan_type" value={planType} onChange={(e) => setPlanType(e.target.value)} required className={inputClass}>
            <option value="" disabled>
              Select a plan type…
            </option>
            {PLAN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Boundary file"
          htmlFor="boundary"
          hint="GeoJSON (.geojson / .json, WGS84) or zipped Shapefile (.zip with .shp, .shx, .dbf, .prj)"
          invalid={fieldError === "boundary" || boundary.kind === "invalid"}
        >
          <input id="boundary" name="boundary" type="file" accept=".geojson,.json,.zip,application/geo+json,application/json,application/zip" onChange={onBoundaryChange} required className={fileClass} />
          {boundary.kind === "parsing" && <p className="mt-2 text-sm text-slate-500">Reading {boundary.fileName}…</p>}
          {boundary.kind === "invalid" && <p className="mt-2 text-sm text-red-700">{boundary.message}</p>}
          {boundary.kind === "valid" && <BoundarySummary parsed={boundary.parsed} />}
        </Field>

        <Field label="Supporting documents" htmlFor="documents" hint="PDF only; you can select multiple files." invalid={fieldError === "documents"}>
          <input id="documents" name="documents" type="file" accept=".pdf,application/pdf" multiple onChange={onDocumentsChange} required className={fileClass} />
          {documents.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
              {documents.map((d) => (
                <li key={`${d.name}-${d.size}`}>
                  {d.name} <span className="text-slate-400">({formatSize(d.size)})</span>
                </li>
              ))}
            </ul>
          )}
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {submit.kind === "submitting" ? "Submitting…" : "Submit plan"}
          </button>
          {(submit.kind === "success" || submit.kind === "error") && (
            <button type="button" onClick={resetForm} className="text-sm text-slate-600 underline hover:text-slate-900">
              Start a new submission
            </button>
          )}
        </div>

        {submit.kind === "success" && <SuccessPanel result={submit.result} />}
        {submit.kind === "error" && <ErrorPanel failure={submit.failure} />}
      </form>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">Boundary preview</div>
        <div className="h-[420px] lg:h-[calc(100%-37px)]">
          <BoundaryPreviewMap geometry={boundary.kind === "valid" ? boundary.parsed.geometry : null} />
        </div>
      </section>
    </div>
  );
}

const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20";
const fileClass =
  "block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200";

function Field(props: { label: string; htmlFor: string; hint?: string; invalid?: boolean; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={props.htmlFor} className={`mb-1 block text-sm font-medium ${props.invalid ? "text-red-700" : "text-slate-800"}`}>
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="mt-1 text-xs text-slate-500">{props.hint}</p>}
    </div>
  );
}

function BoundarySummary({ parsed }: { parsed: ParsedBoundary }) {
  return (
    <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      <p>
        Valid {parsed.geometry.type} · {parsed.polygonCount} part(s) · {parsed.vertexCount.toLocaleString()} vertices ·{" "}
        {formatArea(parsed.areaSqMeters)}
      </p>
      {parsed.warnings.map((w) => (
        <p key={w} className="mt-1 text-xs text-amber-800">
          {w}
        </p>
      ))}
    </div>
  );
}

function SuccessPanel({ result }: { result: SubmitSuccess }) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
      <p className="font-medium">Plan submitted — ObjectID {result.objectId}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-emerald-700">Global ID</dt>
        <dd className="break-all">{result.globalId ?? "—"}</dd>
        <dt className="text-emerald-700">Status</dt>
        <dd>{String(result.attributes.status ?? "SUBMITTED")}</dd>
        <dt className="text-emerald-700">Stored in</dt>
        <dd>
          {describeSpatialReference(result.geometry.spatialReference)} · {result.geometry.ringCount} ring(s) ·{" "}
          {formatArea(result.geometry.areaSqMeters)}
        </dd>
        <dt className="text-emerald-700">Attachments</dt>
        <dd>{result.attachments.map((a) => `${a.fileName} (#${a.attachmentId})`).join(", ")}</dd>
      </dl>
      <p className="mt-2 text-xs text-emerald-700">Reference: {result.requestId}</p>
    </div>
  );
}

function ErrorPanel({ failure }: { failure: SubmitFailure }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
      <p className="font-medium">Submission failed</p>
      <p className="mt-1">{failure.error}</p>
      {failure.signInRequired && (
        <a href="/api/auth/login" className="mt-2 inline-block font-medium underline">
          Sign in again
        </a>
      )}
      {failure.objectId !== undefined && (
        <p className="mt-1 text-xs">
          ObjectID {failure.objectId} {failure.rolledBack ? "was rolled back." : "may need manual cleanup."}
        </p>
      )}
      {failure.requestId && <p className="mt-2 text-xs text-red-700">Reference: {failure.requestId}</p>}
    </div>
  );
}

function describeSpatialReference(sr: { wkid?: number; latestWkid?: number; wkt?: string }): string {
  const wkid = sr.latestWkid ?? sr.wkid;
  if (wkid) return `EPSG:${wkid}`;
  const wkt = sr.wkt ?? "";
  if (/Transverse_Mercator/i.test(wkt) && /Central_Meridian",30(\.0)?\]/i.test(wkt)) return "TM Rwanda (layer grid)";
  return "layer's custom coordinate system";
}

function formatArea(m2: number): string {
  return m2 >= 10_000 ? `${(m2 / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ha` : `${Math.round(m2).toLocaleString()} m²`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
