import area from "@turf/area";
import { feature } from "@turf/helpers";
import unkinkPolygon from "@turf/unkink-polygon";
import type { MultiPolygon, Polygon } from "geojson";

/** Below this, a piece split off a self-crossing ring is a digitising sliver and is dropped (m²). */
const MIN_PIECE_SQ_M = 0.01;

/**
 * Repairs a self-intersecting polygon without any service: every self-crossing ring is split at its
 * crossings into simple rings (a figure-eight becomes its two loops), and the pieces are returned as one
 * multipart polygon. Used when the ArcGIS geometry service cannot be reached. If the geometry cannot be
 * split, it is returned unchanged: the hosted layer stores it as it is.
 */
export function repairSelfIntersections(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  try {
    const pieces = unkinkPolygon(feature(geometry)).features.map((f) => f.geometry).filter((g) => area(g) >= MIN_PIECE_SQ_M);
    if (pieces.length === 0) return geometry;
    if (pieces.length === 1) return pieces[0]!;
    return { type: "MultiPolygon", coordinates: pieces.map((p) => p.coordinates) };
  } catch {
    return geometry;
  }
}
