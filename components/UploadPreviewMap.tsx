"use client";

import { useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoJSON as LeafletGeoJSON, Layer, Map as LeafletMap, Path, TileLayer } from "leaflet";
import type { UploadFeature } from "@/lib/geo/parse-upload";

interface Props {
  features: UploadFeature[] | null;
  labels: string[];
  hovered: number | null;
  selected: number | null;
  onSelect: (index: number) => void;
  /** After a successful append the polygons switch to the "saved" colour. */
  appended: boolean;
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const BASEMAPS = {
  imagery: {
    label: "Imagery",
    layers: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
    attribution: "Esri, Maxar, Earthstar Geographics",
  },
  streets: {
    label: "Streets",
    layers: [`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`],
    attribution: "Esri, HERE, Garmin, OpenStreetMap contributors",
  },
  dark: {
    label: "Dark",
    layers: [`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`],
    attribution: "Esri, HERE, Garmin",
  },
} as const;
type BasemapKey = keyof typeof BASEMAPS;

const COLORS = { plan: "#ffb020", saved: "#20a35c" };
const MAX_LABELS = 40;
const MAX_POPUP_ROWS = 24;

/** Leaflet touches `window` on import, so it is loaded lazily inside effects (client only). */
export default function UploadPreviewMap({ features, labels, hovered, selected, onSelect, appended }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const dataLayerRef = useRef<LeafletGeoJSON | null>(null);
  const featureLayersRef = useRef<Path[]>([]);
  const baseLayersRef = useRef<TileLayer[]>([]);
  const propsRef = useRef({ features, labels, appended, onSelect });
  const [basemap, setBasemap] = useState<BasemapKey>("imagery");
  const [ready, setReady] = useState(false);

  // ---- map lifecycle ---------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, { center: [-1.95, 29.95], zoom: 9, zoomControl: false, attributionControl: true });
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
      mapRef.current = map;
      resizeObserver = new ResizeObserver(() => map.invalidateSize());
      resizeObserver.observe(containerRef.current);
      setReady(true);
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- basemap ---------------------------------------------------------------------------------
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    baseLayersRef.current.forEach((l) => l.remove());
    const def = BASEMAPS[basemap];
    baseLayersRef.current = def.layers.map((url, i) =>
      L.tileLayer(url, { maxZoom: 19, attribution: i === 0 ? def.attribution : undefined }).addTo(map).bringToBack(),
    );
  }, [basemap, ready]);

  // ---- data ------------------------------------------------------------------------------------
  propsRef.current = { features, labels, appended, onSelect };

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    dataLayerRef.current?.remove();
    dataLayerRef.current = null;
    featureLayersRef.current = [];
    if (!features || features.length === 0) return;

    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: features.map((f, i) => ({ type: "Feature", geometry: f.geometry, properties: { ...f.properties, __i: i } })),
    };
    const layer = L.geoJSON(collection, {
      style: () => baseStyle(propsRef.current.appended),
      onEachFeature: (feature: Feature, leafletLayer: Layer) => {
        const i = feature.properties?.__i as number;
        featureLayersRef.current[i] = leafletLayer as Path;
        leafletLayer.bindPopup(() => popupHtml(propsRef.current.labels[i] ?? `Polygon ${i + 1}`, feature.properties ?? {}), {
          maxWidth: 340,
          autoPanPaddingTopLeft: [440, 90],
        });
        leafletLayer.on("click", () => propsRef.current.onSelect(i));
        if (features.length <= MAX_LABELS) {
          // Numbers match the list in the panel; full IDs are in the list and popups (long IDs would overlap on small parcels).
          leafletLayer.bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "plan-label" });
        }
      },
    }).addTo(map);
    dataLayerRef.current = layer;
    map.flyToBounds(layer.getBounds(), { ...fitPadding(), maxZoom: 18, duration: 1.1 });
  }, [features, ready]);

  // ---- appearance updates ----------------------------------------------------------------------
  useEffect(() => {
    featureLayersRef.current.forEach((l, i) => {
      l.setStyle(i === hovered || i === selected ? highlightStyle(appended) : baseStyle(appended));
      if (i === hovered || i === selected) l.bringToFront();
    });
  }, [hovered, selected, appended]);

  useEffect(() => {
    const map = mapRef.current;
    const target = selected === null ? null : featureLayersRef.current[selected];
    if (!map || !target) return;
    const bounds = (target as unknown as { getBounds: () => import("leaflet").LatLngBounds }).getBounds();
    map.flyToBounds(bounds, { ...fitPadding(), maxZoom: 19, duration: 0.8 });
    map.once("moveend", () => target.openPopup());
  }, [selected]);

  const empty = !features || features.length === 0;

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" aria-label="Map of the uploaded polygons" />

      {empty && (
        <div className="pointer-events-none absolute inset-0 hidden items-center justify-center lg:flex lg:pl-[440px]">
          <div className="glass animate-rise rounded-2xl px-5 py-3 text-center">
            <p className="text-sm font-medium">Your plan will appear here</p>
            <p className="text-xs text-slate-400">Every polygon, on the map, before anything is saved</p>
          </div>
        </div>
      )}

      <div className="glass absolute bottom-24 right-3 z-[1000] flex gap-1 rounded-xl p-1 lg:bottom-[118px]">
        {(Object.keys(BASEMAPS) as BasemapKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setBasemap(key)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              basemap === key ? "bg-white text-ink-950" : "text-slate-300 hover:bg-white/10"
            }`}
          >
            {BASEMAPS[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function baseStyle(appended: boolean) {
  const color = appended ? COLORS.saved : COLORS.plan;
  return { color, weight: 2.5, opacity: 1, fillColor: color, fillOpacity: 0.22 };
}

function highlightStyle(appended: boolean) {
  const color = appended ? COLORS.saved : COLORS.plan;
  return { color: "#ffffff", weight: 3.5, opacity: 1, fillColor: color, fillOpacity: 0.45 };
}

/** Keep fitted geometry clear of the floating panel on desktop. */
function fitPadding(): { paddingTopLeft: [number, number]; paddingBottomRight: [number, number] } {
  const wide = typeof window !== "undefined" && window.innerWidth >= 1024;
  return wide ? { paddingTopLeft: [470, 110], paddingBottomRight: [60, 60] } : { paddingTopLeft: [24, 70], paddingBottomRight: [24, 24] };
}

function popupHtml(title: string, properties: Record<string, unknown>): string {
  const { __i, ...attrs } = properties;
  const entries = Object.entries(attrs);
  const rows = entries
    .slice(0, MAX_POPUP_ROWS)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#94a3b8;font-family:var(--font-mono);font-size:11px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0;color:#e6ebf5">${escapeHtml(formatValue(v))}</td></tr>`,
    )
    .join("");
  const more = entries.length > MAX_POPUP_ROWS ? `<p style="margin:6px 0 0;color:#94a3b8">+ ${entries.length - MAX_POPUP_ROWS} more</p>` : "";
  return `<div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#ffd27a;font-family:var(--font-mono)">${escapeHtml(title)}</div>
<div style="color:#94a3b8;font-size:11px;margin-bottom:6px">Polygon ${Number(__i) + 1}</div>
${rows ? `<table>${rows}</table>` : `<p style="color:#94a3b8">No attributes in the file</p>`}${more}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
