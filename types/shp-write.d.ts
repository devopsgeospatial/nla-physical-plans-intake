declare module "@mapbox/shp-write" {
  interface ZipOptions {
    folder?: string;
    filename?: string;
    outputType?: "base64" | "blob" | "nodebuffer" | "arraybuffer" | "uint8array";
    compression?: "STORE" | "DEFLATE";
    types?: { point?: string; polygon?: string; polyline?: string };
  }
  const shpwrite: { zip(geojson: object, options?: ZipOptions): Promise<unknown> };
  export default shpwrite;
}
