"use client";

import { useEffect, useRef } from "react";
import type { FeatureCollection } from "geojson";
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap } from "leaflet";
import type { UploadFeature } from "@/lib/geo/parse-upload";

interface Props {
  features: UploadFeature[] | null;
}

// Imagery gives planners real ground context (rural parcels are often blank on street basemaps).
const IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const BASEMAP_ATTRIBUTION = "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const MAX_POPUP_ROWS = 25;

/** Leaflet touches `window` on import, so it is loaded lazily inside effects (client only). */
export default function UploadPreviewMap({ features }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LeafletGeoJSON | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  // Latest features, so the async map init can draw an upload selected before Leaflet loaded.
  const featuresRef = useRef(features);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current) return;
      leafletRef.current = L;
      // Initial view: Rwanda.
      const map = L.map(containerRef.current, { center: [-1.95, 29.9], zoom: 8 });
      L.tileLayer(IMAGERY_URL, { attribution: BASEMAP_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      L.tileLayer(LABELS_URL, { maxZoom: 19 }).addTo(map);
      L.control.scale().addTo(map);
      mapRef.current = map;
      // Keep tiles filling the container when the surrounding layout changes height.
      resizeObserver = new ResizeObserver(() => map.invalidateSize());
      resizeObserver.observe(containerRef.current);
      draw(featuresRef.current);
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw(next: UploadFeature[] | null) {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    layerRef.current?.remove();
    layerRef.current = null;
    if (!next || next.length === 0) return;

    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: next.map((f, i) => ({ type: "Feature", geometry: f.geometry, properties: { ...f.properties, __index: i + 1 } })),
    };
    const layer = L.geoJSON(collection, {
      style: { color: "#f97316", weight: 2.5, fillColor: "#fb923c", fillOpacity: 0.25 },
      onEachFeature: (feature, leafletLayer) => leafletLayer.bindPopup(popupHtml(feature.properties ?? {}), { maxWidth: 360 }),
    }).addTo(map);
    layerRef.current = layer;
    map.fitBounds(layer.getBounds(), { padding: [32, 32], maxZoom: 17 });
  }

  useEffect(() => {
    featuresRef.current = features;
    draw(features);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features]);

  return <div ref={containerRef} className="h-full min-h-[420px] w-full" aria-label="Map of the uploaded polygons" />;
}

function popupHtml(properties: Record<string, unknown>): string {
  const { __index, ...attrs } = properties;
  const entries = Object.entries(attrs);
  const rows = entries
    .slice(0, MAX_POPUP_ROWS)
    .map(([k, v]) => `<tr><th style="text-align:left;padding-right:8px;font-weight:600">${escapeHtml(k)}</th><td>${escapeHtml(formatValue(v))}</td></tr>`)
    .join("");
  const more = entries.length > MAX_POPUP_ROWS ? `<p style="margin:4px 0 0">… ${entries.length - MAX_POPUP_ROWS} more</p>` : "";
  return `<strong>Polygon ${escapeHtml(String(__index))}</strong>${rows ? `<table style="margin-top:4px;font-size:12px">${rows}</table>` : "<p>No attributes</p>"}${more}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
