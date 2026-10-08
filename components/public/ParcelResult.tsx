"use client";

import { useState } from "react";
import type { ParcelReport, PlanZone } from "@/lib/public/parcel-lookup";
import { STAGES } from "@/lib/public/stages";

const STATUS = {
  within: { band: "bg-[#0b7fb5] text-white", title: "Within the approved physical plan" },
  partly: { band: "bg-[#eaf6fc] text-[#0b5f8a]", title: "Partly within the approved physical plan" },
  outside: { band: "bg-[#f1f4f6] text-[#33414c]", title: "Not covered by an approved physical plan" },
} as const;

const KIGALI = "Africa/Kigali";
const NO_COLOR = "#9a9a9a";

/** What a citizen learns about one parcel: coverage by the approved plan, zone by zone, with the plan's stage. */
export default function ParcelResult({
  parcel,
  districtName,
  colorOf,
  onClear,
}: {
  parcel: ParcelReport;
  districtName: string;
  colorOf: (zoning: string | null) => string | undefined;
  onClear: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const status = STATUS[parcel.coverage];
  const place = [parcel.village && `${parcel.village} village`, parcel.cell && `${parcel.cell} cell`, parcel.sector && `${parcel.sector} sector`].filter(Boolean).join(" · ");
  const color = (z: PlanZone) => colorOf(z.zoning) ?? NO_COLOR;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <article className="pp-swap overflow-hidden rounded-xl border border-[#e6ebef] bg-white shadow-[0_1px_3px_rgba(16,40,60,0.06)]">
      <div className={`flex items-start gap-3 px-4 py-3.5 ${status.band}`}>
        <StatusIcon coverage={parcel.coverage} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-5 font-semibold">{status.title}</p>
          {parcel.coverage === "partly" && <p className="mt-0.5 text-[13px] opacity-80">{formatPct(parcel.coveredPct)} of the parcel</p>}
        </div>
        <button type="button" onClick={onClear} aria-label="Clear the search" className="-mr-1 text-[20px] leading-none opacity-70 transition hover:opacity-100">
          ×
        </button>
      </div>

      <div className="space-y-5 px-4 pt-4 pb-3">
        {parcel.upi ? (
          <div>
            <p className="text-[11px] tracking-[0.08em] text-[#6b7c8a] uppercase">Parcel</p>
            <p className="mt-0.5 text-[22px] leading-tight text-[#14212b] tabular-nums">{parcel.upi}</p>
            <p className="mt-1 text-[13px] leading-5 text-[#51626f]">{place || `${districtName} District`}</p>
            <p className="text-[13px] text-[#51626f]">{formatArea(parcel.areaSqm)}</p>
          </div>
        ) : (
          <div>
            <p className="text-[11px] tracking-[0.08em] text-[#6b7c8a] uppercase">Place you tapped</p>
            <p className="mt-0.5 text-[18px] leading-snug text-[#14212b]">{place || `${districtName} District`}</p>
            <p className="mt-1 text-[12px] leading-5 text-[#6b7c8a]">To check a parcel of your own, search it by the UPI on its land title.</p>
          </div>
        )}

        {parcel.zones.length > 0 ? (
          <div>
            <p className="text-[11px] tracking-[0.08em] text-[#6b7c8a] uppercase">Zoning</p>
            <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-[#e9eef2]" aria-hidden>
              {parcel.zones.map((z, i) => (
                <span key={i} style={{ width: `${z.sharePct}%`, background: color(z) }} />
              ))}
            </div>
            <ul className="mt-3 space-y-3.5">
              {parcel.zones.map((z, i) => {
                const { code, name } = splitZoning(z);
                return (
                  <li key={i} className="flex gap-3">
                    <span className="mt-1 size-3.5 shrink-0 rounded-[3px]" style={{ background: color(z) }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-5 text-[#14212b]">
                        {code && <span className="mr-1.5 rounded bg-[#eaf6fc] px-1.5 py-px text-[11px] font-semibold text-[#0b7fb5]">{code}</span>}
                        {name}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[#51626f]">
                        {formatPct(z.sharePct)} of the parcel
                        {z.approvedAt && ` · approved ${formatDate(z.approvedAt)}`}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="rounded-lg bg-[#f3f6f8] px-3 py-2.5 text-[14px] leading-6 text-[#14212b]">
            No approved physical plan covers this parcel yet. Plans appear here once the National Land Authority approves them.
          </p>
        )}

        {parcel.sites.length > 0 && (
          <div>
            <p className="text-[11px] tracking-[0.08em] text-[#6b7c8a] uppercase">Site plan</p>
            <ul className="mt-2 space-y-2">
              {parcel.sites.map((site, i) => {
                const stage = STAGES.find((s) => s.n === site.stage);
                return (
                  <li key={i} className="rounded-lg bg-[#f7fbfd] px-3 py-2.5">
                    <p className="text-[14px] font-semibold text-[#14212b]">{site.name}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-[#51626f]">
                      {site.status && (
                        <span className={`rounded-full px-2 py-0.5 ${site.status === "Completed" ? "bg-[#0b5f8a] text-white" : "bg-[#eaf6fc] text-[#0b7fb5]"}`}>{site.status}</span>
                      )}
                      {stage ? (
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ background: stage.color }} />
                          Stage {stage.n}: {stage.name}
                        </span>
                      ) : (
                        <span>Stage not recorded yet</span>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-[12px] leading-5 text-[#6b7c8a]">
          For information only. For an official zoning certificate, contact the {districtName} District One Stop Centre.
        </p>
      </div>

      {parcel.upi && (
        <div className="border-t border-[#eef2f5] px-4 py-2.5">
          <button type="button" onClick={copyLink} className="text-[13px] text-[#0b7fb5] hover:underline">
            {copied ? "Link copied" : "Copy link to this parcel"}
          </button>
        </div>
      )}
    </article>
  );
}

function StatusIcon({ coverage }: { coverage: ParcelReport["coverage"] }) {
  return (
    <svg viewBox="0 0 24 24" className="mt-0.5 size-5 shrink-0 fill-none stroke-current" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
      {coverage === "within" && <path d="M4 12.5 9 17.5 20 6.5" />}
      {coverage === "partly" && <path d="M5 12h14" />}
      {coverage === "outside" && <path d="M6 6l12 12M18 6 6 18" />}
    </svg>
  );
}

function splitZoning(zone: PlanZone): { code: string | null; name: string } {
  const zoning = zone.zoning ?? zone.zoneCode ?? "Zone";
  const code = zone.zoneCode;
  if (code && zoning.toUpperCase().startsWith(code.toUpperCase())) {
    const rest = zoning.slice(code.length).replace(/^\s*[-–:]\s*/, "").replace(/\s-\s/g, " – ");
    return { code, name: rest || zoning };
  }
  return { code, name: zoning.replace(/\s-\s/g, " – ") };
}

function formatPct(pct: number): string {
  return pct >= 99.5 ? "All" : `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function formatArea(sqm: number): string {
  const m2 = `${Math.round(sqm).toLocaleString("en-GB")} m²`;
  return sqm >= 10_000 ? `${m2} · ${(sqm / 10_000).toFixed(2)} ha` : m2;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: KIGALI }).format(ms);
}
