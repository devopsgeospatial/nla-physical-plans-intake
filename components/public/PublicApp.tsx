"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type UniqueValueRenderer from "@arcgis/core/renderers/UniqueValueRenderer";
import type SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
import type { MapSettings } from "@/lib/arcgis/config";
import type { ReferenceDocument } from "@/lib/public/districts";
import type { ParcelReport } from "@/lib/public/parcel-lookup";
import type { EsriPolygon } from "@/lib/geo/esri-geometry";
import ParcelResult from "./ParcelResult";
import type { MapHandles, Site } from "./PlansMap";
import { Basemaps, Documents, Download, Explore, Insights, Layers, Legend, selectSites, type DistrictTotals, type Selection, type ZoneSwatch } from "./Panels";

const PlansMap = dynamic(() => import("./PlansMap"), { ssr: false });

type ViewKey = "search" | "insights" | "explore" | "legend" | "layers" | "documents" | "download" | "basemaps";

const VIEWS: { key: ViewKey; title: string; icon: ReactNode }[] = [
  { key: "search", title: "Parcel search", icon: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4" /> },
  { key: "insights", title: "Insights", icon: <path d="M5 20V10M12 20V4M19 20v-7" /> },
  { key: "explore", title: "Explore plans", icon: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" /> },
  { key: "legend", title: "Legend", icon: <path d="M4 6h2M4 12h2M4 18h2M10 6h10M10 12h10M10 18h10" /> },
  { key: "layers", title: "Layers", icon: <path d="M12 2.5 3 7.5l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16.5l9 5 9-5" /> },
  { key: "documents", title: "Documents", icon: <path d="M7 3h8l4 4v14H7V3ZM14 3v5h5M10 13h6M10 17h6" /> },
  { key: "download", title: "Download data", icon: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" /> },
  {
    key: "basemaps",
    title: "Basemaps",
    icon: <path d="M5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4A1.5 1.5 0 0 1 5.5 4ZM14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4A1.5 1.5 0 0 1 14.5 4ZM5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4A1.5 1.5 0 0 1 5.5 13ZM14.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5Z" />,
  },
];

type Lookup = { kind: "idle" } | { kind: "loading"; label: string } | { kind: "found"; parcel: ParcelReport } | { kind: "error"; message: string };

export default function PublicApp({
  district,
  map,
  planLayerUrl,
  baseFilter,
  boundary,
  sitesLayerUrls,
  references,
  otherDistricts,
  homeUrl,
}: {
  district: { slug: string; name: string };
  map: MapSettings;
  planLayerUrl: string;
  baseFilter: string;
  /** The district's boundary (WGS84 ArcGIS JSON): what "in this district" means for every query. */
  boundary: EsriPolygon;
  sitesLayerUrls: string[];
  references: ReferenceDocument[];
  /** Other live districts, for the header's district menu (empty on a single-district deployment). */
  otherDistricts: { slug: string; name: string }[];
  /** The landing page, where every district is listed. */
  homeUrl: string;
}) {
  const [view, setView] = useState<ViewKey | null>(null);
  const [wide, setWide] = useState(true);
  const [handles, setHandles] = useState<MapHandles | null>(null);
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  const [selection, setSelection] = useState<Selection>({ status: null, stage: null, site: null, byStage: false });
  const [totals, setTotals] = useState<DistrictTotals | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [zoning, setZoning] = useState<ZoneSwatch[]>([]);
  const colors = useMemo(() => new Map(zoning.map((z) => [z.value, z.color])), [zoning]);
  const request = useRef(0);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Search is the heart of the app: on wide screens it opens with the search panel.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) setView((v) => v ?? "search");
  }, []);

  // ---- parcel search --------------------------------------------------------------------------
  const run = useCallback(
    async (params: Record<string, string>, label: string) => {
      const id = ++request.current;
      setLookup({ kind: "loading", label });
      // A tap on the map is about a place, not a UPI: clear any UPI from the box and address bar at once.
      if (!params.upi) {
        setQuery("");
        window.history.replaceState(null, "", window.location.pathname);
      }
      setView("search");
      try {
        const res = await fetch(`/api/public/parcel?${new URLSearchParams({ district: district.slug, ...params })}`);
        const json = (await res.json().catch(() => null)) as { ok: boolean; parcel?: ParcelReport; error?: string } | null;
        if (id !== request.current) return;
        if (json?.ok && json.parcel) {
          setLookup({ kind: "found", parcel: json.parcel });
          // The address bar keeps a UPI only when the citizen typed it; a tap leaves no trace of one.
          if (json.parcel.upi) {
            setQuery(json.parcel.upi);
            window.history.replaceState(null, "", `?upi=${encodeURIComponent(json.parcel.upi)}`);
          } else {
            setQuery("");
            window.history.replaceState(null, "", window.location.pathname);
          }
        } else setLookup({ kind: "error", message: json?.error ?? "The parcel could not be looked up right now." });
      } catch {
        if (id === request.current) setLookup({ kind: "error", message: "No connection. Check your internet and try again." });
      }
    },
    [district.slug],
  );

  useEffect(() => {
    const upi = new URLSearchParams(window.location.search).get("upi");
    if (upi) {
      setQuery(upi);
      void run({ upi }, upi);
    }
  }, [run]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    if (query.trim()) void run({ upi: query.trim() }, query.trim());
  }
  const onPick = useCallback((lon: number, lat: number) => void run({ lon: lon.toFixed(7), lat: lat.toFixed(7) }, "the place you tapped"), [run]);

  // ---- once the map is ready: zoning colours and the district's totals ------------------------
  const onReady = useCallback(
    (h: MapHandles) => {
      setHandles(h);
      const renderer = h.plans.renderer as UniqueValueRenderer | null;
      if (renderer?.type === "unique-value") {
        const swatches = (renderer.uniqueValueInfos ?? []).map((i) => ({
          value: String(i.value),
          label: i.label || String(i.value),
          color: (i.symbol as SimpleFillSymbol | null)?.color?.toCss(false) ?? "#9a9a9a",
        }));
        const fallback = renderer.defaultSymbol as SimpleFillSymbol | null;
        if (fallback?.color) swatches.push({ value: "__default", label: renderer.defaultLabel || "Other approved plans", color: fallback.color.toCss(false) });
        setZoning(swatches);
      }
      // Approved parcels lying in the district (by location: planners often leave the district field empty).
      h.plans
        .queryFeatures({
          where: baseFilter,
          geometry: h.district,
          spatialRelationship: "intersects",
          outStatistics: [
            { statisticType: "count", onStatisticField: h.plans.objectIdField, outStatisticFieldName: "n" },
            { statisticType: "sum", onStatisticField: "area_sqm", outStatisticFieldName: "a" },
          ],
        })
        .then((r) => setTotals({ parcels: Number(r.features[0]?.attributes.n ?? 0), hectares: Number(r.features[0]?.attributes.a ?? 0) / 10_000 }))
        .catch((err) => {
          console.warn("[insights]", err);
          setTotals({ parcels: 0, hectares: 0 });
        });
    },
    [baseFilter],
  );

  // ---- the sites chosen in Explore (by status, stage or name): the map shows and frames only them --
  const selectedSites = useMemo(() => (sites ? selectSites(sites, selection) : null), [sites, selection]);
  const selectedKeys = useMemo(() => selectedSites?.map((s) => s.key) ?? null, [selectedSites]);
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const siteName = selection.site ? sites?.find((s) => s.key === selection.site)?.name : undefined;
  const downloadLabel =
    [district.slug, selection.status?.toLowerCase(), selection.stage ? `stage-${selection.stage}` : null, siteName ? slug(siteName) : null].filter(Boolean).join("_");
  const change = (next: Partial<Selection>) => setSelection((s) => ({ ...s, ...next }));

  const panelOpen = view !== null;
  const padding = useMemo(() => (wide ? { top: 0, left: panelOpen ? 380 : 0, bottom: 0 } : { top: 0, left: 0, bottom: panelOpen ? Math.round(window.innerHeight * 0.55) : 0 }), [wide, panelOpen]);
  const toggle = (key: ViewKey) => setView((v) => (v === key ? null : key));
  const title = VIEWS.find((v) => v.key === view)?.title ?? "";

  return (
    <div className="pp flex h-dvh flex-col overflow-hidden bg-white text-[#14212b]">
      <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-[#e6ebef] bg-white px-3 sm:gap-5 sm:px-5">
        <a href={homeUrl} className="shrink-0" aria-label="Physical Plans home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/nla-logo.png" alt="National Land Authority" width={76} height={38} className="h-[36px] w-auto" />
        </a>
        <div className="hidden min-w-0 border-l border-[#e7e7e7] pl-5 lg:block">
          <p className="truncate text-[17px] leading-tight font-semibold text-[#14212b]">Rwanda Physical Plans</p>
          <p className="truncate text-[12px] text-[#656368]">{district.name} District · from proposal to gazettement</p>
        </div>
        <form onSubmit={onSearch} className="mx-auto flex h-11 min-w-0 flex-1 overflow-hidden rounded-full border border-[#dfe5ea] bg-[#f6f8fa] transition focus-within:border-[#17a0db] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(23,160,219,0.15)] lg:max-w-[540px]" role="search">
          <svg viewBox="0 0 24 24" className="ml-4 size-5 shrink-0 self-center fill-none stroke-[#6b7c8a]" strokeWidth={2} strokeLinecap="round" aria-hidden>
            <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your parcel by UPI, e.g. 2/07/01/01/5833"
            aria-label="Parcel UPI"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-3 text-[15px] text-[#14212b] tabular-nums outline-none placeholder:text-[#8a99a5]"
          />
          <button type="submit" className="m-1 shrink-0 rounded-full bg-[#0b7fb5] px-5 text-[14px] font-semibold text-white transition hover:bg-[#096a97]">
            Search
          </button>
        </form>
        <label className="relative hidden shrink-0 sm:block">
          <span className="sr-only">District</span>
          <select
            value={district.slug}
            onChange={(e) => {
              const slug = e.target.value;
              window.location.assign(slug === "__all" ? homeUrl : `/${slug}`);
            }}
            className="h-10 cursor-pointer appearance-none rounded-full border border-[#dfe5ea] bg-white pr-9 pl-4 text-[14px] font-semibold text-[#14212b] transition outline-none hover:border-[#17a0db] focus:border-[#17a0db]"
          >
            <option value={district.slug}>{district.name} District</option>
            {otherDistricts.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.name} District
              </option>
            ))}
            <option value="__all">All districts…</option>
          </select>
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 right-3.5 size-3.5 -translate-y-1/2 fill-none stroke-[#51626f]" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </label>
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Rail: the app's views */}
        <nav className="absolute z-20 flex border-[#e6ebef] bg-white max-md:inset-x-0 max-md:bottom-0 max-md:h-14 max-md:justify-around max-md:overflow-x-auto max-md:border-t md:inset-y-0 md:left-0 md:w-16 md:flex-col md:items-center md:gap-1 md:border-r md:pt-3">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => toggle(v.key)}
              aria-label={v.title}
              aria-pressed={view === v.key}
              className={`group relative grid size-11 shrink-0 place-items-center rounded-xl transition duration-300 ${
                view === v.key ? "bg-[#eaf6fc] text-[#0b7fb5]" : "text-[#6b7c8a] hover:bg-[#f3f7fa] hover:text-[#14212b] md:hover:translate-x-0.5"
              }`}
            >
              {view === v.key && <span className="absolute top-2.5 bottom-2.5 -left-2.5 hidden w-[3px] rounded-full bg-[#17a0db] md:block" />}
              <svg viewBox="0 0 24 24" className="size-[22px] fill-none stroke-current" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {v.icon}
              </svg>
              <span className="pointer-events-none absolute left-14 z-30 hidden rounded-md bg-[#14212b] px-2 py-1 text-[12px] whitespace-nowrap text-white opacity-0 transition group-hover:opacity-100 md:block">
                {v.title}
              </span>
            </button>
          ))}
        </nav>

        {/* Panel: white, slides in */}
        <aside
          className={`absolute z-10 flex flex-col bg-white transition-transform duration-[450ms] ease-[cubic-bezier(.22,.8,.2,1)] max-md:inset-x-0 max-md:bottom-14 max-md:h-[55dvh] max-md:rounded-t-2xl max-md:shadow-[0_-8px_30px_rgba(10,40,60,0.18)] md:inset-y-0 md:left-16 md:w-[380px] md:border-r md:border-[#e6ebef] ${
            panelOpen ? "translate-x-0 translate-y-0 md:shadow-[12px_0_32px_rgba(10,40,60,0.12)]" : "max-md:translate-y-[110%] md:-translate-x-[102%]"
          }`}
          aria-hidden={!panelOpen}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <h2 className="text-[18px] font-semibold text-[#14212b]">{title}</h2>
            <button type="button" onClick={() => setView(null)} aria-label="Close panel" className="grid size-8 place-items-center rounded-full text-[20px] text-[#6b7c8a] transition hover:bg-[#f3f7fa]">
              ×
            </button>
          </div>
          <div className="pp-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            {view === "search" && (
              <SearchView lookup={lookup} districtName={district.name} colors={colors} onClear={() => (setLookup({ kind: "idle" }), setQuery(""), window.history.replaceState(null, "", window.location.pathname))} />
            )}
            {view === "insights" && <Insights sites={sites} totals={totals} selection={selection} onOpenSite={(key) => change({ site: key })} />}
            {view === "explore" && <Explore sites={sites} selection={selection} onChange={change} />}
            {view === "documents" && <Documents district={district.slug} references={references} />}
            {view === "download" && (
              <Download plans={handles?.plans ?? null} district={handles?.district ?? null} baseFilter={baseFilter} sites={sites} selected={selectedSites} label={downloadLabel} />
            )}
            {view === "legend" && <Legend zoning={zoning} byStage={selection.byStage} />}
            {view === "layers" && <Layers view={handles?.view ?? null} />}
            {view === "basemaps" && <Basemaps view={handles?.view ?? null} load={handles?.basemaps ?? null} />}
          </div>
        </aside>

        <div className="absolute inset-0 max-md:bottom-14 md:left-16">
          <PlansMap
            map={map}
            planLayerUrl={planLayerUrl}
            baseFilter={baseFilter}
            boundary={boundary}
            sitesLayerUrls={sitesLayerUrls}
            selectedSites={selectedKeys}
            byStage={selection.byStage}
            parcel={lookup.kind === "found" ? lookup.parcel.geometry : null}
            padding={padding}
            onReady={onReady}
            onSites={setSites}
            onPick={onPick}
          />
        </div>

        <MapControls handles={handles} />

      </div>
    </div>
  );
}

/** Zoom and home buttons in the app's own style (in place of the ArcGIS widgets). */
function MapControls({ handles }: { handles: MapHandles | null }) {
  const zoom = (by: number) => {
    const view = handles?.view;
    if (view) view.goTo({ zoom: view.zoom + by }, { duration: 350 }).catch(() => undefined);
  };
  const buttons: { label: string; onClick: () => void; icon: ReactNode }[] = [
    { label: "Zoom in", onClick: () => zoom(1), icon: <path d="M12 5v14M5 12h14" /> },
    { label: "Zoom out", onClick: () => zoom(-1), icon: <path d="M5 12h14" /> },
    { label: "Whole district", onClick: () => handles?.home(), icon: <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" /> },
  ];
  return (
    <div className="absolute top-3 right-3 z-[5] flex flex-col overflow-hidden rounded-xl bg-white shadow-[0_4px_16px_rgba(10,40,60,0.18)] max-md:bottom-auto">
      {buttons.map((b, i) => (
        <button
          key={b.label}
          type="button"
          onClick={b.onClick}
          disabled={!handles}
          aria-label={b.label}
          title={b.label}
          className={`grid size-10 place-items-center text-[#51626f] transition hover:bg-[#eaf6fc] hover:text-[#0b7fb5] disabled:opacity-40 ${i > 0 ? "border-t border-[#eef2f5]" : ""}`}
        >
          <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {b.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

function SearchView({ lookup, districtName, colors, onClear }: { lookup: Lookup; districtName: string; colors: Map<string, string>; onClear: () => void }) {
  if (lookup.kind === "found") return <ParcelResult parcel={lookup.parcel} districtName={districtName} colorOf={(z) => (z ? colors.get(z) : undefined)} onClear={onClear} />;
  if (lookup.kind === "loading") {
    return (
      <div className="pp-swap space-y-3">
        <p className="text-[14px] text-[#51626f]">Looking up {lookup.label}…</p>
        <div className="h-40 animate-pulse rounded-xl bg-[#eef3f6]" />
      </div>
    );
  }
  return (
    <div className="pp-swap space-y-4">
      {lookup.kind === "error" && <p className="rounded-lg border-l-[3px] border-[#c62828] bg-[#fdf1f1] px-3 py-2.5 text-[14px] leading-6 text-[#7a1c1c]">{lookup.message}</p>}
      <p className="text-[15px] leading-7 text-[#14212b]">Is your parcel within an approved physical plan?</p>
      <ol className="space-y-3 text-[14px] leading-6 text-[#51626f]">
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#eaf6fc] text-[12px] text-[#0b7fb5]">1</span>
          Type your parcel&apos;s UPI in the search bar above, as it appears on your land title.
        </li>
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#eaf6fc] text-[12px] text-[#0b7fb5]">2</span>
          Or tap your parcel on the map.
        </li>
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#eaf6fc] text-[12px] text-[#0b7fb5]">3</span>
          See its zoning, how much of it the plan covers, and the plan&apos;s stage.
        </li>
      </ol>
    </div>
  );
}
