declare module "shpjs" {
  import type { FeatureCollection } from "geojson";

  export type ShpFeatureCollection = FeatureCollection & { fileName?: string };

  interface ShpParts {
    shp: ArrayBuffer | ArrayBufferView;
    dbf?: ArrayBuffer | ArrayBufferView;
    prj?: ArrayBuffer | ArrayBufferView | string;
    cpg?: ArrayBuffer | ArrayBufferView | string;
  }

  /** Parses a zipped shapefile (or its parts) into WGS84 GeoJSON, reprojecting via the .prj if present. */
  export default function shp(
    input: string | ArrayBuffer | ArrayBufferView | ShpParts,
  ): Promise<ShpFeatureCollection | ShpFeatureCollection[]>;
}
