"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { MapSettings } from "@/lib/arcgis/config";
import type { UploadFeature } from "@/lib/geo/parse-upload";
import type { Submission } from "@/lib/plans/submissions";
import AppHeader, { type HeaderTab } from "./AppHeader";
import { DropZone, FileRow, formatSize } from "./FileInputs";
import StatusTag, { formatDateTime } from "./StatusTag";
import { Block, DocumentLink } from "./SubmissionsView";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#eef2f5]" />,
});

export type ReviewView = "waiting" | "returned" | "approved";

const VIEWS: { view: ReviewView; label: string; empty: string }[] = [
  { view: "waiting", label: "To review", empty: "Nothing to review." },
  { view: "returned", label: "Returned", empty: "No submissions are waiting for a revised plan." },
  { view: "approved", label: "Approved", empty: "No approved submissions yet." },
];

/** Partly approved submissions still need a decision on their other parcels. */
function inView(s: Submission, view: ReviewView): boolean {
  return view === "waiting" ? s.status === "waiting" || s.status === "partly_approved" : s.status === view;
}

const NO_SKIPS: ReadonlySet<number> = new Set();
const keyOf = (s: Submission) => `${s.planner}|${s.submittedAt}`;

type Sending = { kind: "idle" } | { kind: "sending"; decision: "approve" | "return" } | { kind: "error"; message: string };

export default function ReviewWorkspace({
  submissions,
  view,
  plannerNames,
  fullName,
  map,
  maxRequestBytes,
  maxCommentLength,
  canAttach,
}: {
  submissions: Submission[];
  view: ReviewView;
  plannerNames: Record<string, string>;
  fullName: string;
  map: MapSettings;
  maxRequestBytes: number;
  maxCommentLength: number;
  canAttach: boolean;
}) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The latest state of submissions decided in this page, until the server list catches up.
  const [decided, setDecided] = useState<Record<string, Submission>>({});
  const [parcels, setParcels] = useState<UploadFeature[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [documents, setDocuments] = useState<File[]>([]);
  const [sending, setSending] = useState<Sending>({ kind: "idle" });

  const list = useMemo(() => {
    const shown = submissions.filter((s) => inView(s, view));
    // The review queue is first come, first served; the other lists show the latest first.
    return view === "waiting" ? [...shown].reverse() : shown;
  }, [submissions, view]);
  const listed = submissions.find((s) => keyOf(s) === openKey) ?? null;
  const open = (openKey && decided[openKey]) || listed;
  const justDecided = !!openKey && !!decided[openKey];

  const tabs: HeaderTab[] = VIEWS.map(({ view: v, label }) => ({
    href: v === "waiting" ? "/" : `/?view=${v}`,
    label,
    active: v === view,
    count: v === "waiting" ? submissions.filter((s) => inView(s, "waiting")).length : undefined,
  }));

  const objectIds = open?.objectIds.join(",");
  useEffect(() => {
    setParcels(null);
    setSelected(null);
    if (!objectIds) return;
    let cancelled = false;
    fetch(`/api/plans/mine/parcels?oids=${objectIds}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; features?: { properties: Record<string, unknown>; geometry: UploadFeature["geometry"] }[] }) => {
        if (cancelled || !json.ok || !json.features) return;
        setParcels(json.features.map((f) => ({ geometry: f.geometry, properties: f.properties, vertexCount: 0, areaSqMeters: 0 })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [objectIds]);

  function openSubmission(key: string | null) {
    setOpenKey(key);
    setComment("");
    setDocuments([]);
    setSending({ kind: "idle" });
  }

  const totalBytes = documents.reduce((n, d) => n + d.size, 0);
  const tooLarge = totalBytes + 32 * 1024 > maxRequestBytes;
  const tooLong = comment.trim().length > maxCommentLength;
  const canDecide = !!open && open.status !== "approved" && !justDecided && sending.kind !== "sending" && !tooLarge && !tooLong;

  async function decide(decision: "approve" | "return") {
    if (!open || !canDecide) return;
    const body = new FormData();
    body.set("planner", open.planner);
    body.set("submittedAt", String(open.submittedAt));
    body.set("decision", decision);
    body.set("comment", comment.trim());
    for (const doc of documents) body.append("documents", doc, doc.name);
    setSending({ kind: "sending", decision });
    try {
      const response = await fetch("/api/review/decision", { method: "POST", body });
      const json = (await response.json().catch(() => null)) as { ok: boolean; error?: string; submission?: Submission; signInRequired?: boolean } | null;
      if (json?.signInRequired) {
        window.location.assign("/");
        return;
      }
      if (!json?.ok || !json.submission) {
        setSending({ kind: "error", message: json?.error ?? `Server error (HTTP ${response.status}).` });
        return;
      }
      setDecided((prev) => ({ ...prev, [keyOf(json.submission!)]: json.submission! }));
      setSending({ kind: "idle" });
      setComment("");
      setDocuments([]);
      router.refresh();
    } catch (err) {
      setSending({ kind: "error", message: `Network error: ${(err as Error).message}` });
    }
  }

  const planner = (s: Submission) => plannerNames[s.planner] ?? s.planner;
  const errors = [
    ...(tooLong ? [`The comment is too long (${comment.trim().length}/${maxCommentLength} characters).`] : []),
    ...(tooLarge ? [`Files too large: ${formatSize(totalBytes)} (max ${formatSize(maxRequestBytes)}).`] : []),
    ...(sending.kind === "error" ? [sending.message] : []),
  ];

  return (
    <div className="flex h-dvh flex-col bg-white">
      <AppHeader title="Physical Plan Review" tabs={tabs} fullName={fullName} />

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="relative z-[1000] flex min-h-0 flex-1 flex-col bg-paper lg:w-[360px] lg:flex-none">
          <div className="scroll-slim flex-1 overflow-y-auto">
            {!open && (
              <>
                <h1 className="px-5 pt-5 pb-3 text-[16px] text-ink">{VIEWS.find((v) => v.view === view)!.label}</h1>
                {list.length === 0 ? (
                  <p className="px-5 text-[14px] text-graphite">{VIEWS.find((v) => v.view === view)!.empty}</p>
                ) : (
                  <ul className="border-t border-hairline">
                    {list.map((s) => (
                      <li key={keyOf(s)} className="border-b border-hairline">
                        <button type="button" onClick={() => openSubmission(keyOf(s))} className="w-full px-5 py-3.5 text-left transition hover:bg-mist">
                          <span className="flex items-start justify-between gap-3">
                            <span className="min-w-0 truncate text-[15px] text-ink">{planner(s)}</span>
                            <StatusTag submission={s} audience="reviewer" />
                          </span>
                          <span className="mt-1.5 block text-[12px] text-graphite">
                            {formatDateTime(s.submittedAt)} · {s.objectIds.length} parcel{s.objectIds.length === 1 ? "" : "s"}
                            {s.districts.length > 0 && ` · ${s.districts.join(", ")}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {open && (
              <div className="fade-in space-y-6 p-5">
                <button type="button" onClick={() => openSubmission(null)} className="text-[13px] text-nla hover:underline">
                  ← {VIEWS.find((v) => v.view === view)!.label}
                </button>

                <div>
                  <h1 className="text-[18px] text-ink">{planner(open)}</h1>
                  <p className="mt-0.5 text-[13px] text-graphite">
                    {formatDateTime(open.submittedAt)} · {open.objectIds.length} parcel{open.objectIds.length === 1 ? "" : "s"}
                    {open.districts.length > 0 && ` · ${open.districts.join(", ")}`}
                  </p>
                  <div className="mt-3">
                    <StatusTag submission={open} audience="reviewer" large />
                  </div>
                </div>

                {justDecided && (
                  <div className="fade-in border-l-[3px] border-ok bg-[#eef7f1] px-3 py-3" role="status">
                    <p className="text-[15px] text-ink">{open.status === "approved" ? "Approved" : "Returned to the planner"}</p>
                  </div>
                )}

                <Block title="Planner's documents">
                  {open.ownDocuments.length > 0 ? (
                    open.ownDocuments.map((d) => <DocumentLink key={`${d.objectId}-${d.attachmentId}`} doc={d} />)
                  ) : (
                    <p className="text-[14px] text-graphite">None.</p>
                  )}
                </Block>

                {(open.comments.length > 0 || open.nlaDocuments.length > 0) && (
                  <Block title="NLA response">
                    {open.comments.map((c) => (
                      <p key={c} className="border-l-[3px] border-nla bg-mist px-3 py-2 text-[14px] leading-6 text-ink">
                        {c}
                      </p>
                    ))}
                    {open.nlaDocuments.map((d) => (
                      <DocumentLink key={`${d.objectId}-${d.attachmentId}`} doc={d} muted />
                    ))}
                  </Block>
                )}

                {open.status !== "approved" && !justDecided && (
                  <>
                    <Block title="Comment for the planner">
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={5}
                        placeholder={open.status === "returned" ? "Already returned. A new comment replaces the current one." : undefined}
                        className="w-full resize-y rounded-lg border border-[#dfe5ea] bg-white px-3 py-2 text-[14px] leading-6 text-ink outline-none transition focus:border-nla focus:shadow-[0_0_0_1px_var(--color-nla)]"
                      />
                    </Block>
                    {canAttach && (
                      <Block title="Documents for the planner">
                        <DropZone accept=".pdf,application/pdf" multiple onFiles={(files) => setDocuments((prev) => addUnique(prev, files))} label="Drop PDF" hint="optional" />
                        {documents.map((d) => (
                          <FileRow key={`${d.name}-${d.size}`} name={d.name} size={d.size} onRemove={() => setDocuments((prev) => prev.filter((p) => p !== d))} />
                        ))}
                      </Block>
                    )}
                  </>
                )}

                {errors.length > 0 && (
                  <ul className="fade-in space-y-1.5" role="alert">
                    {errors.map((e) => (
                      <li key={e} className="border-l-[3px] border-alert bg-[#fdf1f1] px-3 py-2 text-[13px] leading-5 text-[#7a1c1c]">
                        {e}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {open && open.status !== "approved" && !justDecided && (
            <div className="relative grid grid-cols-2 gap-3 border-t border-hairline p-5">
              {sending.kind === "sending" && <span className="progress-bar absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden />}
              <button
                type="button"
                onClick={() => decide("return")}
                disabled={!canDecide || !comment.trim()}
                title={comment.trim() ? undefined : "Write a comment first"}
                className="h-11 rounded-lg border border-nla text-[15px] text-nla transition enabled:hover:bg-nla enabled:hover:text-white disabled:cursor-not-allowed disabled:border-[#cfcfcf] disabled:text-[#9a9a9a]"
              >
                {sending.kind === "sending" && sending.decision === "return" ? "Returning…" : "Return"}
              </button>
              <button
                type="button"
                onClick={() => decide("approve")}
                disabled={!canDecide}
                className="h-11 rounded-lg bg-nla font-semibold text-[15px] text-white transition hover:bg-[#096a97] disabled:cursor-not-allowed disabled:bg-[#dfe5ea]"
              >
                {sending.kind === "sending" && sending.decision === "approve" ? "Approving…" : "Approve"}
              </button>
            </div>
          )}
        </aside>

        <div className="relative h-[45dvh] shrink-0 lg:h-auto lg:flex-1">
          <UploadPreviewMap
            map={map}
            features={parcels}
            labels={parcels?.map((p, i) => String(p.properties.parcel_upi ?? `Parcel ${i + 1}`)) ?? []}
            hovered={null}
            selected={selected}
            onSelect={setSelected}
            appended={open?.status === "approved"}
            skipped={NO_SKIPS}
          />
        </div>
      </div>
    </div>
  );
}

function addUnique(existing: File[], added: File[]): File[] {
  return [...existing, ...added.filter((f) => !existing.some((p) => p.name === f.name && p.size === f.size))];
}
