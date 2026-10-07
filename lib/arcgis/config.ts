import "server-only";

export interface ArcGisConfig {
  portalUrl: string;
  featureLayerUrl: string;
  /** Public base URL of this app, e.g. http://localhost:3000. Also sent as Referer on REST calls. */
  appUrl: string;
  oauthClientId: string;
  oauthRedirectUri: string;
  /** Refresh-token lifetime requested at sign-in (minutes, ArcGIS Online max 20160 = 2 weeks). */
  sessionMinutes: number;
  /** 32+ character secret used to encrypt the session cookie. */
  sessionSecret: string;
  /** If set, only members of this ArcGIS group may sign in. */
  allowedGroupId?: string;
  geometryServiceUrl?: string;
  /** ArcGIS Online web map shown behind the parcels (basemap + layers as configured in Map Viewer). */
  webMapId: string;
  /** Portal the web map is loaded from (normally the organization portal). */
  webMapPortalUrl: string;
}

/** "Physical Plans Map" on rla.maps.arcgis.com (World Imagery + district and sector boundaries). */
const DEFAULT_WEBMAP_ID = "04d76651f4a046f7be88c7d072780f19";

/** What the browser needs to load the web map. */
export interface MapSettings {
  portalUrl: string;
  webMapId: string;
}

export interface UploadLimits {
  maxBoundaryBytes: number;
  maxPdfBytes: number;
  maxPdfCount: number;
  /** Whole multipart request. Set MAX_REQUEST_BYTES on hosts with a body limit (Vercel functions: 4.5 MB). */
  maxRequestBytes: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Read on every call (cheap), so edits to .env.local are picked up by `next dev` without a restart. */
export function getArcGisConfig(): ArcGisConfig {
  const appUrl = trimSlash(process.env.APP_URL || "http://localhost:3000");
  const config: ArcGisConfig = {
    portalUrl: trimSlash(required("ARCGIS_PORTAL_URL")),
    featureLayerUrl: trimSlash(required("ARCGIS_FEATURE_LAYER_URL")),
    appUrl,
    oauthClientId: required("ARCGIS_OAUTH_CLIENT_ID"),
    oauthRedirectUri: process.env.ARCGIS_OAUTH_REDIRECT_URI || `${appUrl}/api/auth/callback`,
    sessionMinutes: positiveInt("SESSION_MINUTES", 20160),
    sessionSecret: required("SESSION_SECRET"),
    allowedGroupId: process.env.ARCGIS_ALLOWED_GROUP_ID || undefined,
    geometryServiceUrl: process.env.ARCGIS_GEOMETRY_SERVICE_URL ? trimSlash(process.env.ARCGIS_GEOMETRY_SERVICE_URL) : undefined,
    webMapId: process.env.ARCGIS_WEBMAP_ID || DEFAULT_WEBMAP_ID,
    webMapPortalUrl: "",
  };
  // The local emulator stands in for the portal's REST API but not for web maps.
  config.webMapPortalUrl = trimSlash(process.env.ARCGIS_WEBMAP_PORTAL_URL || config.portalUrl);

  if (config.sessionSecret.length < 32) throw new ConfigurationError("SESSION_SECRET must be at least 32 characters.");
  if (!/\/FeatureServer\/\d+$/i.test(config.featureLayerUrl)) {
    throw new ConfigurationError(
      "ARCGIS_FEATURE_LAYER_URL must point at a layer, e.g. https://services.arcgis.com/<orgId>/arcgis/rest/services/Name/FeatureServer/0",
    );
  }

  return config;
}

export function getUploadLimits(): UploadLimits {
  const maxBoundaryBytes = positiveInt("MAX_BOUNDARY_BYTES", 10 * 1024 * 1024);
  const maxPdfBytes = positiveInt("MAX_PDF_BYTES", 25 * 1024 * 1024);
  const maxPdfCount = positiveInt("MAX_PDF_COUNT", 5);
  return {
    maxBoundaryBytes,
    maxPdfBytes,
    maxPdfCount,
    maxRequestBytes: positiveInt("MAX_REQUEST_BYTES", maxBoundaryBytes + maxPdfBytes * maxPdfCount + 64 * 1024),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}.`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive integer.`);
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
