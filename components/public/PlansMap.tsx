"use client";

import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Graphic from "@arcgis/core/Graphic";
import type Extent from "@arcgis/core/geometry/Extent";
import Polygon from "@arcgis/core/geometry/Polygon";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import FeatureFilter from "@arcgis/core/layers/support/FeatureFilter";
import SimpleRenderer from "@arcgis/core/renderers/SimpleRenderer";
import type UniqueValueRenderer from "@arcgis/core/renderers/UniqueValueRenderer";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
import MapView from "@arcgis/core/views/MapView";
import type FeatureLayerView from "@arcgis/core/views/layers/FeatureLayerView";
import type Viewpoint from "@arcgis/core/Viewpoint";
import type Basemap from "@arcgis/core/Basemap";
import Portal from "@arcgis/core/portal/Portal";
import WebMap from "@arcgis/core/WebMap";
import type { MultiPolygon, Polygon as GeoJsonPolygon } from "geojson";
import type { MapSettings } from "@/lib/arcgis/config";
import { geoJsonToEsriPolygon, type EsriPolygon } from "@/lib/geo/esri-geometry";
import { SITE_NAME_FIELD, SITE_STAGE_FIELD, siteNameFromLayer, stageOf, STAGES, type PlanStatus } from "@/lib/public/stages";

/** One site plan in the district, with the approved parcels it was subdivided into. */
export interface Site {
  key: string;
  name: string;
  /** 1–5 from `site_stage`, or null when not recorded yet. */
  stage: number | null;
  status: PlanStatus | null;
  geometry: Polygon;
  parcelIds: number[];
  parcels: number;
  hectares: number;
  layer: FeatureLayer;
  objectId: number;
}

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
  /** Sites chosen in Explore (by stage, status or name), or null for all: the map shows and frames only them. */
  selectedSites: string[] | null;
  /** Colour the site plans by their stage. */
  byStage: boolean;
  parcel: GeoJsonPolygon | MultiPolygon | null;
  padding: { top: number; left: number; bottom: number };
  onReady: (handles: MapHandles) => void;
  /** The district's sites, once loaded (after the map is ready). */
  onSites: (sites: Site[]) => void;
  onPick: (lon: number, lat: number) => void;
}

const serviceUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
const SITE_OUTLINE = new SimpleRenderer({
  symbol: new SimpleFillSymbol({ color: [23, 160, 219, 0.06], outline: { color: [23, 160, 219, 1], width: 2.2 } }),
});

export default function PlansMap({ map, planLayerUrl, baseFilter, boundary, sitesLayerUrls, selectedSites, byStage, parcel, padding, onReady, onSites, onPick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const stateRef = useRef<{ plansView: FeatureLayerView; sites: Site[]; siteViews: Map<FeatureLayer, FeatureLayerView>; stageLayer: GraphicsLayer; districtExtent: Extent } | null>(null);
  const parcelLayerRef = useRef<GraphicsLayer | null>(null);
  const latest = useRef({ onReady, onSites, onPick, selectedSites, byStage });
  latest.current = { onReady, onSites, onPick, selectedSites, byStage };

  useEffect(() => {
    if (!containerRef.current) return;
    esriConfig.portalUrl = map.portalUrl;
    const webmap = new WebMap({ portalItem: { id: map.webMapId } });
    const parcelLayer = new GraphicsLayer({ title: "Searched parcel", listMode: "hide" });
    const stageLayer = new GraphicsLayer({ title: "Site stages", listMode: "hide", visible: false });
    const districtLayer = new GraphicsLayer({ title: "District boundary", listMode: "hide" });
    const view = new MapView({ container: containerRef.current, map: webmap, popupEnabled: false, constraints: { snapToZoom: false } });
    // The app draws its own map controls; only the attribution (required by Esri) stays.
    view.ui.components = [];
    const district = Polygon.fromJSON(boundary);
    let start: Viewpoint | Extent | null = null;
    const home = () => {
      if (start) view.goTo(start, { duration: 900 }).catch(() => undefined);
    };
    viewRef.current = view;
    parcelLayerRef.current = parcelLayer;
    let cancelled = false;

    view
      .when(async () => {
        districtLayer.add(new Graphic({ geometry: district, symbol: new SimpleFillSymbol({ color: [0, 0, 0, 0], outline: { color: [255, 255, 255, 0.85], width: 1.5, style: "dash" } }) }));
        webmap.addMany([districtLayer, stageLayer, parcelLayer]);

        const plans = webmap.allLayers.find((l) => l.type === "feature" && serviceUrl((l as FeatureLayer).url ?? "") === serviceUrl(planLayerUrl).replace(/\/\d+$/, "")) as
          | FeatureLayer
          | undefined;
        if (!plans || cancelled) return;
        await plans.load();
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
        const plansView = await view.whenLayerView(plans);

        // Open on the district's approved plans (or the whole district when there are none yet).
        const planExtent = await plans.queryExtent({ where: baseFilter, geometry: district, spatialRelationship: "intersects" }).catch(() => null);
        const districtExtent = planExtent && planExtent.count > 0 && planExtent.extent ? planExtent.extent.expand(1.3) : district.extent!.expand(1.05);
        start = districtExtent;
        await view.goTo(districtExtent, { animate: false }).catch(() => undefined);

        const basemaps = async () => {
          const portal = Portal.getDefault();
          await portal.load();
          // Loading each one fills in its title and thumbnail from its portal item.
          const list = await portal.fetchBasemaps();
          const loaded = await Promise.all(list.map((b) => b.load().then(() => b, () => null)));
          return loaded.filter((b): b is Basemap => b !== null);
        };
        // The map and district figures first; the sites (heavier) follow.
        latest.current.onReady({ view, home, basemaps, plans, district });
        const { sites, siteViews } = await loadSites(webmap, view, sitesLayerUrls, district, plans, baseFilter);
        if (cancelled) return;
        stateRef.current = { plansView, sites, siteViews, stageLayer, districtExtent };
        drawStages(stageLayer, sites);
        apply(false);
        latest.current.onSites(sites);
      })
      .catch((err) => console.error("[map] web map failed to load", err));

    const click = view.on("click", (event) => {
      const { longitude, latitude } = event.mapPoint ?? {};
      if (typeof longitude === "number" && typeof latitude === "number") latest.current.onPick(longitude, latitude);
    });
    return () => {
      cancelled = true;
      click.remove();
      view.destroy();
      viewRef.current = null;
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.portalUrl, map.webMapId, planLayerUrl, baseFilter]);

  /** Shows only the chosen sites and their parcels, and frames them. */
  function apply(zoom: boolean) {
    const state = stateRef.current;
    const view = viewRef.current;
    if (!state || !view) return;
    const { selectedSites: keys, byStage: colour } = latest.current;
    const chosen = keys ? state.sites.filter((s) => keys.includes(s.key)) : null;

    state.plansView.filter = chosen ? new FeatureFilter({ objectIds: chosen.flatMap((s) => s.parcelIds).concat(-1) }) : null;
    for (const [layer, layerView] of state.siteViews) {
      const ids = chosen?.filter((s) => s.layer === layer).map((s) => s.objectId);
      layerView.filter = ids ? new FeatureFilter({ objectIds: ids.concat(-1) }) : null;
    }
    state.stageLayer.visible = colour;
    state.stageLayer.graphics.forEach((g) => (g.visible = !chosen || chosen.some((s) => s.key === g.attributes?.key)));

    if (!zoom) return;
    if (chosen && chosen.length > 0) {
      const extent = chosen.reduce<Extent | null>((acc, s) => (acc ? acc.union(s.geometry.extent!) : s.geometry.extent!.clone()), null);
      if (extent) view.goTo(extent.expand(1.35), { duration: 900 }).catch(() => undefined);
    } else if (!chosen) {
      view.goTo(state.districtExtent, { duration: 900 }).catch(() => undefined);
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

/**
 * The site plans in the district, from each site layer (used from the web map when it is there, added
 * otherwise), each with the approved parcels inside it.
 */
async function loadSites(webmap: WebMap, view: MapView, urls: string[], district: Polygon, plans: FeatureLayer, baseFilter: string) {
  const sites: Site[] = [];
  const siteViews = new Map<FeatureLayer, FeatureLayerView>();
  for (const url of urls) {
    try {
      let layer = webmap.allLayers.find((l) => l.type === "feature" && serviceUrl((l as FeatureLayer).url ?? "") + `/${(l as FeatureLayer).layerId}` === serviceUrl(url)) as
        | FeatureLayer
        | undefined;
      if (!layer) {
        layer = new FeatureLayer({ url, renderer: SITE_OUTLINE, popupEnabled: false });
        webmap.add(layer, webmap.layers.indexOf(plans));
      }
      await layer.load();
      layer.visible = true;
      const field = (name: string) => layer!.fields.find((f) => f.name.toLowerCase() === name)?.name;
      const nameField = field(SITE_NAME_FIELD);
      const stageField = field(SITE_STAGE_FIELD);
      const result = await layer.queryFeatures({
        where: "1=1",
        geometry: district,
        spatialRelationship: "intersects",
        outFields: [layer.objectIdField, nameField, stageField].filter((f): f is string => !!f),
        returnGeometry: true,
        outSpatialReference: view.spatialReference,
        // Site outlines are very detailed; ~1 m is plenty to find their parcels and frame them, and keeps queries quick.
        maxAllowableOffset: 1,
      });
      const layerName = siteNameFromLayer(layer.title || layer.sourceJSON?.name || "Site");
      const unnamed = result.features.filter((f) => !String((nameField && f.attributes[nameField]) ?? "").trim()).length;
      let n = 0;
      const loaded = await Promise.all(
        result.features.map(async (f) => {
          const geometry = f.geometry as Polygon;
          const [parcelIds, stats] = await Promise.all([
            plans.queryObjectIds({ where: baseFilter, geometry, spatialRelationship: "intersects" }).catch(() => [] as number[]),
            plans
              .queryFeatures({
                where: baseFilter,
                geometry,
                spatialRelationship: "intersects",
                outStatistics: [{ statisticType: "sum", onStatisticField: "area_sqm", outStatisticFieldName: "a" }],
              })
              .catch(() => null),
          ]);
          return { f, geometry, parcelIds: (parcelIds ?? []).map(Number), hectares: Number(stats?.features[0]?.attributes.a ?? 0) / 10_000 };
        }),
      );
      for (const { f, geometry, parcelIds, hectares } of loaded) {
        const named = nameField ? String(f.attributes[nameField] ?? "").trim() : "";
        const stage = stageField ? stageOf(f.attributes[stageField]) : null;
        const objectId = Number(f.attributes[layer.objectIdField]);
        sites.push({
          key: `${layer.url}/${layer.layerId}#${objectId}`,
          name: named || (unnamed > 1 ? `${layerName} ${++n}` : layerName),
          stage: stage?.n ?? null,
          status: stage?.status ?? null,
          geometry,
          parcelIds,
          parcels: parcelIds.length,
          hectares,
          layer,
          objectId,
        });
      }
      siteViews.set(layer, await view.whenLayerView(layer));
    } catch (err) {
      console.warn(`[map] site layer ${url} could not be loaded`, err);
    }
  }
  return { sites: sites.sort((a, b) => a.name.localeCompare(b.name)), siteViews };
}

/** Each site filled with its stage colour (shown when "Colour sites by stage" is on). */
function drawStages(layer: GraphicsLayer, sites: Site[]) {
  const fill = (hex: string, alpha: number) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
  layer.addMany(
    sites.map((s) => {
      const color = STAGES.find((x) => x.n === s.stage)?.color ?? "#a8b4bd";
      return new Graphic({
        geometry: s.geometry,
        attributes: { key: s.key },
        symbol: new SimpleFillSymbol({ color: fill(color, 0.45), outline: { color: fill(color, 1), width: 2.5 } }),
      });
    }),
  );
}
