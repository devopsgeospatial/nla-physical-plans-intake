"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { MapSettings } from "@/lib/arcgis/config";
import type { UploadFeature } from "@/lib/geo/parse-upload";
import type { Submission, SubmissionDocument, SubmissionStatus } from "@/lib/plans/my-submissions";
import AppHeader from "./AppHeader";

const UploadPreviewMap = dynamic(() => import("./UploadPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#1a1a1a]" />,
});

const NO_SKIPS: ReadonlySet<number> = new Set();

const STATUS: Record<SubmissionStatus, { label: string; className: string }> = {
  waiting: { label: "Waiting for NLA", className: "bg-[#ececec] text-graphite" },
  responded: { label: "NLA responded", className: "bg-nla-tint text-nla" },
  partly_approved: { label: "Partly approved", className: "bg-[#fff3d6] text-warn" },
  approved: { label: "Approved", className: "bg-[#e3f3e8] text-ok" },
};

export default function SubmissionsView({
  submissions,
  error,
  fullName,
  map,
}: {
  submissions: Submission[];
  error: string | null;
  fullName: string;
  map: MapSettings;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [parcels, setParcels] = useState<UploadFeature[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const open = submissions.find((s) => s.submittedAt === openId) ?? null;

  // Load the parcels of the open submission for the map.
  useEffect(() => {
    setParcels(null);
    setSelected(null);
    if (!open) return;
    let cancelled = false;
    fetch(`/api/plans/mine/parcels?oids=${open.objectIds.join(",")}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; features?: { properties: Record<string, unknown>; geometry: UploadFeature["geometry"] }[] }) => {
        if (cancelled || !json.ok || !json.features) return;
        setParcels(json.features.map((f) => ({ geometry: f.geometry, properties: f.properties, vertexCount: 0, areaSqMeters: 0 })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div className="flex h-dvh flex-col bg-night">
      <AppHeader active="submissions" fullName={fullName} />

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="relative z-[1000] flex min-h-0 flex-1 flex-col bg-paper lg:w-[360px] lg:flex-none">
          <div className="scroll-slim flex-1 overflow-y-auto">
            {error && <p className="m-5 border-l-[3px] border-alert bg-[#fdf1f1] px-3 py-2 text-[13px] text-[#7a1c1c]">{error}</p>}

            {!error && !open && (
              <>
                <h1 className="px-5 pt-5 pb-3 text-[16px] text-ink">My submissions</h1>
                {submissions.length === 0 ? (
                  <p className="px-5 text-[14px] text-graphite">No submissions yet.</p>
                ) : (
                  <ul className="border-t border-hairline">
                    {submissions.map((s) => (
                      <li key={s.submittedAt} className="border-b border-hairline">
                        <button type="button" onClick={() => setOpenId(s.submittedAt)} className="w-full px-5 py-3.5 text-left transition hover:bg-mist">
                          <span className="flex items-start justify-between gap-3">
                            <span className="min-w-0 truncate text-[15px] text-ink">{formatDateTime(s.submittedAt)}</span>
                            <StatusTag submission={s} />
                          </span>
                          <span className="mt-1.5 block text-[12px] text-graphite">
                            {s.objectIds.length} parcel{s.objectIds.length === 1 ? "" : "s"}
                            {s.districts.length > 0 && ` · ${s.districts.join(", ")}`}
                            {s.nlaDocuments.length > 0 && (
                              <span className="text-nla">
                                {" "}
                                · {s.nlaDocuments.length} document{s.nlaDocuments.length === 1 ? "" : "s"} from NLA
                              </span>
                            )}
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
                <button type="button" onClick={() => setOpenId(null)} className="text-[13px] text-nla hover:underline">
                  ← My submissions
                </button>

                <div>
                  <h1 className="text-[18px] text-ink">{formatDateTime(open.submittedAt)}</h1>
                  <p className="mt-0.5 text-[13px] text-graphite">
                    {open.objectIds.length} parcel{open.objectIds.length === 1 ? "" : "s"}
                    {open.districts.length > 0 && ` · ${open.districts.join(", ")}`}
                  </p>
                  <div className="mt-3">
                    <StatusTag submission={open} large />
                  </div>
                </div>

                <Block title="NLA response">
                  {open.comments.length > 0 ? (
                    open.comments.map((c) => (
                      <p key={c} className="border-l-[3px] border-nla bg-mist px-3 py-2 text-[14px] leading-6 text-ink">
                        {c}
                      </p>
                    ))
                  ) : (
                    <p className="text-[14px] text-graphite">{open.status === "approved" ? "Approved without comment." : "No response yet."}</p>
                  )}
                </Block>

                <Block title="Documents from NLA">
                  {open.nlaDocuments.length > 0 ? (
                    open.nlaDocuments.map((d) => <DocumentLink key={`${d.objectId}-${d.attachmentId}`} doc={d} />)
                  ) : (
                    <p className="text-[14px] text-graphite">None yet.</p>
                  )}
                </Block>

                {open.ownDocuments.length > 0 && (
                  <Block title="Your documents">
                    {open.ownDocuments.map((d) => (
                      <DocumentLink key={`${d.objectId}-${d.attachmentId}`} doc={d} muted />
                    ))}
                  </Block>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-hairline p-5">
            <a href="/submissions" className="flex h-11 w-full items-center justify-center border border-nla text-[15px] text-nla transition hover:bg-nla hover:text-white">
              Refresh
            </a>
          </div>
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

function StatusTag({ submission, large }: { submission: Submission; large?: boolean }) {
  const s = STATUS[submission.status];
  const detail =
    submission.status === "partly_approved"
      ? ` ${submission.approvedCount}/${submission.objectIds.length}`
      : submission.status === "approved" && submission.approvedAt && large
        ? ` · ${formatDate(submission.approvedAt)}`
        : "";
  return (
    <span className={`inline-block shrink-0 whitespace-nowrap px-2 py-0.5 ${large ? "text-[13px]" : "text-[11px]"} ${s.className}`}>
      {s.label}
      {detail}
    </span>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[13px] text-graphite">{title}</h2>
      {children}
    </section>
  );
}

function DocumentLink({ doc, muted }: { doc: SubmissionDocument; muted?: boolean }) {
  const href = `/api/plans/attachment?oid=${doc.objectId}&aid=${doc.attachmentId}&name=${encodeURIComponent(doc.name)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center justify-between gap-3 px-3 py-2.5 transition ${muted ? "bg-mist hover:bg-[#ececec]" : "bg-nla-tint hover:bg-[#dcebf5]"}`}
    >
      <span className="min-w-0">
        <span className={`block truncate text-[14px] ${muted ? "text-ink" : "text-nla"}`}>{doc.name}</span>
        {doc.size !== null && <span className="block text-[12px] text-graphite">{formatSize(doc.size)}</span>}
      </span>
      <span className={`shrink-0 text-[13px] ${muted ? "text-graphite" : "text-nla"}`}>Open</span>
    </a>
  );
}

const KIGALI = "Africa/Kigali";

function formatDateTime(ms: number): string {
  if (!ms) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: KIGALI }).format(ms);
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: KIGALI }).format(ms);
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
