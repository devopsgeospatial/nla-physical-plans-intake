import "server-only";

/**
 * One codebase, three deployments:
 * - "submission": district planners upload plans and read NLA's response.
 * - "review": NLA reviewers approve plans or return them to the planner with comments.
 * - "home": the landing page linking to both (no ArcGIS settings needed).
 * - "public": citizens look up a parcel (UPI) against the approved physical plans; no sign-in.
 */
export type AppMode = "submission" | "review" | "home" | "public";

export interface ArcGisConfig {
  appMode: AppMode;
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
  /** Review app: members of this ArcGIS group may review (organization administrators always may). */
  reviewerGroupId?: string;
  /** Review app: submissions created before this time (epoch ms) are not listed (older, imported records). */
  reviewSince: number;
  geometryServiceUrl?: string;
  /** ArcGIS Online web map shown behind the parcels (basemap + layers as configured in Map Viewer). */
  webMapId: string;
  /** Portal the web map is loaded from (normally the organization portal). */
  webMapPortalUrl: string;
}

/** "Physical Plans Map" on rla.maps.arcgis.com (World Imagery + district and sector boundaries). */
const DEFAULT_WEBMAP_ID = "04d76651f4a046f7be88c7d072780f19";

/** The app went live on this day; the 3,220 Muhanga parcels imported before it are not submissions. */
const DEFAULT_REVIEW_SINCE = "2026-10-01";

export function getAppMode(): AppMode {
  const mode = process.env.APP_MODE;
  return mode === "review" || mode === "home" || mode === "public" ? mode : "submission";
}

export interface PublicConfig {
  portalUrl: string;
  /** The Physical_Plans layer. */
  planLayerUrl: string;
  /** Plans the public may see. Applied on the server and to the map, whatever the web map's own filter. */
  planFilter: string;
  /** Default web map of the public viewer ("Physical Plan Map"). */
  webMapId: string;
  /** Only this district (slug) is served, for a deployment dedicated to one district. */
  lockedDistrict?: string;
  /** Optional ArcGIS API key, only needed if the layers stop being shared publicly. */
  apiKey?: string;
  appUrl: string;
  /** Rwanda's district boundaries: which district an approved plan lies in, and each district's map extent. */
  districtsLayerUrl: string;
  /**
   * Site plan boundaries. Each site is one polygon (fields `site_name`, `site_stage`); the approved
   * parcels inside it are the site's subdivided parcels.
   */
  sitesLayerUrls: string[];
}

export function getPublicConfig(): PublicConfig {
  return {
    portalUrl: trimSlash(process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com"),
    planLayerUrl: trimSlash(
      process.env.ARCGIS_FEATURE_LAYER_URL || "https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/Physical_Plans/FeatureServer/0",
    ),
    planFilter: process.env.PUBLIC_PLAN_FILTER || "approval_date IS NOT NULL",
    webMapId: process.env.PUBLIC_WEBMAP_ID || "83361399512f417580bd31a1d855be89",
    lockedDistrict: process.env.PUBLIC_DISTRICT?.toLowerCase() || undefined,
    apiKey: process.env.ARCGIS_API_KEY || undefined,
    appUrl: trimSlash(process.env.APP_URL || "http://localhost:3000"),
    districtsLayerUrl: trimSlash(
      process.env.PUBLIC_DISTRICTS_LAYER_URL || "https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/District_boundary_eca06/FeatureServer/0",
    ),
    sitesLayerUrls: (process.env.PUBLIC_SITES_LAYER_URLS || "https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/Phyisical_Plan_Muhanga/FeatureServer/4")
      .split(",")
      .map((u) => trimSlash(u.trim()))
      .filter(Boolean),
  };
}

/** Where the landing page sends people. */
export function getAppLinks(): { homeUrl: string; submissionUrl: string; reviewUrl: string; publicUrl: string } {
  return {
    homeUrl: process.env.HOME_APP_URL || "https://nla-physical-plans-home.vercel.app",
    submissionUrl: process.env.SUBMISSION_APP_URL || "https://nla-physical-plans.vercel.app/",
    reviewUrl: process.env.REVIEW_APP_URL || "https://nla-physical-plans-review.vercel.app",
    publicUrl: process.env.PUBLIC_APP_URL || "https://nla-physical-plans-public.vercel.app",
  };
}

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
    appMode: getAppMode(),
    portalUrl: trimSlash(required("ARCGIS_PORTAL_URL")),
    featureLayerUrl: trimSlash(required("ARCGIS_FEATURE_LAYER_URL")),
    appUrl,
    oauthClientId: required("ARCGIS_OAUTH_CLIENT_ID"),
    oauthRedirectUri: process.env.ARCGIS_OAUTH_REDIRECT_URI || `${appUrl}/api/auth/callback`,
    sessionMinutes: positiveInt("SESSION_MINUTES", 20160),
    sessionSecret: required("SESSION_SECRET"),
    allowedGroupId: process.env.ARCGIS_ALLOWED_GROUP_ID || undefined,
    reviewerGroupId: process.env.ARCGIS_REVIEWER_GROUP_ID || undefined,
    reviewSince: Date.parse(`${process.env.REVIEW_SINCE || DEFAULT_REVIEW_SINCE}T00:00:00Z`),
    geometryServiceUrl: process.env.ARCGIS_GEOMETRY_SERVICE_URL ? trimSlash(process.env.ARCGIS_GEOMETRY_SERVICE_URL) : undefined,
    webMapId: process.env.ARCGIS_WEBMAP_ID || DEFAULT_WEBMAP_ID,
    webMapPortalUrl: "",
  };
  // The local emulator stands in for the portal's REST API but not for web maps.
  config.webMapPortalUrl = trimSlash(process.env.ARCGIS_WEBMAP_PORTAL_URL || config.portalUrl);

  if (!Number.isFinite(config.reviewSince)) throw new ConfigurationError("REVIEW_SINCE must be a date such as 2026-10-01.");
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
