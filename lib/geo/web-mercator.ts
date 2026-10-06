/** Spherical Web Mercator (EPSG:3857 / ESRI 102100) forward and inverse projection. */

const EARTH_RADIUS = 6378137;
const MAX_LATITUDE = 85.0511287798066;
const DEG = Math.PI / 180;

export const WEB_MERCATOR_WKIDS: ReadonlySet<number> = new Set([3857, 102100, 102113, 900913, 3785]);
export const WGS84_WKIDS: ReadonlySet<number> = new Set([4326]);

export function lonLatToWebMercator([lon, lat]: readonly [number, number]): [number, number] {
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const x = EARTH_RADIUS * lon * DEG;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG) / 2));
  return [x, y];
}

export function webMercatorToLonLat([x, y]: readonly [number, number]): [number, number] {
  const lon = x / EARTH_RADIUS / DEG;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG;
  return [lon, lat];
}
