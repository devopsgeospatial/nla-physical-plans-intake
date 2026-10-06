/**
 * Creates the hosted feature service + polygon layer the app writes to: coded-value domains,
 * attachments enabled and a status-driven unique-value renderer as default symbology.
 * Shared by `npm run provision-layer` (username/password) and the in-app setup page (signed-in user).
 * The calling user needs "Create content" and "Publish hosted feature layers" privileges.
 */
import { withToken, type TokenProvider } from "./auth";
import { arcgisRequest, type RestParamValue } from "./rest";
import { DISTRICTS, LAYER_FIELDS, PLAN_NAME_MAX_LENGTH, PLAN_STATUSES, PLAN_TYPES } from "../plan-options";

export interface ProvisionOptions {
  portalUrl: string;
  username: string;
  tokens: TokenProvider;
  serviceName: string;
  /** Copy spatial reference + extent from this layer; Web Mercator when omitted. */
  referenceLayerUrl?: string;
  log?: (message: string) => void;
}

export interface ProvisionResult {
  itemId: string;
  serviceUrl: string;
  layerUrl: string;
  itemUrl: string;
  orgName: string;
}

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

interface CreateServiceResponse {
  success: boolean;
  itemId: string;
  serviceurl: string;
  name: string;
}

interface IsServiceNameAvailableResponse {
  available: boolean;
}

const STATUS_COLORS: Record<(typeof PLAN_STATUSES)[number], [number, number, number]> = {
  SUBMITTED: [245, 158, 11], // amber/orange
  UNDER_REVIEW: [37, 99, 235], // blue
  APPROVED: [22, 163, 74], // green
  REJECTED: [220, 38, 38], // red
};

const codedDomain = (name: string, values: readonly string[]) => ({
  type: "codedValue",
  name,
  codedValues: values.map((v) => ({ name: v, code: v })),
});

function polygonSymbol([r, g, b]: [number, number, number]) {
  return {
    type: "esriSFS",
    style: "esriSFSSolid",
    color: [r, g, b, 90],
    outline: { type: "esriSLS", style: "esriSLSSolid", color: [r, g, b, 255], width: 2 },
  };
}

interface SpatialSetup {
  spatialReference: { wkid?: number; latestWkid?: number; wkt?: string };
  extent: { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference: SpatialSetup["spatialReference"] };
}

const WEB_MERCATOR: SpatialSetup = {
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  extent: {
    xmin: -20037508.34, ymin: -20037508.34, xmax: 20037508.34, ymax: 20037508.34,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
};

function layerDefinition(layerName: string, spatial: SpatialSetup) {
  return {
    id: 0,
    name: layerName,
    type: "Feature Layer",
    geometryType: "esriGeometryPolygon",
    objectIdField: "objectid",
    globalIdField: "globalid",
    displayField: LAYER_FIELDS.planName,
    hasAttachments: true,
    hasM: false,
    hasZ: false,
    allowGeometryUpdates: true,
    capabilities: "Create,Delete,Query,Update,Editing",
    extent: spatial.extent,
    fields: [
      { name: "objectid", type: "esriFieldTypeOID", alias: "ObjectID", nullable: false, editable: false },
      { name: "globalid", type: "esriFieldTypeGlobalID", alias: "GlobalID", length: 38, nullable: false, editable: false },
      { name: LAYER_FIELDS.planName, type: "esriFieldTypeString", alias: "Plan Name", length: PLAN_NAME_MAX_LENGTH, nullable: false, editable: true },
      { name: LAYER_FIELDS.district, type: "esriFieldTypeString", alias: "District", length: 100, nullable: false, editable: true, domain: codedDomain("PlanDistrict", DISTRICTS) },
      { name: LAYER_FIELDS.planType, type: "esriFieldTypeString", alias: "Plan Type", length: 50, nullable: false, editable: true, domain: codedDomain("PlanType", PLAN_TYPES) },
      { name: LAYER_FIELDS.status, type: "esriFieldTypeString", alias: "Status", length: 20, nullable: false, editable: true, defaultValue: "SUBMITTED", domain: codedDomain("PlanStatus", PLAN_STATUSES) },
      { name: LAYER_FIELDS.submissionDate, type: "esriFieldTypeDate", alias: "Submission Date", length: 8, nullable: true, editable: true },
      { name: LAYER_FIELDS.reviewComments, type: "esriFieldTypeString", alias: "Review Comments", length: 4000, nullable: true, editable: true },
    ],
    drawingInfo: {
      renderer: {
        type: "uniqueValue",
        field1: LAYER_FIELDS.status,
        defaultSymbol: polygonSymbol([148, 163, 184]),
        defaultLabel: "Other",
        uniqueValueInfos: PLAN_STATUSES.map((status) => ({
          value: status,
          label: status.replace("_", " "),
          symbol: polygonSymbol(STATUS_COLORS[status]),
        })),
      },
      transparency: 0,
    },
    templates: [],
    types: [],
  };
}

/**
 * Admin endpoint for a hosted feature service:
 *   ArcGIS Online: https://servicesN.arcgis.com/<orgId>/arcgis/rest/admin/services/X/FeatureServer
 *   Enterprise:    https://host/server/rest/admin/services/Hosted/X.FeatureServer
 */
function toAdminUrl(serviceUrl: string): string {
  const admin = serviceUrl.replace(/\/+$/, "").replace("/rest/services/", "/rest/admin/services/");
  const isArcGisOnline = /\.arcgis\.com$/i.test(new URL(serviceUrl).hostname);
  return isArcGisOnline ? admin : admin.replace(/\/FeatureServer$/, ".FeatureServer");
}

export async function provisionLayer(options: ProvisionOptions): Promise<ProvisionResult> {
  const { portalUrl, username, tokens, serviceName, referenceLayerUrl } = options;
  const log = options.log ?? (() => {});
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(serviceName)) {
    throw new ProvisionError("Service name must start with a letter and use only letters, digits and _.");
  }
  const call = <T>(url: string, params: Record<string, RestParamValue>, method: "GET" | "POST" = "POST") =>
    withToken(tokens, (token) => arcgisRequest<T>(url, params, { referer: tokens.referer, token, method }));

  const portal = await call<{ id: string; name: string; urlKey?: string }>(`${portalUrl}/sharing/rest/portals/self`, {}, "GET");
  log(`Signed in as ${username} to org "${portal.name}" (id ${portal.id}, urlKey ${portal.urlKey ?? "-"})`);

  let spatial = WEB_MERCATOR;
  if (referenceLayerUrl) {
    const ref = await call<{ name: string; spatialReference?: SpatialSetup["spatialReference"]; extent?: SpatialSetup["extent"] }>(
      referenceLayerUrl.replace(/\/+$/, ""),
      {},
      "GET",
    );
    if (!ref.spatialReference || !ref.extent) throw new ProvisionError(`Reference layer ${referenceLayerUrl} has no spatialReference/extent.`);
    spatial = { spatialReference: ref.spatialReference, extent: ref.extent };
    const srLabel = ref.spatialReference.latestWkid ?? ref.spatialReference.wkid ?? ref.spatialReference.wkt?.slice(0, 60) + "…";
    log(`Matching spatial reference of "${ref.name}": ${srLabel}`);
  }

  const availability = await call<IsServiceNameAvailableResponse>(
    `${portalUrl}/sharing/rest/portals/${portal.id}/isServiceNameAvailable`,
    { name: serviceName, type: "Feature Service" },
    "GET",
  );
  if (!availability.available) throw new ProvisionError(`A feature service named "${serviceName}" already exists in this org.`);

  log(`Creating hosted feature service "${serviceName}" …`);
  const created = await call<CreateServiceResponse>(`${portalUrl}/sharing/rest/content/users/${encodeURIComponent(username)}/createService`, {
    outputType: "featureService",
    createParameters: {
      name: serviceName,
      serviceDescription: "Physical plan submissions from the intake portal",
      hasStaticData: false,
      maxRecordCount: 2000,
      supportedQueryFormats: "JSON",
      capabilities: "Create,Delete,Query,Update,Editing",
      allowGeometryUpdates: true,
      units: "esriMeters",
      spatialReference: spatial.spatialReference,
      initialExtent: spatial.extent,
      xssPreventionInfo: { xssPreventionEnabled: true, xssPreventionRule: "InputOnly", xssInputRule: "rejectInvalid" },
    },
  });
  if (!created.success) throw new ProvisionError("createService did not report success.");
  log(`  item ${created.itemId}`);
  log(`  service ${created.serviceurl}`);

  const adminUrl = toAdminUrl(created.serviceurl);
  log(`Adding layer definition via ${adminUrl}/addToDefinition …`);
  await call(`${adminUrl}/addToDefinition`, { addToDefinition: { layers: [layerDefinition(serviceName, spatial)] } });

  const serviceUrl = created.serviceurl.replace(/\/+$/, "");
  const layerUrl = `${serviceUrl}/0`;
  const layer = await call<{ name: string; hasAttachments: boolean; fields: { name: string }[] }>(layerUrl, {}, "GET");
  log(`Layer "${layer.name}" (attachments: ${layer.hasAttachments}) fields: ${layer.fields.map((f) => f.name).join(", ")}`);
  return { itemId: created.itemId, serviceUrl, layerUrl, itemUrl: `${portalUrl}/home/item.html?id=${created.itemId}`, orgName: portal.name };
}
