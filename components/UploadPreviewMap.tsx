"use client";

import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Graphic from "@arcgis/core/Graphic";
import Extent from "@arcgis/core/geometry/Extent";
import Point from "@arcgis/core/geometry/Point";
import Polygon from "@arcgis/core/geometry/Polygon";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
import SimpleMarkerSymbol from "@arcgis/core/symbols/SimpleMarkerSymbol";
import TextSymbol from "@arcgis/core/symbols/TextSymbol";
import MapView from "@arcgis/core/views/MapView";
import WebMap from "@arcgis/core/WebMap";
import type { MapSettings } from "@/lib/arcgis/config";
import { geoJsonToEsriPolygon } from "@/lib/geo/esri-geometry";
import type { UploadFeature } from "@/lib/geo/parse-upload";

interface Props {
  /** The ArcGIS Online web map behind the parcels (basemap and layers as configured in Map Viewer). */
  map: MapSettings;
  features: UploadFeature[] | null;
  labels: string[];
  hovered: number | null;
  selected: number | null;
  onSelect: (index: number) => void;
  /** After a successful append (or approval) the polygons switch to the "saved" colour. */
  appended: boolean;
  /** Indexes of polygons that will not be appended (duplicates). */
  skipped: ReadonlySet<number>;
}

type PolygonState = "plan" | "saved" | "repair" | "skip";

// Hub blue for new parcels, amber for the selected one, red for self-crossing, white outline for duplicates.
const FILL: Record<PolygonState, [number, number, number, number]> = {
  plan: [13, 115, 176, 0.45],
  saved: [47, 191, 113, 0.45],
  repair: [255, 77, 77, 0.45],
  skip: [255, 255, 255, 0],
};
const MAX_LABELS = 40;
const MAX_KINK_MARKERS = 500;
const MAX_POPUP_ROWS = 24;
const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };

function symbolFor(state: PolygonState, highlighted: boolean): SimpleFillSymbol {
  if (highlighted) {
    return new SimpleFillSymbol({ color: [...FILL[state].slice(0, 3), state === "skip" ? 0.15 : 0.6] as number[], outline: { color: [255, 168, 0, 1], width: 3 } });
  }
  return new SimpleFillSymbol({
    color: FILL[state],
    outline: {
      color: state === "repair" ? [255, 77, 77, 1] : [255, 255, 255, state === "skip" ? 0.9 : 1],
      width: 1.5,
      style: state === "repair" || state === "skip" ? "dash" : "solid",
    },
  });
}

/** ArcGIS Maps SDK view of the configured web map, with the uploaded parcels drawn on top. */
export default function UploadPreviewMap({ map, features, labels, hovered, selected, onSelect, appended, skipped }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const parcelsRef = useRef<GraphicsLayer | null>(null);
  const graphicsRef = useRef<Graphic[]>([]);
  const propsRef = useRef({ features, labels, appended, skipped, onSelect });
  propsRef.current = { features, labels, appended, skipped, onSelect };

  const stateOf = (index: number): PolygonState => {
    const { features: current, appended: saved, skipped: skip } = propsRef.current;
    return skip.has(index) ? "skip" : saved ? "saved" : current?.[index]?.selfIntersection ? "repair" : "plan";
  };

  // ---- view lifecycle ---------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    esriConfig.portalUrl = map.portalUrl;
    const parcels = new GraphicsLayer({ title: "Uploaded parcels" });
    const webmap = new WebMap({ portalItem: { id: map.webMapId } });
    const view = new MapView({
      container: containerRef.current,
      map: webmap,
      constraints: { snapToZoom: false },
      popup: { dockEnabled: false, dockOptions: { buttonEnabled: false } },
    });
    view.ui.move("zoom", "bottom-right");
    viewRef.current = view;
    parcelsRef.current = parcels;

    // Keep the parcels above every layer of the web map.
    webmap.when(() => webmap.add(parcels)).catch((err) => console.error("[map] web map failed to load", err));

    const click = view.on("click", async (event) => {
      const hit = await view.hitTest(event, { include: [parcels] });
      const graphic = hit.results.find((r) => r.type === "graphic")?.graphic;
      const index = graphic?.attributes?.__i;
      if (typeof index === "number") propsRef.current.onSelect(index);
    });

    return () => {
      click.remove();
      view.destroy();
      viewRef.current = null;
      parcelsRef.current = null;
      graphicsRef.current = [];
    };
  }, [map.portalUrl, map.webMapId]);

  // ---- parcels ----------------------------------------------------------------------------------
  useEffect(() => {
    const view = viewRef.current;
    const layer = parcelsRef.current;
    if (!view || !layer) return;
    layer.removeAll();
    graphicsRef.current = [];
    view.closePopup();
    if (!features || features.length === 0) return;

    const polygons = features.map((f, i) => {
      const esri = geoJsonToEsriPolygon(f.geometry);
      return new Graphic({
        geometry: new Polygon({ rings: esri.rings, spatialReference: { wkid: 4326 } }),
        symbol: symbolFor(stateOf(i), false),
        attributes: { __i: i },
      });
    });
    graphicsRef.current = polygons;
    layer.addMany(polygons);

    // Numbers match the panel; long IDs would overlap on small parcels.
    if (features.length <= MAX_LABELS) {
      layer.addMany(
        polygons.map((g, i) => {
          const at = (g.geometry as Polygon).centroid ?? (g.geometry as Polygon).extent!.center;
          return new Graphic({
            geometry: at,
            symbol: new TextSymbol({ text: String(i + 1), color: "white", haloColor: [25, 52, 67, 1], haloSize: 2, font: { size: 10, weight: "bold" } }),
            attributes: { __i: i, label: true },
          });
        }),
      );
    }

    const kinks = features.flatMap((f, i) => (f.selfIntersection ? [{ i, at: f.selfIntersection }] : [])).slice(0, MAX_KINK_MARKERS);
    layer.addMany(
      kinks.map(
        ({ i, at }) =>
          new Graphic({
            geometry: new Point({ longitude: at[0], latitude: at[1] }),
            symbol: new SimpleMarkerSymbol({ size: 8, color: [255, 77, 77, 1], outline: { color: "white", width: 1.5 } }),
            attributes: { __i: i },
          }),
      ),
    );

    const extent = polygons.reduce<Extent | null>((acc, g) => (acc ? acc.union(g.geometry!.extent!) : g.geometry!.extent!.clone()), null);
    if (extent) view.when(() => view.goTo({ target: extent.expand(1.1) }, { duration: 700 }).catch(() => undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features]);

  // ---- appearance -------------------------------------------------------------------------------
  useEffect(() => {
    graphicsRef.current.forEach((g, i) => {
      g.symbol = symbolFor(stateOf(i), i === hovered || i === selected);
    });
    // Skipped duplicates often sit exactly on the parcel they repeat: hide their number.
    parcelsRef.current?.graphics.forEach((g) => {
      if (g.attributes?.label) g.visible = !skipped.has(g.attributes.__i);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, selected, appended, skipped, features]);

  // ---- selection: zoom to the parcel and show its attributes ---------------------------------------
  useEffect(() => {
    const view = viewRef.current;
    const graphic = selected === null ? null : graphicsRef.current[selected];
    if (!view || !graphic || selected === null) return;
    const polygon = graphic.geometry as Polygon;
    view
      .goTo({ target: polygon.extent!.expand(2.5) }, { duration: 600 })
      .then(() =>
        view.openPopup({
          title: propsRef.current.labels[selected] ?? `Parcel ${selected + 1}`,
          content: popupHtml(propsRef.current.features?.[selected]?.properties ?? {}),
          location: polygon.centroid ?? polygon.extent!.center,
        }),
      )
      .catch(() => undefined);
  }, [selected]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="Map of the parcels" />;
}

function popupHtml(properties: Record<string, unknown>): HTMLElement {
  const entries = Object.entries(properties).filter(([k]) => !k.startsWith("__"));
  const table = document.createElement("table");
  table.style.fontSize = "12px";
  for (const [k, v] of entries.slice(0, MAX_POPUP_ROWS)) {
    const row = table.insertRow();
    const key = row.insertCell();
    key.textContent = k;
    key.style.cssText = "padding:3px 14px 3px 0;color:#6b6b6b;vertical-align:top";
    const value = row.insertCell();
    value.textContent = formatValue(v);
  }
  if (entries.length === 0) table.insertRow().insertCell().textContent = "No attributes in the file";
  return table;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
