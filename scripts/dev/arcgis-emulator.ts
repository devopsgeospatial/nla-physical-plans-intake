/**
 * DEV ONLY: a local stand-in for ArcGIS Online so the intake app can be exercised end to end
 * before the OAuth app and real layer exist. It implements just the REST surface the app uses:
 *
 *   /portal/sharing/rest/oauth2/authorize|token|revokeToken   (PKCE verified)
 *   /portal/sharing/rest/community/self, /portal/sharing/rest/portals/self (helper geometry service)
 *   /arcgis/rest/services/Utilities/Geometry/GeometryServer/simplify  (returns the rings unchanged; counts calls)
 *   /arcgis/rest/services/Physical_Plans/FeatureServer/0  (+ applyEdits, query,
 *     {oid}/addAttachment, {oid}/attachments, {oid}/attachments/{id})
 *
 * The layer mirrors the real NLA Physical_Plans schema (fields, TM Rwanda WKT, OBJECTID). Like ArcGIS,
 * applyEdits rejects unknown fields and over-length text. Attachments are enabled unless
 * EMULATOR_ATTACHMENTS=off (the real layer currently has them off).
 *
 * Data lives in memory and is lost on restart. Browse http://localhost:4100/ to see appended records.
 * Nothing in the app imports this file; it is only reached when the app's env points at it.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export const EMULATOR_PORT = Number(process.env.EMULATOR_PORT ?? 4100);
const ORIGIN = `http://localhost:${EMULATOR_PORT}`;
export const EMULATOR_PORTAL_URL = `${ORIGIN}/portal`;
const LAYER_PATH = "/arcgis/rest/services/Physical_Plans/FeatureServer/0";
export const EMULATOR_LAYER_URL = `${ORIGIN}${LAYER_PATH}`;
export const EMULATOR_GROUP_ID = "devplansubmitters";

/** Same custom grid as the real Physical_Plans reference layer (TM Rwanda / ITRF2005). */
const TM_RWANDA_WKT =
  'PROJCS["ITRF_2005",GEOGCS["GCS_ITRF_2005",DATUM["D_ITRF_2005",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",5000000.0],PARAMETER["Central_Meridian",30.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

interface TestUser {
  username: string;
  fullName: string;
  description: string;
  privileges: string[];
  groups: { id: string; title: string }[];
}

const SUBMITTERS = { id: EMULATOR_GROUP_ID, title: "Plan Submitters (dev)" };
const TEST_USERS: TestUser[] = [
  { username: "planner.muhanga", fullName: "Muhanga Planner", description: "Creator in Plan Submitters: can submit", privileges: ["features:user:edit", "portal:user:createItem"], groups: [SUBMITTERS] },
  { username: "planner.huye", fullName: "Huye Planner", description: "Contributor in Plan Submitters: can submit", privileges: ["features:user:edit"], groups: [SUBMITTERS] },
  { username: "viewer.only", fullName: "Viewer Account", description: "Viewer user type: refused (no edit privilege)", privileges: ["portal:user:joinGroup"], groups: [SUBMITTERS] },
  { username: "outsider", fullName: "Other Staff", description: "Not in Plan Submitters: refused (group check)", privileges: ["features:user:edit"], groups: [] },
];

interface StoredFeature {
  attributes: Record<string, unknown>;
  geometry: unknown;
  attachments: { id: number; name: string; contentType: string; data: Buffer }[];
}

const features = new Map<number, StoredFeature>();
const authCodes = new Map<string, { challenge: string; username: string; redirectUri: string }>();
const refreshTokens = new Map<string, string>(); // refresh token -> username
const accessTokens = new Map<string, { username: string; expiresAt: number }>();
let nextObjectId = 1;
const stats = { simplifyCalls: 0, simplifiedGeometries: 0 };
const GEOMETRY_SERVER_PATH = "/arcgis/rest/services/Utilities/Geometry/GeometryServer";
let nextAttachmentId = 1;

const ACCESS_TOKEN_SECONDS = 30 * 60;

const str = (name: string, length = 255) => ({ name, type: "esriFieldTypeString", alias: name, length, nullable: true, editable: true });
const date = (name: string) => ({ name, type: "esriFieldTypeDate", alias: name, length: 8, nullable: true, editable: true });

/** Same fields as https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/Physical_Plans/FeatureServer/0 */
const FIELDS: { name: string; type: string; alias: string; length?: number; nullable: boolean; editable: boolean }[] = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", nullable: false, editable: false },
  str("plan_id"),
  str("parcel_upi"),
  str("gen_lu"),
  str("zone_code"),
  str("zoning"),
  str("planning_status"),
  date("approval_date"),
  { name: "area_sqm", type: "esriFieldTypeDouble", alias: "area_sqm", nullable: true, editable: true },
  str("sl"),
  str("remarks"),
  str("created_user"),
  date("created_date"),
  str("last_edited_user"),
  date("last_edited_date"),
  str("province", 50),
  str("district_1", 50),
  str("sector_1", 50),
  str("cell_1", 50),
  { name: "Shape__Area", type: "esriFieldTypeDouble", alias: "Shape__Area", nullable: true, editable: false },
  { name: "Shape__Length", type: "esriFieldTypeDouble", alias: "Shape__Length", nullable: true, editable: false },
];

const attachmentsEnabled = () => process.env.EMULATOR_ATTACHMENTS !== "off";

function layerJson() {
  return {
    currentVersion: 12,
    id: 0,
    name: "Physical_Plans",
    type: "Feature Layer",
    geometryType: "esriGeometryPolygon",
    objectIdField: "OBJECTID",
    globalIdField: "",
    displayField: "plan_id",
    hasAttachments: attachmentsEnabled(),
    capabilities: "Create,Delete,Query,Update,Editing,Extract,Append",
    spatialReference: { wkt: TM_RWANDA_WKT },
    extent: { xmin: 473835, ymin: 4768076, xmax: 476364, ymax: 4769925, spatialReference: { wkt: TM_RWANDA_WKT } },
    fields: FIELDS,
  };
}

/** ArcGIS-like attribute validation for one add; returns an error description or null. */
function validateAttributes(attributes: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(attributes)) {
    const field = FIELDS.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!field) return `Field '${name}' does not exist in the layer.`;
    if (!field.editable) return `Field '${name}' is not editable.`;
    if (value === null) continue;
    if (field.type === "esriFieldTypeString" && (typeof value !== "string" || value.length > (field.length ?? 255))) {
      return `Value for '${name}' is not a string or exceeds the field length.`;
    }
    if ((field.type === "esriFieldTypeDouble" || field.type === "esriFieldTypeDate") && typeof value !== "number") {
      return `Value for '${name}' must be numeric.`;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readParams(req: http.IncomingMessage, url: URL): Promise<{ params: URLSearchParams; form?: FormData }> {
  if (req.method !== "POST") return { params: url.searchParams };
  const body = await readBody(req);
  const type = req.headers["content-type"] ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await new Request(ORIGIN, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }).formData();
    const params = new URLSearchParams();
    for (const [k, v] of form.entries()) if (typeof v === "string") params.append(k, v);
    return { params, form };
  }
  return { params: new URLSearchParams(body.toString("utf8")) };
}

function sendJson(res: http.ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

const arcgisError = (code: number, message: string) => ({ error: { code, message, details: [] } });

function authenticate(params: URLSearchParams): string | null {
  const session = accessTokens.get(params.get("token") ?? "");
  return session && session.expiresAt > Date.now() ? session.username : null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ------------------------------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", ORIGIN);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const { params, form } = await readParams(req, url);

  // ---- OAuth -----------------------------------------------------------------------------------
  if (path === "/portal/sharing/rest/oauth2/authorize") {
    const pick = params.get("pick_user");
    if (!pick) {
      const query = url.searchParams.toString();
      const rows = TEST_USERS.map(
        (u) => `<li><a href="?${query}&pick_user=${encodeURIComponent(u.username)}"><b>${escapeHtml(u.fullName)}</b> (${escapeHtml(u.username)})</a><br><small>${escapeHtml(u.description)}</small></li>`,
      ).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Sign in (local emulator)</title>
<body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px;line-height:1.5">
<p style="background:#fef3c7;padding:8px 12px;border-radius:6px">Local ArcGIS emulator, not the real ArcGIS Online. Pick a test account.</p>
<h2>Sign in to rla.maps.arcgis.com (simulated)</h2><ul style="padding-left:18px">${rows}</ul></body>`);
    }
    const user = TEST_USERS.find((u) => u.username === pick);
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!user || !redirectUri) return sendJson(res, arcgisError(400, "Invalid request"), 400);
    const code = randomBytes(16).toString("base64url");
    authCodes.set(code, { challenge: params.get("code_challenge") ?? "", username: user.username, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", params.get("state") ?? "");
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }

  if (path === "/portal/sharing/rest/oauth2/token") {
    if (params.get("grant_type") === "authorization_code") {
      const pending = authCodes.get(params.get("code") ?? "");
      authCodes.delete(params.get("code") ?? "");
      const verifier = params.get("code_verifier") ?? "";
      if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
        return sendJson(res, arcgisError(400, "Invalid authorization code or code_verifier."));
      }
      if (params.get("redirect_uri") !== pending.redirectUri) return sendJson(res, arcgisError(400, "Invalid redirect_uri."));
      const refresh = randomBytes(24).toString("base64url");
      refreshTokens.set(refresh, pending.username);
      return sendJson(res, { ...issueAccessToken(pending.username), refresh_token: refresh, refresh_token_expires_in: 1209600 });
    }
    if (params.get("grant_type") === "refresh_token") {
      const username = refreshTokens.get(params.get("refresh_token") ?? "");
      if (!username) return sendJson(res, arcgisError(498, "Invalid refresh_token"));
      return sendJson(res, issueAccessToken(username));
    }
    return sendJson(res, arcgisError(400, "Unsupported grant_type"));
  }

  if (path === "/portal/sharing/rest/oauth2/revokeToken") {
    refreshTokens.delete(params.get("auth_token") ?? "");
    return sendJson(res, { success: true });
  }

  if (path === "/portal/sharing/rest/community/self") {
    const username = authenticate(params);
    if (!username) return sendJson(res, arcgisError(498, "Invalid token."));
    const user = TEST_USERS.find((u) => u.username === username)!;
    return sendJson(res, { username: user.username, fullName: user.fullName, orgId: "devorg", privileges: user.privileges, groups: user.groups });
  }

  if (path === "/portal/sharing/rest/portals/self") {
    if (!authenticate(params)) return sendJson(res, arcgisError(498, "Invalid token."));
    return sendJson(res, { id: "devorg", name: "Rwanda Land (emulator)", helperServices: { geometry: { url: `${ORIGIN}${GEOMETRY_SERVER_PATH}` } } });
  }

  if (path === `${GEOMETRY_SERVER_PATH}/simplify`) {
    if (!authenticate(params)) return sendJson(res, arcgisError(498, "Invalid token."));
    const input = JSON.parse(params.get("geometries") ?? "{}") as { geometries?: { rings: number[][][] }[] };
    const geometries = input.geometries ?? [];
    stats.simplifyCalls++;
    stats.simplifiedGeometries += geometries.length;
    return sendJson(res, { geometries: geometries.map((g) => ({ rings: g.rings })) });
  }

  // ---- Feature layer ---------------------------------------------------------------------------
  if (path.startsWith(LAYER_PATH)) {
    const username = authenticate(params);
    if (!username) return sendJson(res, arcgisError(499, "Token Required"));
    const sub = path.slice(LAYER_PATH.length);

    if (sub === "") return sendJson(res, layerJson());

    if (sub === "/applyEdits") {
      const adds = JSON.parse(params.get("adds") ?? "[]") as { geometry: unknown; attributes: Record<string, unknown> }[];
      const deletes = JSON.parse(params.get("deletes") ?? "[]") as number[];
      // rollbackOnFailure semantics: validate everything first, then add all or nothing.
      const problems = adds.map((add) => validateAttributes(add.attributes ?? {}));
      if (problems.some(Boolean)) {
        const rejected = problems.map((problem) => ({
          objectId: -1,
          success: false,
          error: problem ? { code: 1000, description: problem } : { code: 1003, description: "Operation rolled back." },
        }));
        return sendJson(res, { addResults: rejected, updateResults: [], deleteResults: [] });
      }
      const addResults = adds.map((add) => {
        const objectid = nextObjectId++;
        features.set(objectid, { attributes: { ...add.attributes, OBJECTID: objectid }, geometry: add.geometry, attachments: [] });
        return { objectId: objectid, globalId: null, success: true };
      });
      const deleteResults = deletes.map((oid) => ({ objectId: oid, success: features.delete(oid) }));
      console.log(`[emulator] applyEdits by ${username}: +${addResults.length} -${deleteResults.length}`);
      return sendJson(res, { addResults, updateResults: [], deleteResults });
    }

    if (sub === "/query") {
      const list = [...features.values()].map((f) => ({ attributes: f.attributes, geometry: f.geometry }));
      return sendJson(res, { objectIdFieldName: "OBJECTID", geometryType: "esriGeometryPolygon", spatialReference: { wkt: TM_RWANDA_WKT }, features: list });
    }

    const match = sub.match(/^\/(\d+)\/(addAttachment|attachments)(?:\/(\d+))?$/);
    const feature = match ? features.get(Number(match[1])) : undefined;
    if (match && !feature) return sendJson(res, arcgisError(404, `Feature ${match[1]} not found.`));
    if (match && feature) {
      if (match[2] === "addAttachment") {
        if (!attachmentsEnabled()) return sendJson(res, arcgisError(400, "Attachments are not enabled on this layer."));
        const file = form?.get("attachment");
        if (!(file instanceof File)) return sendJson(res, arcgisError(400, "Missing 'attachment' part."));
        const id = nextAttachmentId++;
        feature.attachments.push({ id, name: file.name, contentType: file.type || "application/pdf", data: Buffer.from(await file.arrayBuffer()) });
        console.log(`[emulator] attachment ${id} (${file.name}, ${file.size} B) -> feature ${match[1]}`);
        return sendJson(res, { addAttachmentResult: { objectId: id, globalId: `{${crypto.randomUUID().toUpperCase()}}`, success: true } });
      }
      if (!match[3]) {
        return sendJson(res, { attachmentInfos: feature.attachments.map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.data.length })) });
      }
      const att = feature.attachments.find((a) => a.id === Number(match[3]));
      if (!att) return sendJson(res, arcgisError(404, "Attachment not found."));
      res.writeHead(200, { "content-type": att.contentType, "content-disposition": `inline; filename="${att.name}"` });
      return res.end(att.data);
    }
    return sendJson(res, arcgisError(400, `Unsupported operation ${sub}`));
  }

  // ---- Dev viewer --------------------------------------------------------------------------------
  if (path === "/") return renderIndex(res);
  if (path === "/stats.json") return sendJson(res, stats);
  if (path === "/records.json") {
    return sendJson(res, [...features.values()].map((f) => ({ ...f.attributes, attachments: f.attachments.map((x) => x.name), geometry: f.geometry })));
  }
  const download = path.match(/^\/files\/(\d+)\/(\d+)$/);
  if (download) {
    const att = features.get(Number(download[1]))?.attachments.find((a) => a.id === Number(download[2]));
    if (!att) return sendJson(res, arcgisError(404, "Not found"), 404);
    res.writeHead(200, { "content-type": att.contentType, "content-disposition": `inline; filename="${att.name}"` });
    return res.end(att.data);
  }
  return sendJson(res, arcgisError(404, `Not found: ${path}`), 404);
}

function issueAccessToken(username: string) {
  const token = randomBytes(24).toString("base64url");
  accessTokens.set(token, { username, expiresAt: Date.now() + ACCESS_TOKEN_SECONDS * 1000 });
  return { access_token: token, expires_in: ACCESS_TOKEN_SECONDS, username, ssl: false };
}

function renderIndex(res: http.ServerResponse) {
  const columns = ["OBJECTID", "plan_id", "parcel_upi", "zoning", "planning_status", "district_1", "sector_1", "area_sqm", "created_user", "created_date"];
  const cell = (name: string, value: unknown) =>
    name.endsWith("_date") && typeof value === "number" ? new Date(value).toISOString().slice(0, 16).replace("T", " ") : escapeHtml(value);
  const rows = [...features.values()]
    .sort((a, b) => Number(b.attributes.OBJECTID) - Number(a.attributes.OBJECTID))
    .map((f) => {
      const ring = (f.geometry as { rings?: number[][][] }).rings?.[0]?.[0];
      const docs = f.attachments.map((x) => `<a href="/files/${f.attributes.OBJECTID}/${x.id}" target="_blank">${escapeHtml(x.name)}</a>`).join("<br>");
      const vertex = ring ? `${ring[0]?.toFixed(1)}, ${ring[1]?.toFixed(1)}` : "";
      return `<tr>${columns.map((c) => `<td>${cell(c, f.attributes[c])}</td>`).join("")}<td><small>${vertex}</small></td><td>${docs}</td></tr>`;
    })
    .join("");
  const empty = `<tr><td colspan="${columns.length + 2}">Nothing appended yet.</td></tr>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>ArcGIS emulator</title>
<body style="font-family:system-ui;margin:24px;line-height:1.4">
<p style="background:#fef3c7;padding:8px 12px;border-radius:6px;display:inline-block">Local ArcGIS emulator. In-memory only; refreshes every 5 s. Attachments: ${attachmentsEnabled() ? "on" : "off"}.</p>
<h2>Physical_Plans: appended records (${features.size})</h2>
<div style="overflow-x:auto"><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px">
<tr>${columns.map((c) => `<th>${c}</th>`).join("")}<th>First vertex (TM Rwanda m)</th><th>PDFs</th></tr>
${rows || empty}</table></div></body>`);
}

export function startEmulator(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[emulator]", err);
      sendJson(res, arcgisError(500, String(err)), 500);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(EMULATOR_PORT, () => resolve(server));
  });
}
