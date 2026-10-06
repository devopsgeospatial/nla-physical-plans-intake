"use client";

import { useEffect, useRef } from "react";
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap } from "leaflet";
import type { MultiPolygon, Polygon } from "geojson";

interface Props {
  geometry: Polygon | MultiPolygon | null;
}

// Imagery gives planners real ground context (rural parcels are often blank on street basemaps).
const IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const BASEMAP_ATTRIBUTION = "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community";

/** Leaflet touches `window` on import, so it is loaded lazily inside effects (client only). */
export default function BoundaryPreviewMap({ geometry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LeafletGeoJSON | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  // Latest geometry, so the async map init can draw a boundary selected before Leaflet loaded.
  const geometryRef = useRef(geometry);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current) return;
      leafletRef.current = L;
      // Initial view: Rwanda (the reference plans are in Muhanga).
      const map = L.map(containerRef.current, { center: [-1.95, 29.9], zoom: 8 });
      L.tileLayer(IMAGERY_URL, { attribution: BASEMAP_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      L.tileLayer(LABELS_URL, { maxZoom: 19 }).addTo(map);
      L.control.scale().addTo(map);
      mapRef.current = map;
      // Keep tiles filling the container when the surrounding layout changes height.
      resizeObserver = new ResizeObserver(() => map.invalidateSize());
      resizeObserver.observe(containerRef.current);
      drawBoundary(geometryRef.current);
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

  function drawBoundary(next: Polygon | MultiPolygon | null) {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    layerRef.current?.remove();
    layerRef.current = null;
    if (!next) return;

    const layer = L.geoJSON(next, {
      style: { color: "#f97316", weight: 3, fillColor: "#fb923c", fillOpacity: 0.25 },
    }).addTo(map);
    layerRef.current = layer;
    map.fitBounds(layer.getBounds(), { padding: [48, 48], maxZoom: 16 }); // keep surrounding context visible
  }

  useEffect(() => {
    geometryRef.current = geometry;
    drawBoundary(geometry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);

  return <div ref={containerRef} className="h-full min-h-[360px] w-full" aria-label="Boundary preview map" />;
}
