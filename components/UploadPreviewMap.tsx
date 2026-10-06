"use client";

import { useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoJSON as LeafletGeoJSON, ImageOverlay, Layer, LayerGroup, Map as LeafletMap, Path } from "leaflet";
import type { UploadFeature } from "@/lib/geo/parse-upload";

interface Props {
  features: UploadFeature[] | null;
  labels: string[];
  hovered: number | null;
  selected: number | null;
  onSelect: (index: number) => void;
  /** After a successful append the polygons switch to the "saved" colour. */
  appended: boolean;
  /** Indexes of polygons that will not be appended (duplicates). */
  skipped: ReadonlySet<number>;
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
/** Esri "Imagery Hybrid": imagery with roads, places and administrative boundaries on top. */
const HYBRID_LAYERS = [
  `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
  `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
];
const HYBRID_ATTRIBUTION = "Esri, Maxar, Earthstar Geographics; districts: NLA Rwanda";
/** NLA's official district boundaries (Rwanda Spatial Data Hub), drawn on request for the current view. */
const NLA_DISTRICTS_EXPORT = "https://geodata.rw/server/rest/services/basemap/District_boundary/MapServer/export";

// Hub blue for new parcels, amber for the selected one; skipped duplicates are white outlines only.
const COLORS = { plan: "#0d73b0", saved: "#2fbf71", repair: "#ff4d4d", skip: "#ffffff" };
const MAX_KINK_MARKERS = 500;
const MAX_LABELS = 40;
const MAX_POPUP_ROWS = 24;

/** Leaflet touches `window` on import, so it is loaded lazily inside effects (client only). */
export default function UploadPreviewMap({ features, labels, hovered, selected, onSelect, appended, skipped }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const dataLayerRef = useRef<LeafletGeoJSON | null>(null);
  const kinkLayerRef = useRef<LayerGroup | null>(null);
  const featureLayersRef = useRef<Path[]>([]);
  const propsRef = useRef({ features, labels, appended, onSelect, skipped });
  const [ready, setReady] = useState(false);

  // ---- map lifecycle ---------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current) return;
      leafletRef.current = L;
      // Canvas rendering keeps thousands of parcels responsive.
      const map = L.map(containerRef.current, { center: [-1.95, 29.95], zoom: 9, zoomControl: false, attributionControl: true, preferCanvas: true });
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

  // ---- basemap: Imagery Hybrid + NLA districts ---------------------------------------------------
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    HYBRID_LAYERS.forEach((url, i) =>
      // Skip loading tiles for intermediate zoom levels during fly animations: the final view's imagery arrives sooner.
      // Imagery is real up to level 18 around Rwanda; deeper zooms upscale it instead of showing "Map data not yet available".
      L.tileLayer(url, {
        maxZoom: 20,
        maxNativeZoom: 18,
        updateWhenZooming: false,
        keepBuffer: 3,
        attribution: i === 0 ? HYBRID_ATTRIBUTION : undefined,
      }).addTo(map),
    );

    // Districts sit between the basemap and the parcels, so they never cover a parcel.
    map.createPane("districts").style.zIndex = "350";
    map.getPane("districts")!.style.pointerEvents = "none";
    let overlay: ImageOverlay | null = null;
    let request = 0;
    const refresh = () => {
      const bounds = map.getBounds();
      const size = map.getSize();
      const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
      const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
      const src =
        `${NLA_DISTRICTS_EXPORT}?bbox=${sw.x},${sw.y},${ne.x},${ne.y}&bboxSR=3857&imageSR=3857` +
        `&size=${size.x},${size.y}&format=png32&transparent=true&f=image`;
      const id = ++request;
      const img = new Image();
      img.onload = () => {
        if (id !== request) return; // a newer view replaced this one
        const next = L.imageOverlay(src, bounds, { pane: "districts", interactive: false }).addTo(map);
        overlay?.remove();
        overlay = next;
      };
      img.src = src; // failures leave the previous overlay (or none); the map still works
    };
    map.on("moveend", refresh);
    refresh();
    return () => {
      map.off("moveend", refresh);
      overlay?.remove();
    };
  }, [ready]);

  // ---- data ------------------------------------------------------------------------------------
  propsRef.current = { features, labels, appended, onSelect, skipped };

  /** Duplicates are grey; repair-flagged polygons red until appended (by then ArcGIS has repaired them). */
  const styleFor = (index: number, highlighted: boolean) => {
    const { features: current, appended: saved, skipped: skip } = propsRef.current;
    const state: PolygonState = skip.has(index) ? "skip" : saved ? "saved" : current?.[index]?.selfIntersection ? "repair" : "plan";
    return highlighted ? highlightStyle(state) : baseStyle(state);
  };

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    dataLayerRef.current?.remove();
    dataLayerRef.current = null;
    kinkLayerRef.current?.remove();
    kinkLayerRef.current = null;
    featureLayersRef.current = [];
    if (!features || features.length === 0) return;

    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: features.map((f, i) => ({ type: "Feature", geometry: f.geometry, properties: { ...f.properties, __i: i } })),
    };
    const layer = L.geoJSON(collection, {
      style: (feature) => styleFor(feature?.properties?.__i as number, false),
      onEachFeature: (feature: Feature, leafletLayer: Layer) => {
        const i = feature.properties?.__i as number;
        featureLayersRef.current[i] = leafletLayer as Path;
        leafletLayer.bindPopup(() => popupHtml(propsRef.current.labels[i] ?? `Polygon ${i + 1}`, feature.properties ?? {}), {
          maxWidth: 340,
          autoPanPadding: [40, 40],
        });
        leafletLayer.on("click", () => propsRef.current.onSelect(i));
        if (features.length <= MAX_LABELS) {
          // Numbers match the list in the panel; full IDs are in the list and popups (long IDs would overlap on small parcels).
          leafletLayer.bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "plan-label" });
        }
      },
    }).addTo(map);
    dataLayerRef.current = layer;

    // Mark where flagged polygons cross themselves.
    const kinks = features.flatMap((f, i) => (f.selfIntersection ? [{ i, at: f.selfIntersection }] : [])).slice(0, MAX_KINK_MARKERS);
    if (kinks.length > 0) {
      kinkLayerRef.current = L.layerGroup(
        kinks.map(({ i, at }) =>
          L.circleMarker([at[1], at[0]], { radius: 4, color: "#fff", weight: 1.5, fillColor: COLORS.repair, fillOpacity: 1 }).on("click", () =>
            propsRef.current.onSelect(i),
          ),
        ),
      ).addTo(map);
    }
    map.flyToBounds(layer.getBounds(), { ...fitPadding(), maxZoom: 18, duration: 0.7 });
  }, [features, ready]);

  // ---- appearance updates ----------------------------------------------------------------------
  useEffect(() => {
    featureLayersRef.current.forEach((l, i) => {
      l.setStyle(styleFor(i, i === hovered || i === selected));
      // Skipped duplicates often sit exactly on the parcel they repeat: hide their number so it doesn't cover it.
      l.getTooltip()?.setOpacity(skipped.has(i) ? 0 : 1);
      if (i === hovered || i === selected) l.bringToFront();
    });
  }, [hovered, selected, appended, skipped]);

  useEffect(() => {
    const map = mapRef.current;
    const target = selected === null ? null : featureLayersRef.current[selected];
    if (!map || !target) return;
    const bounds = (target as unknown as { getBounds: () => import("leaflet").LatLngBounds }).getBounds();
    map.flyToBounds(bounds, { ...fitPadding(), maxZoom: 19, duration: 0.8 });
    map.once("moveend", () => target.openPopup());
  }, [selected]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" aria-label="Map of the uploaded polygons" />

    </div>
  );
}

type PolygonState = "plan" | "saved" | "repair" | "skip";

/** White outlines read on any imagery; the fill carries the state colour. */
function baseStyle(state: PolygonState) {
  if (state === "skip") return { color: "#ffffff", weight: 1.5, opacity: 0.9, fillOpacity: 0, dashArray: "4 4" };
  return {
    color: state === "repair" ? COLORS.repair : "#ffffff",
    weight: 1.5,
    opacity: 1,
    fillColor: COLORS[state],
    fillOpacity: 0.45,
    dashArray: state === "repair" ? "5 4" : undefined,
  };
}

function highlightStyle(state: PolygonState) {
  return { color: "#ffa800", weight: 3, opacity: 1, fillColor: COLORS[state], fillOpacity: state === "skip" ? 0.15 : 0.6, dashArray: undefined };
}

/** Breathing room around fitted geometry. */
function fitPadding(): { paddingTopLeft: [number, number]; paddingBottomRight: [number, number] } {
  return { paddingTopLeft: [48, 48], paddingBottomRight: [48, 48] };
}

function popupHtml(title: string, properties: Record<string, unknown>): string {
  const { __i, ...attrs } = properties;
  const entries = Object.entries(attrs);
  const rows = entries
    .slice(0, MAX_POPUP_ROWS)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:3px 14px 3px 0;color:#6b6b6b;vertical-align:top">${escapeHtml(k)}</td><td style="padding:3px 0;color:#000">${escapeHtml(formatValue(v))}</td></tr>`,
    )
    .join("");
  const more = entries.length > MAX_POPUP_ROWS ? `<p style="margin:6px 0 0;color:#6b6b6b">${entries.length - MAX_POPUP_ROWS} more fields</p>` : "";
  return `<div style="font-size:15px;font-weight:300;color:#000">${escapeHtml(title)}</div>
<div style="color:#078ece;font-size:12px;margin:2px 0 10px">Polygon ${Number(__i) + 1}</div>
${rows ? `<table style="font-size:12px">${rows}</table>` : `<p style="color:#6b6b6b">No attributes in the file</p>`}${more}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
