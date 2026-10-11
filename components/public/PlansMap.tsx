"use client";

import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Graphic from "@arcgis/core/Graphic";
import Extent from "@arcgis/core/geometry/Extent";
import Polygon from "@arcgis/core/geometry/Polygon";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import FeatureFilter from "@arcgis/core/layers/support/FeatureFilter";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer";
import type UniqueValueRenderer from "@arcgis/core/renderers/UniqueValueRenderer";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
import MapView from "@arcgis/core/views/MapView";
import type FeatureLayerView from "@arcgis/core/views/layers/FeatureLayerView";
import Basemap from "@arcgis/core/Basemap";
import TileLayer from "@arcgis/core/layers/TileLayer";
import Portal from "@arcgis/core/portal/Portal";
import WebMap from "@arcgis/core/WebMap";
import type { MultiPolygon, Polygon as GeoJsonPolygon } from "geojson";
import type { MapSettings } from "@/lib/arcgis/config";
import { geoJsonToEsriPolygon, type EsriPolygon } from "@/lib/geo/esri-geometry";
import type { SiteData } from "@/lib/public/summary";
import { STAGES } from "@/lib/public/stages";

/** One site plan in the district, with the approved parcels it was subdivided into (from /api/public/summary). */
export type Site = SiteData;

export interface MapHandles {
  view: MapView;
  /** Back to the district. */
  home: () => void;
  /** The organisation's basemap gallery, as in Map Viewer. */
  basemaps: () => Promise<Basemap[]>;
  plans: FeatureLayer;
  /** The district boundary, for district-wide queries. */
  district: Polygon;
}

interface Props {
  map: MapSettings;
  planLayerUrl: string;
  /** Plans the public may see (approved): applied to the layer itself, whatever the web map's filter. */
  baseFilter: string;
  /** District boundary (WGS84 ArcGIS JSON). */
  boundary: EsriPolygon;
  sitesLayerUrls: string[];
  /** The district's sites (from the server summary), or null while loading. */
  sites: Site[] | null;
  /** Where the district's approved plans are ([xmin, ymin, xmax, ymax], WGS84), once known. */
  planExtent: [number, number, number, number] | null;
  /** Sites chosen in Explore (by stage, status or name), or null for all: the map shows and frames only them. */
  selectedSites: string[] | null;
  /** Colour the site plans by their stage. */
  byStage: boolean;
  parcel: GeoJsonPolygon | MultiPolygon | null;
  padding: { top: number; left: number; bottom: number };
  onReady: (handles: MapHandles) => void;
  onPick: (lon: number, lat: number) => void;
}

/** Esri World Imagery, readable without sign-in or API key. */
const PUBLIC_IMAGERY = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const serviceUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
const SITE_OUTLINE = new SimpleRenderer({
  symbol: new SimpleFillSymbol({ color: [23, 160, 219, 0.06], outline: { color: [23, 160, 219, 1], width: 2.2 } }),
});
const wgs84Extent = ([xmin, ymin, xmax, ymax]: [number, number, number, number]) => new Extent({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } });

export default function PlansMap(props: Props) {
  const { map, planLayerUrl, baseFilter, boundary, sitesLayerUrls, sites, planExtent, selectedSites, byStage, parcel, padding } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  /** Layer views used for filters, keyed by layer URL ("plans" for the plans layer). */
  const layerViews = useRef(new Map<string, FeatureLayerView>());
  const stageLayerRef = useRef<GraphicsLayer | null>(null);
  const parcelLayerRef = useRef<GraphicsLayer | null>(null);
  const startRef = useRef<Extent | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!containerRef.current) return;
    esriConfig.portalUrl = map.portalUrl;
    // A public map never asks citizens to sign in to ArcGIS: anything not shared publicly is skipped.
    esriConfig.request.useIdentity = false;
    const district = Polygon.fromJSON(boundary);
    const parcelLayer = new GraphicsLayer({ title: "Searched parcel", listMode: "hide" });
    const stageLayer = new GraphicsLayer({ title: "Site stages", listMode: "hide", visible: false });
    const districtLayer = new GraphicsLayer({ title: "District boundary", listMode: "hide" });
    districtLayer.add(new Graphic({ geometry: district, symbol: new SimpleFillSymbol({ color: [0, 0, 0, 0], outline: { color: [255, 255, 255, 0.85], width: 1.5, style: "dash" } }) }));
    // The map opens on the district straight away; nothing waits for ArcGIS queries.
    startRef.current = district.extent!.expand(1.05);
    const view = new MapView({ container: containerRef.current, extent: startRef.current ?? undefined, popupEnabled: false, constraints: { snapToZoom: false } });
    // The app draws its own map controls; only the attribution (required by Esri) stays.
    view.ui.components = [];
    viewRef.current = view;
    stageLayerRef.current = stageLayer;
    parcelLayerRef.current = parcelLayer;
    const views = layerViews.current;
    views.clear();
    let cancelled = false;

    (async () => {
      // The district's web map; Esri's public imagery when the web map is not shared publicly.
      let webmap = new WebMap({ portalItem: { id: map.webMapId } });
      try {
        await webmap.load();
      } catch (err) {
        console.warn("[map] web map unavailable (is it shared publicly?); showing imagery only", err);
        webmap = new WebMap({ basemap: new Basemap({ title: "Imagery", baseLayers: [new TileLayer({ url: PUBLIC_IMAGERY })] }) });
      }
      if (cancelled) return;
      webmap.addMany([districtLayer, stageLayer, parcelLayer]);
      view.map = webmap;

      // Layers citizens may not open (e.g. the private editable plans layer) are dropped, not shown broken.
      const operational = webmap.layers.toArray().filter((l) => ![districtLayer, stageLayer, parcelLayer].includes(l as GraphicsLayer));
      void Promise.allSettled(operational.map((l) => l.load())).then(() => webmap.removeMany(operational.filter((l) => l.loadStatus === "failed")));

      // The plans layer from the web map (keeps its zoning colours); added by address when the web map lacks it.
      let plans = webmap.allLayers.find((l) => l.type === "feature" && serviceUrl((l as FeatureLayer).url ?? "") === serviceUrl(planLayerUrl).replace(/\/\d+$/, "")) as
        | FeatureLayer
        | undefined;
      if (!plans) {
        plans = new FeatureLayer({ url: planLayerUrl, title: "Physical plans", popupEnabled: false });
        webmap.add(plans, webmap.layers.indexOf(districtLayer));
      }
      // Site boundaries: from the web map when it has them, added otherwise (drawing only, no queries).
      const siteLayers = sitesLayerUrls.map((url) => {
        const found = webmap.allLayers.find((l) => l.type === "feature" && `${serviceUrl((l as FeatureLayer).url ?? "")}/${(l as FeatureLayer).layerId}` === serviceUrl(url)) as
          | FeatureLayer
          | undefined;
        const layer = found ?? new FeatureLayer({ url, renderer: SITE_OUTLINE, popupEnabled: false });
        if (!found) webmap.add(layer, webmap.layers.indexOf(plans!));
        layer.visible = true;
        return { url, layer };
      });

      await plans.load();
      if (cancelled) return;
      // After load: loading applies the web map's own layer definition, which would replace it.
      plans.definitionExpression = baseFilter;
      plans.visible = true;
      // The web map colours plans by zoning; plans without a zoning value would not be drawn at all.
      const renderer = plans.renderer as UniqueValueRenderer | null;
      if (renderer?.type === "unique-value" && !renderer.defaultSymbol) {
        const withDefault = renderer.clone();
        withDefault.defaultSymbol = new SimpleFillSymbol({ color: [23, 160, 219, 0.35], outline: { color: [255, 255, 255, 0.9], width: 0.6 } });
        withDefault.defaultLabel = "Approved plan (zoning not recorded)";
        plans.renderer = withDefault;
      }

      const basemaps = async () => {
        const portal = Portal.getDefault();
        await portal.load();
        // Loading each one fills in its title and thumbnail from its portal item.
        const list = await portal.fetchBasemaps();
        const loaded = await Promise.all(list.map((b) => b.load().then(() => b, () => null)));
        return loaded.filter((b): b is Basemap => b !== null);
      };
      const home = () => {
        if (startRef.current) view.goTo(startRef.current, { duration: 900 }).catch(() => undefined);
      };
      latest.current.onReady({ view, home, basemaps, plans, district });

      // Layer views for the Explore filters, as each becomes ready.
      void view.whenLayerView(plans).then((lv) => {
        views.set("plans", lv);
        apply(false);
      });
      for (const { url, layer } of siteLayers) {
        void view
          .whenLayerView(layer)
          .then((lv) => {
            views.set(serviceUrl(url), lv);
            apply(false);
          })
          .catch((err) => console.warn(`[map] site layer ${url} unavailable`, err));
      }
    })().catch((err) => console.error("[map] web map failed to load", err));

    const click = view.on("click", (event) => {
      const { longitude, latitude } = event.mapPoint ?? {};
      if (typeof longitude === "number" && typeof latitude === "number") latest.current.onPick(longitude, latitude);
    });
    return () => {
      cancelled = true;
      click.remove();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.portalUrl, map.webMapId, planLayerUrl, baseFilter]);

  // Once the district's plans are known, open on them (unless the visitor has already moved on to a parcel).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !planExtent) return;
    startRef.current = wgs84Extent(planExtent).expand(1.3);
    if (!latest.current.parcel && !latest.current.selectedSites) view.when(() => view.goTo(startRef.current!, { duration: 600 }).catch(() => undefined));
  }, [planExtent]);

  // Each site filled with its stage colour (shown when "Colour sites by stage" is on).
  useEffect(() => {
    const layer = stageLayerRef.current;
    if (!layer || !sites) return;
    const fill = (hex: string, alpha: number) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
    layer.removeAll();
    layer.addMany(
      sites.map((s) => {
        const color = STAGES.find((x) => x.n === s.stage)?.color ?? "#a8b4bd";
        return new Graphic({
          geometry: new Polygon({ rings: s.rings, spatialReference: { wkid: 4326 } }),
          attributes: { key: s.key },
          symbol: new SimpleFillSymbol({ color: fill(color, 0.45), outline: { color: fill(color, 1), width: 2.5 } }),
        });
      }),
    );
    apply(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites]);

  /** Shows only the chosen sites and their parcels, and frames them. */
  function apply(zoom: boolean) {
    const view = viewRef.current;
    const { sites: all, selectedSites: keys, byStage: colour } = latest.current;
    if (!view || !all) return;
    const chosen = keys ? all.filter((s) => keys.includes(s.key)) : null;

    const plansView = layerViews.current.get("plans");
    if (plansView) plansView.filter = chosen ? new FeatureFilter({ objectIds: chosen.flatMap((s) => s.parcelIds).concat(-1) }) : null;
    for (const [url, layerView] of layerViews.current) {
      if (url === "plans") continue;
      const ids = chosen?.filter((s) => serviceUrl(s.layerUrl) === url).map((s) => s.objectId);
      layerView.filter = ids ? new FeatureFilter({ objectIds: ids.concat(-1) }) : null;
    }
    if (stageLayerRef.current) {
      stageLayerRef.current.visible = colour;
      stageLayerRef.current.graphics.forEach((g) => (g.visible = !chosen || chosen.some((s) => s.key === g.attributes?.key)));
    }

    if (!zoom) return;
    if (chosen && chosen.length > 0) {
      const extent = chosen.map((s) => wgs84Extent(s.extent)).reduce((acc, e) => acc.union(e));
      view.goTo(extent.expand(1.35), { duration: 900 }).catch(() => undefined);
    } else if (!chosen && startRef.current) {
      view.goTo(startRef.current, { duration: 900 }).catch(() => undefined);
    }
  }

  const selectionKey = selectedSites ? selectedSites.join("|") : null;
  useEffect(() => apply(true), [selectionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => apply(false), [byStage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewRef.current) viewRef.current.padding = { right: 0, ...padding };
  }, [padding]);

  useEffect(() => {
    const view = viewRef.current;
    const layer = parcelLayerRef.current;
    if (!view || !layer) return;
    layer.removeAll();
    if (!parcel) return;
    const polygon = new Polygon({ rings: geoJsonToEsriPolygon(parcel).rings, spatialReference: { wkid: 4326 } });
    layer.addMany([
      new Graphic({ geometry: polygon, symbol: new SimpleFillSymbol({ color: [23, 160, 219, 0.16], outline: { color: [255, 255, 255, 0.95], width: 6 } }) }),
      new Graphic({ geometry: polygon, symbol: new SimpleFillSymbol({ color: [0, 0, 0, 0], outline: { color: [23, 160, 219, 1], width: 3 } }) }),
    ]);
    view.when(() => view.goTo({ target: polygon.extent!.expand(3.5) }, { duration: 800 }).catch(() => undefined));
  }, [parcel]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="Map of the physical plans" />;
}
