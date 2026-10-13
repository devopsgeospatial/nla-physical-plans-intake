"use client";

import { useEffect, useState, type ReactNode } from "react";
import type Basemap from "@arcgis/core/Basemap";
import type MapView from "@arcgis/core/views/MapView";
import type { ReferenceDocument } from "@/lib/public/districts";
import type { PublicDocument } from "@/lib/public/documents";
import { STAGES, stagesFor, type PlanStatus } from "@/lib/public/stages";
import type { Site } from "./PlansMap";
import { selectSites } from "@/lib/public/selection";

/** What Explore narrows the map to. */
export interface Selection {
  status: PlanStatus | null;
  /** 1–5, or 0 for sites whose stage is not recorded yet. */
  stage: number | null;
  /** One site, by key. */
  site: string | null;
  byStage: boolean;
}

/** Approved planned parcels in the whole district (inside and outside site plans). */
export interface DistrictTotals {
  parcels: number;
  hectares: number;
}

export { selectSites };

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");
const ha = (n: number) => (n >= 100 ? fmt(n) : n.toFixed(1));
const plural = (n: number, one: string, many = `${one}s`) =>
  `${fmt(n)} ${n === 1 ? one : many}`;

// ---- Insights (read only) ----------------------------------------------------------------------

export function Insights({
  sites,
  totals,
  selection,
  onOpenSite,
}: {
  sites: Site[] | null;
  totals: DistrictTotals | null;
  selection: Selection;
  onOpenSite: (key: string) => void;
}) {
  if (!totals) return <Loading />;
  const all = sites ?? [];
  const shown = selection.status
    ? all.filter((s) => s.status === selection.status)
    : all;
  const gazetted = all.filter((s) => s.stage === 5).length;
  const inSites = all.reduce((t, s) => t + s.parcels, 0);
  const outside = Math.max(0, totals.parcels - inSites);
  const notRecorded = shown.filter((s) => s.stage === null).length;
  const maxCount = Math.max(
    1,
    ...STAGES.map((st) => shown.filter((s) => s.stage === st.n).length),
    notRecorded,
  );

  return (
    <div className="pp-swap space-y-6">
      <div className="grid grid-cols-2 gap-2.5">
        <Kpi
          value={sites ? fmt(shown.length) : "…"}
          label={
            selection.status
              ? `${selection.status.toLowerCase()} sites`
              : plural(shown.length, "site").replace(/^\S+ /, "")
          }
        />
        <Kpi value={fmt(totals.parcels)} label="Planned parcels" />
        <Kpi value={ha(totals.hectares)} label="Hectares planned" />
        <Kpi
          value={sites ? fmt(gazetted) : "…"}
          label={gazetted === 1 ? "Gazetted site" : "Gazetted sites"}
        />
      </div>

      {!sites ? (
        <Loading />
      ) : (
        <>
          <div>
            <p className="mb-3 text-[13px] text-[#51626f]">Sites by stage</p>
            <div className="space-y-3">
              {stagesFor(selection.status).map((s) => {
                const n = shown.filter((x) => x.stage === s.n).length;
                return (
                  <Bar
                    key={s.n}
                    label={`${s.n}. ${s.short}`}
                    detail={plural(n, "site")}
                    pct={(n / maxCount) * 100}
                    color={s.color}
                  />
                );
              })}
              {notRecorded > 0 && (
                <Bar
                  label="Stage not recorded"
                  detail={plural(notRecorded, "site")}
                  pct={(notRecorded / maxCount) * 100}
                  color="#a8b4bd"
                />
              )}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[13px] text-[#51626f]">
              Sites in the district
            </p>
            {shown.length === 0 ? (
              <p className="text-[14px] text-[#51626f]">
                No site plans{" "}
                {selection.status
                  ? `are ${selection.status.toLowerCase()}`
                  : "are recorded"}{" "}
                here yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {shown.map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => onOpenSite(s.key)}
                      className="w-full rounded-lg border border-[#e6ebef] bg-white px-3.5 py-3 text-left transition hover:border-[#17a0db] hover:bg-[#f7fbfd]"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate text-[14px] font-semibold text-[#14212b]">
                          {s.name}
                        </span>
                        <StageChip stage={s.stage} />
                      </span>
                      <span className="mt-1 block text-[12px] text-[#6b7c8a]">
                        {plural(s.parcels, "planned parcel")} · {ha(s.hectares)}{" "}
                        ha
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {outside > 0 && (
              <p className="mt-3 text-[12px] leading-5 text-[#6b7c8a]">
                {plural(outside, "approved parcel")} in the district lie outside
                a recorded site plan.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function StageChip({ stage }: { stage: number | null }) {
  const s = STAGES.find((x) => x.n === stage);
  if (!s)
    return (
      <span className="shrink-0 rounded-full bg-[#eef2f5] px-2 py-0.5 text-[11px] text-[#51626f]">
        Stage not recorded
      </span>
    );
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#eaf6fc] px-2 py-0.5 text-[11px] font-medium text-[#0b5f8a]">
      <span className="size-2 rounded-full" style={{ background: s.color }} />
      Stage {s.n}
    </span>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-[#f3f7fa] px-3.5 py-3">
      <p className="text-[26px] leading-none font-semibold text-[#14212b] tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-[#51626f] first-letter:uppercase">
        {label}
      </p>
    </div>
  );
}

function Bar({
  label,
  detail,
  pct,
  color,
}: {
  label: string;
  detail: string;
  pct: number;
  color: string;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return (
    <div>
      <div className="mb-1 flex justify-between gap-3 text-[13px]">
        <span className="text-[#14212b]">{label}</span>
        <span className="shrink-0 text-[#6b7c8a]">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#e9eef2]">
        <span
          className="block h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${width}%`, background: color }}
        />
      </div>
    </div>
  );
}

// ---- Explore (interacts with the map) ----------------------------------------------------------

export function Explore({
  sites,
  selection,
  onChange,
}: {
  sites: Site[] | null;
  selection: Selection;
  onChange: (next: Partial<Selection>) => void;
}) {
  if (!sites) return <Loading />;
  const stages = stagesFor(selection.status);
  const inStatus = selection.status
    ? sites.filter((s) => s.status === selection.status)
    : sites;
  const count = (stage: number | null) =>
    inStatus.filter((s) => s.stage === stage).length;
  const choosable = selectSites(sites, { ...selection, site: null }) ?? sites;

  return (
    <div className="pp-swap space-y-6">
      <Field label="Status">
        <div className="grid grid-cols-3 rounded-lg bg-[#eef3f6] p-1">
          {([null, "Ongoing", "Completed"] as (PlanStatus | null)[]).map(
            (s) => (
              <button
                key={s ?? "all"}
                type="button"
                onClick={() => onChange({ status: s, stage: null, site: null })}
                className={`h-9 rounded-md text-[13px] transition ${selection.status === s ? "bg-white font-semibold text-[#14212b] shadow-[0_1px_3px_rgba(16,40,60,0.15)]" : "text-[#51626f] hover:text-[#14212b]"}`}
              >
                {s ?? "All"}
              </button>
            ),
          )}
        </div>
      </Field>

      <Field
        label={
          selection.status
            ? `Stages of ${selection.status.toLowerCase()} sites`
            : "Stage"
        }
      >
        <ol className="space-y-1">
          {stages.map((s) => (
            <StageRow
              key={s.n}
              on={selection.stage === s.n}
              color={s.color}
              badge={String(s.n)}
              light={s.n <= 2}
              title={s.name}
              detail={plural(count(s.n), "site")}
              onClick={() =>
                onChange({
                  stage: selection.stage === s.n ? null : s.n,
                  site: null,
                })
              }
            />
          ))}
          {!selection.status && count(null) > 0 && (
            <StageRow
              on={selection.stage === 0}
              color="#a8b4bd"
              badge="–"
              title="Stage not recorded"
              detail={plural(count(null), "site")}
              onClick={() =>
                onChange({
                  stage: selection.stage === 0 ? null : 0,
                  site: null,
                })
              }
            />
          )}
        </ol>
        <p className="mt-2 text-[12px] leading-5 text-[#6b7c8a]">
          Choose a stage to show only its sites, and their parcels, on the map.
        </p>
      </Field>

      <Field label="Site name">
        <select
          value={selection.site ?? ""}
          onChange={(e) => onChange({ site: e.target.value || null })}
          className="h-10 w-full rounded-lg border border-[#d5dee5] bg-white px-3 text-[14px] text-[#14212b] outline-none focus:border-[#17a0db]"
        >
          <option value="">
            {choosable.length === sites.length
              ? "All sites"
              : "All sites shown"}
          </option>
          {choosable.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-[14px] text-[#14212b]">
          Colour sites by stage
        </span>
        <span
          className={`relative h-6 w-11 rounded-full transition ${selection.byStage ? "bg-[#0b7fb5]" : "bg-[#cfd8df]"}`}
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={selection.byStage}
            onChange={(e) => onChange({ byStage: e.target.checked })}
          />
          <span
            className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${selection.byStage ? "translate-x-5" : ""}`}
          />
        </span>
      </label>

      {(selection.status || selection.stage !== null || selection.site) && (
        <button
          type="button"
          onClick={() => onChange({ status: null, stage: null, site: null })}
          className="text-[13px] font-medium text-[#0b7fb5] hover:underline"
        >
          Show every site in the district
        </button>
      )}
    </div>
  );
}

function StageRow(props: {
  on: boolean;
  color: string;
  badge: string;
  light?: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        aria-pressed={props.on}
        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition ${props.on ? "bg-[#eaf6fc] ring-1 ring-[#17a0db]/40" : "hover:bg-[#f3f7fa]"}`}
      >
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold transition ${props.light ? "text-[#0b4f73]" : "text-white"} ${props.on ? "scale-110" : ""}`}
          style={{ background: props.color }}
        >
          {props.badge}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-5 text-[#14212b]">
            {props.title}
          </span>
          <span className="block text-[12px] text-[#6b7c8a]">
            {props.detail}
          </span>
        </span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[13px] text-[#51626f]">{label}</p>
      {children}
    </div>
  );
}

// ---- Documents ---------------------------------------------------------------------------------

export function Documents({
  district,
  references,
}: {
  district: string;
  references: ReferenceDocument[];
}) {
  const [docs, setDocs] = useState<PublicDocument[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetch(`/api/public/documents?district=${district}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; documents?: PublicDocument[] }) =>
        json.ok && json.documents ? setDocs(json.documents) : setError(true),
      )
      .catch(() => setError(true));
  }, [district]);

  return (
    <div className="pp-swap space-y-6">
      <div>
        <p className="mb-2 text-[13px] text-[#51626f]">
          Approved plan documents
        </p>
        {error ? (
          <p className="text-[14px] text-[#51626f]">
            The documents could not be loaded. Please try again later.
          </p>
        ) : !docs ? (
          <Loading />
        ) : docs.length === 0 ? (
          <p className="text-[14px] text-[#51626f]">
            No documents have been published with the approved plans yet.
          </p>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <DocLink
                key={`${d.objectId}-${d.attachmentId}`}
                href={`/api/public/document?district=${district}&oid=${d.objectId}&aid=${d.attachmentId}&name=${encodeURIComponent(d.name)}`}
                title={d.name.replace(/\.pdf$/i, "")}
                subtitle={[
                  d.source === "nla" ? "From NLA" : "Submitted by the district",
                  d.cell && `${d.cell} cell`,
                  d.size && formatSize(d.size),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                accent={d.source === "nla" ? "#0b5f8a" : "#17a0db"}
              />
            ))}
          </div>
        )}
      </div>
      <div>
        <p className="mb-2 text-[13px] text-[#51626f]">Reference</p>
        <div className="space-y-2">
          {references.map((r) => (
            <DocLink
              key={r.href}
              href={r.href}
              title={r.title}
              subtitle={r.subtitle}
              accent="#a8b4bd"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DocLink({
  href,
  title,
  subtitle,
  accent,
}: {
  href: string;
  title: string;
  subtitle: string;
  accent: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="block rounded-lg border border-[#e6ebef] border-l-[3px] bg-white px-3.5 py-3 transition hover:translate-x-1 hover:bg-[#f7fafc]"
      style={{ borderLeftColor: accent }}
    >
      <span className="block truncate text-[14px] text-[#14212b]">{title}</span>
      <span className="block text-[12px] text-[#6b7c8a]">{subtitle}</span>
    </a>
  );
}

// ---- Download ----------------------------------------------------------------------------------

type DownloadFormat = "csv" | "geojson" | "shp" | "sites";

/**
 * Files are built on the server (/api/public/download) and fetched as ordinary links: that works in a
 * normal browser tab and inside an Experience Builder page, whose frame blocks files made in the page.
 * When embedded, each download opens in a new tab, which the frame allows.
 */
export function Download({ district, selection, selected }: { district: string; selection: Selection; selected: Site[] | null }) {
  const [embedded, setEmbedded] = useState(false);
  const [started, setStarted] = useState<DownloadFormat | null>(null);
  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      setEmbedded(true);
    }
  }, []);

  const href = (format: DownloadFormat) => {
    const q = new URLSearchParams({ district, format });
    if (selection.status) q.set("status", selection.status);
    if (selection.stage !== null) q.set("stage", String(selection.stage));
    if (selection.site) q.set("site", selection.site);
    if (embedded) q.set("start", "1");
    return `/api/public/download?${q}`;
  };

  const options: [format: DownloadFormat, title: string, subtitle: string][] = [
    ["shp", "Planned parcels (Shapefile)", "Zipped .shp in WGS 84, for ArcGIS Pro, QGIS and AutoCAD Map"],
    ["geojson", "Planned parcels with boundaries (GeoJSON)", "For QGIS, ArcGIS Pro and web maps"],
    ["csv", "Planned parcels (CSV)", "Opens in Excel, one row per parcel, with its site"],
    ["sites", "Sites (CSV)", "Each site with its stage, parcels and hectares"],
  ];
  return (
    <div className="pp-swap space-y-3">
      <p className="text-[13px] leading-5 text-[#51626f]">
        {selected
          ? `Downloads cover the ${selected.length === 1 ? "site" : `${selected.length} sites`} chosen in Explore.`
          : "Downloads cover every approved plan in the district. Choose a site or stage in Explore to narrow them."}
      </p>
      {options.map(([format, title, subtitle]) => (
        <a
          key={format}
          href={href(format)}
          target={embedded ? "_blank" : undefined}
          rel="noopener"
          onClick={() => setStarted(format)}
          className="block w-full rounded-lg border border-[#e6ebef] bg-white px-3.5 py-3 text-left transition hover:translate-x-1 hover:bg-[#f7fafc]"
        >
          <span className="block text-[14px] text-[#14212b]">{title}</span>
          <span className="block text-[12px] text-[#6b7c8a]">{subtitle}</span>
        </a>
      ))}
      {started && (
        <p className="text-[13px] text-[#51626f]">
          {embedded ? "Your download opens in a new tab and starts in a few seconds." : "Your download starts in a few seconds."}
        </p>
      )}
    </div>
  );
}

// ---- Legend, layers and basemaps (own panels: the SDK widgets would multiply the bundle) ------

export interface ZoneSwatch {
  value: string;
  label: string;
  color: string;
}

export function Legend({
  zoning,
  byStage,
}: {
  zoning: ZoneSwatch[];
  byStage: boolean;
}) {
  const items = byStage
    ? STAGES.map((s) => ({
        value: String(s.n),
        label: `${s.n}. ${s.name}`,
        color: s.color,
      })).concat({
        value: "none",
        label: "Stage not recorded",
        color: "#a8b4bd",
      })
    : zoning;
  return (
    <div className="pp-swap space-y-6">
      <div>
        <p className="mb-2.5 text-[13px] text-[#51626f]">
          {byStage ? "Sites by stage" : "Approved plans by zoning"}
        </p>
        <ul className="space-y-2">
          {items.map((z) => (
            <li
              key={z.value}
              className="flex items-start gap-2.5 text-[13px] leading-5 text-[#14212b]"
            >
              <span
                className="mt-0.5 size-4 shrink-0 rounded-[3px] border border-black/10"
                style={{ background: z.color }}
              />
              {z.label}
            </li>
          ))}
          {items.length === 0 && (
            <li className="text-[13px] text-[#6b7c8a]">
              The plans use a single colour.
            </li>
          )}
        </ul>
      </div>
      <div>
        <p className="mb-2.5 text-[13px] text-[#51626f]">On the map</p>
        <p className="mb-2 flex items-center gap-2.5 text-[13px] text-[#14212b]">
          <span className="size-4 shrink-0 rounded-[3px] border-2 border-[#17a0db] bg-[#17a0db]/5" />
          Site plan boundary
        </p>
        <p className="mb-2 flex items-center gap-2.5 text-[13px] text-[#14212b]">
          <span className="size-4 shrink-0 rounded-[3px] border-[1.5px] border-dashed border-[#8a99a5]" />
          District boundary
        </p>
        <p className="flex items-center gap-2.5 text-[13px] text-[#14212b]">
          <span className="size-4 shrink-0 rounded-[3px] border-[2.5px] border-[#17a0db] bg-[#17a0db]/15" />
          The parcel you searched
        </p>
      </div>
    </div>
  );
}

export function Layers({ view }: { view: MapView | null }) {
  const [, redraw] = useState(0);
  if (!view) return <Loading />;
  const layers = (view.map?.layers.toArray() ?? [])
    .filter((l) => l.listMode !== "hide")
    .reverse();
  return (
    <ul className="pp-swap space-y-1">
      {layers.map((layer) => (
        <li key={layer.id}>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 transition hover:bg-[#f3f7fa]">
            <span className="min-w-0 truncate text-[14px] text-[#14212b]">
              {layer.title}
            </span>
            <span
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${layer.visible ? "bg-[#0b7fb5]" : "bg-[#cfd8df]"}`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={layer.visible}
                onChange={(e) => {
                  layer.visible = e.target.checked;
                  redraw((n) => n + 1);
                }}
              />
              <span
                className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${layer.visible ? "translate-x-5" : ""}`}
              />
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function Basemaps({
  view,
  load,
}: {
  view: MapView | null;
  load: (() => Promise<Basemap[]>) | null;
}) {
  const [basemaps, setBasemaps] = useState<Basemap[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!view || !load) return;
    let cancelled = false;
    load()
      .then((list) => {
        if (!cancelled) setBasemaps(list);
      })
      .catch(() => {
        if (!cancelled) setBasemaps([]);
      });
    setCurrent(view.map?.basemap?.title ?? null);
    return () => {
      cancelled = true;
    };
  }, [view, load]);
  if (!view || !basemaps) return <Loading />;
  if (basemaps.length === 0)
    return (
      <p className="text-[14px] text-[#51626f]">
        No other basemaps are available.
      </p>
    );
  return (
    <div className="pp-swap grid grid-cols-2 gap-3">
      {basemaps.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => {
            if (view.map) view.map.basemap = b;
            setCurrent(b.title);
          }}
          className={`overflow-hidden rounded-lg border text-left transition hover:-translate-y-0.5 ${current === b.title ? "border-[#0b7fb5] ring-2 ring-[#0b7fb5]/30" : "border-[#e6ebef]"}`}
        >
          {(b.thumbnailUrl ?? b.portalItem?.thumbnailUrl) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={(b.thumbnailUrl ?? b.portalItem?.thumbnailUrl)!}
              alt=""
              className="aspect-[4/3] w-full object-cover"
            />
          ) : (
            <span className="block aspect-[4/3] bg-[#eef3f6]" />
          )}
          <span className="block px-2.5 py-2 text-[12px] leading-4 text-[#14212b]">
            {b.portalItem?.title ?? b.title}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---- shared --------------------------------------------------------------------------------------

function Loading() {
  return (
    <div className="space-y-2.5" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-[#eef3f6]" />
      ))}
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
