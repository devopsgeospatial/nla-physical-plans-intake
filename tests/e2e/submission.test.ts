/**
 * End-to-end: the production build (`next start`) against the local ArcGIS emulator, which mirrors
 * the real Physical_Plans layer. Exercises OAuth sign-in (PKCE), access checks, appending a
 * Shapefile / GeoJSON with attributes and PDFs, rollback, validation errors and sign-out over real
 * HTTP. Requires `next build` first (npm run test:e2e does both).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

const APP_PORT = 3199;
const APP = `http://localhost:${APP_PORT}`;
/** The review app: the same build started with APP_MODE=review. */
const REVIEW_PORT = 3198;
const REVIEW = `http://localhost:${REVIEW_PORT}`;
process.env.EMULATOR_PORT = "4199";

let emulator: Server;
let app: ChildProcess;
let reviewApp: ChildProcess;
let emulatorUrl: string;

before(async () => {
  const mod = await import("../../scripts/dev/arcgis-emulator");
  emulatorUrl = `http://localhost:${mod.EMULATOR_PORT}`;
  emulator = await mod.startEmulator();

  // The production server exactly as deployed (standalone bundle, see npm run build). Both apps share
  // SESSION_SECRET on purpose: a session must still only work in the app that issued it.
  const start = (port: number, url: string, extra: Record<string, string>) =>
    spawn(process.execPath, [".next/standalone/server.js"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        ARCGIS_PORTAL_URL: mod.EMULATOR_PORTAL_URL,
        ARCGIS_FEATURE_LAYER_URL: mod.EMULATOR_LAYER_URL,
        ARCGIS_OAUTH_CLIENT_ID: "e2e",
        ARCGIS_OAUTH_REDIRECT_URI: `${url}/api/auth/callback`,
        APP_URL: url,
        SESSION_SECRET: "e2e-session-secret-that-is-long-enough-123",
        ...extra,
      },
    });
  app = start(APP_PORT, APP, { ARCGIS_ALLOWED_GROUP_ID: mod.EMULATOR_GROUP_ID });
  reviewApp = start(REVIEW_PORT, REVIEW, { APP_MODE: "review", ARCGIS_REVIEWER_GROUP_ID: mod.EMULATOR_REVIEWER_GROUP_ID });
  for (const url of [APP, REVIEW]) {
    for (let i = 0; ; i++) {
      if (await fetch(url).then(() => true, () => false)) break;
      if (i === 60) throw new Error("app did not start; run `npm run build` first");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

after(() => {
  app?.kill();
  reviewApp?.kill();
  emulator?.close();
});

/** Minimal cookie jar + manual redirect following, so each hop can be asserted. */
class Browser {
  private cookies = new Map<string, string>();

  constructor(readonly base = APP) {}

  async get(url: string): Promise<Response> {
    return this.request(url, { method: "GET" });
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(this.base) && this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [name, ...value] = pair!.split("=");
      const v = value.join("=");
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || v === "") this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), v);
    }
    return res;
  }

  /** Follows the full sign-in round trip, choosing `user` on the emulator's login page. Returns the final app URL. */
  async signIn(user: string): Promise<URL> {
    let res = await this.get(`${this.base}/api/auth/login`);
    assert.equal(res.status, 307);
    const authorize = new URL(res.headers.get("location")!);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    authorize.searchParams.set("pick_user", user);
    res = await this.get(authorize.toString());
    assert.equal(res.status, 302, "emulator should redirect back to the app");
    res = await this.get(res.headers.get("location")!); // /api/auth/callback
    assert.equal(res.status, 307);
    return new URL(res.headers.get("location")!);
  }

  get signedIn(): boolean {
    return this.cookies.has("pp_session");
  }

  /** This browser's cookies, to replay against the other app. */
  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

type UploadPart = [path: string, type: string] | [name: string, type: string, content: Blob];

async function upload(parts: Record<string, UploadPart>): Promise<FormData> {
  const form = new FormData();
  for (const [field, [path, type, content]] of Object.entries(parts)) {
    form.append(field, content ?? new Blob([await readFile(path)], { type }), path.split("/").pop());
  }
  return form;
}

type StoredRecord = Record<string, unknown> & { OBJECTID: number; attachments: string[]; geometry: { rings: number[][][] } };
const records = async (): Promise<StoredRecord[]> => (await fetch(`${emulatorUrl}/records.json`)).json();

const SHAPEFILE: UploadPart = ["samples/muhanga-parcels-tm-rwanda.zip", "application/zip"];
const GEOJSON: UploadPart = ["samples/muhanga-parcels-wgs84.geojson", "application/geo+json"];
const PDF: UploadPart = ["samples/sample-plan-document.pdf", "application/pdf"];

describe("append to Physical_Plans (production build vs ArcGIS emulator)", () => {
  it("shows the sign-in screen and refuses anonymous uploads", async () => {
    const signInPage = await (await fetch(APP)).text();
    assert.match(signInPage, /Physical plan submission/i);
    assert.match(signInPage, /name="password"/);
    const res = await fetch(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: SHAPEFILE }) });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).signInRequired, true);
  });

  it("signs in with username and password (wrong password, Viewer and non-member refused)", async () => {
    const tryPassword = async (username: string, password: string, origin = APP) => {
      const browser = new Browser();
      const res = await browser.request(`${APP}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams({ username, password }).toString(),
      });
      assert.equal(res.status, 303);
      return { browser, location: new URL(res.headers.get("location")!) };
    };

    const ok = await tryPassword("planner.muhanga", "rla-test");
    assert.equal(ok.location.search, "");
    assert.equal(ok.browser.signedIn, true);
    const page = await (await ok.browser.get(APP)).text();
    assert.match(page, /Physical plan submission/i);
    assert.match(page, /Muhanga Planner/);

    const wrong = await tryPassword("planner.muhanga", "nope");
    assert.equal(wrong.location.searchParams.get("auth_error"), "Wrong username or password.");
    assert.equal(wrong.location.searchParams.get("u"), "planner.muhanga", "username is kept for the retry");
    assert.equal(wrong.browser.signedIn, false);

    assert.match((await tryPassword("viewer.only", "rla-test")).location.searchParams.get("auth_error") ?? "", /Edit features/);
    assert.match((await tryPassword("outsider", "rla-test")).location.searchParams.get("auth_error") ?? "", /not a member/);
    assert.match((await tryPassword("planner.muhanga", "rla-test", "https://evil.example")).location.searchParams.get("auth_error") ?? "", /another site/);
  });

  it("refuses a Viewer account, a user outside the group, and a forged OAuth state", async () => {
    assert.match((await new Browser().signIn("viewer.only")).searchParams.get("auth_error") ?? "", /Edit features/);
    assert.match((await new Browser().signIn("outsider")).searchParams.get("auth_error") ?? "", /not a member/);
    const res = await fetch(`${APP}/api/auth/callback?code=x&state=forged`, { redirect: "manual" });
    assert.match(new URL(res.headers.get("location")!).searchParams.get("auth_error") ?? "", /could not be verified/);
  });

  it("appends each Shapefile polygon as its own record, with the file's attributes and the PDF", async () => {
    const planner = new Browser();
    assert.equal((await planner.signIn("planner.muhanga")).pathname, "/");
    const page = await (await planner.get(APP)).text();
    assert.match(page, /Muhanga Planner/);
    assert.match(page, /Physical plan submission[\s\S]*Plan file/i);

    const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: SHAPEFILE, documents: PDF }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.objectIds.length, 3);
    assert.deepEqual(body.ignoredFields, ["surveyor"]);
    assert.deepEqual(body.attachments, { objectId: body.objectIds[0], count: 1 });
    assert.ok(body.matchedFields.some((m: { file: string; layer: string }) => m.file === "planning_s" && m.layer === "planning_status"));

    const stored = (await records()).filter((r) => body.objectIds.includes(r.OBJECTID));
    assert.deepEqual(stored.map((r) => r.parcel_upi).sort(), ["2/01/05/01/2201", "2/01/05/01/2202", "2/01/05/01/2203"]);
    for (const r of stored) {
      assert.equal(r.plan_id, "PP-MUH-2026-014");
      assert.equal(r.planning_status, "Ongoing");
      assert.equal(r.district_1, "Muhanga");
      assert.equal(r.created_user, "planner.muhanga");
      assert.ok(typeof r.created_date === "number" && Date.now() - r.created_date < 60_000);
      assert.ok(Math.abs((r.area_sqm as number) - 2700) < 0.5, `area_sqm ${r.area_sqm} (60 m x 45 m parcel)`);
      assert.equal("surveyor" in r, false);
      // The PDF goes on the first appended record only; the others stay without attachments.
      assert.deepEqual(r.attachments, r.OBJECTID === body.objectIds[0] ? ["sample-plan-document.pdf"] : []);
      const [x, y] = r.geometry.rings[0]![0]!;
      assert.ok(x! > 474000 && x! < 474400 && y! > 4768900 && y! < 4769100, `stored in TM Rwanda: ${x}, ${y}`);
    }
  });

  it("appends GeoJSON without attachments", async () => {
    const planner = new Browser();
    await planner.signIn("planner.huye");
    const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: GEOJSON }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.objectIds.length, 3);
    const stored = (await records()).filter((r) => body.objectIds.includes(r.OBJECTID));
    assert.ok(stored.every((r) => r.plan_id === "PP-MUH-2026-015" && r.created_user === "planner.huye" && r.attachments.length === 0));
  });

  it("appends a large file (2,500 parcels, over the old 2,000 cap) and repairs a self-intersecting parcel via ArcGIS simplify", async () => {
    const planner = new Browser();
    await planner.signIn("planner.muhanga");
    const statsBefore = await (await fetch(`${emulatorUrl}/stats.json`)).json();
    const square = (dx: number, dy: number) => [[29.75 + dx, -2.1 + dy], [29.7502 + dx, -2.1 + dy], [29.7502 + dx, -2.0998 + dy], [29.75 + dx, -2.0998 + dy], [29.75 + dx, -2.1 + dy]];
    const bowtie = [[29.7, -2.1], [29.7002, -2.0998], [29.7002, -2.1], [29.7, -2.0998], [29.7, -2.1]];
    const features = Array.from({ length: 2_500 }, (_, i) => ({
      type: "Feature",
      properties: { parcel_upi: `9/99/${i}`, plan_id: "PP-BULK-1" },
      geometry: { type: "Polygon", coordinates: [i === 2019 ? bowtie : square((i % 50) * 0.0003, Math.floor(i / 50) * 0.0003)] },
    }));
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })]);
    const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: ["bulk.geojson", "application/geo+json", blob] }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body).slice(0, 300));
    assert.equal(body.objectIds.length, 2_500);
    assert.equal(body.repairedCount, 1);
    const statsAfter = await (await fetch(`${emulatorUrl}/stats.json`)).json();
    assert.equal(statsAfter.simplifiedGeometries - statsBefore.simplifiedGeometries, 1, "only the flagged parcel is sent to simplify");
    const stored = (await records()).filter((r) => r.plan_id === "PP-BULK-1");
    assert.equal(stored.length, 2_500);
  });

  it("still submits when the geometry service refuses the token (password sign-in): repairs locally, never asks to sign in again", async () => {
    // Password sign-in, as planners use it (no refresh token).
    const planner = new Browser();
    const form = new URLSearchParams({ username: "planner.huye", password: "rla-test" });
    const signIn = await planner.request(`${APP}/api/auth/password`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", origin: APP } });
    assert.equal(signIn.status, 303);
    assert.ok(planner.signedIn);

    await fetch(`${emulatorUrl}/dev/geometry-service?refuse=1`, { method: "POST" });
    try {
      const bowtie = [[29.71, -2.2], [29.7102, -2.1998], [29.7102, -2.2], [29.71, -2.1998], [29.71, -2.2]];
      const plan = { type: "FeatureCollection", features: [{ type: "Feature", properties: { parcel_upi: "TOKEN-REFUSED-1", plan_id: "PP-REPAIR-LOCAL" }, geometry: { type: "Polygon", coordinates: [bowtie] } }] };
      const res = await planner.request(`${APP}/api/plans/submit`, {
        method: "POST",
        body: await upload({ file: ["repair.geojson", "application/geo+json", new Blob([JSON.stringify(plan)])] }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.repairedCount, 1);
      const stored = (await records()).find((r) => r.plan_id === "PP-REPAIR-LOCAL")!;
      // The figure-eight is stored as its two loops.
      assert.equal(stored.geometry.rings.length, 2);
    } finally {
      await fetch(`${emulatorUrl}/dev/geometry-service?refuse=0`, { method: "POST" });
    }
  });

  it("is all-or-nothing: if an attachment fails, the appended records are removed again", async () => {
    const planner = new Browser();
    await planner.signIn("planner.muhanga");
    const before = (await records()).length;
    const fresh = JSON.stringify({
      type: "FeatureCollection",
      features: [0, 1].map((i) => ({
        type: "Feature",
        properties: { parcel_upi: `ROLLBACK-${i}` },
        geometry: { type: "Polygon", coordinates: [[[29.78 + i * 0.001, -2.08], [29.7805 + i * 0.001, -2.08], [29.7805 + i * 0.001, -2.0795], [29.78 + i * 0.001, -2.08]]] },
      })),
    });
    process.env.EMULATOR_ATTACHMENTS = "off"; // the in-process emulator now refuses addAttachment
    try {
      const res = await planner.request(`${APP}/api/plans/submit`, {
        method: "POST",
        body: await upload({ file: ["fresh.geojson", "application/geo+json", new Blob([fresh])], documents: PDF }),
      });
      const body = await res.json();
      assert.equal(res.status, 502, JSON.stringify(body));
      assert.equal(body.rolledBack, true);
      assert.match(body.error, /Nothing was appended/);
    } finally {
      delete process.env.EMULATOR_ATTACHMENTS;
    }
    assert.equal((await records()).length, before);
  });

  it("never appends duplicates: parcels already in the layer (by UPI or geometry) and repeats in the file are skipped", async () => {
    const planner = new Browser();
    await planner.signIn("planner.huye");

    // The Shapefile was appended by an earlier test: everything in it now exists.
    let res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: SHAPEFILE }) });
    let body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.match(body.error, /already in Physical_Plans/);
    assert.equal(body.duplicates.length, 3);
    assert.ok(body.duplicates.every((d: { reason: string; existingObjectId?: number }) => d.reason === "upi" && d.existingObjectId! > 0));

    // Mixed file: an existing parcel re-surveyed without its UPI (geometry match), one new parcel,
    // and the new parcel repeated with the same UPI.
    const geo = JSON.parse(await readFile("samples/muhanga-parcels-wgs84.geojson", "utf8")) as {
      features: { properties: Record<string, unknown>; geometry: { coordinates: number[][][] } }[];
    };
    const existingNoUpi = { ...geo.features[0]!, properties: { plan_id: "PP-RESURVEY" } };
    const fresh = {
      type: "Feature",
      properties: { parcel_upi: "2/01/05/01/9999", plan_id: "PP-NEW" },
      geometry: { type: "Polygon", coordinates: [[[29.76, -2.08], [29.7605, -2.08], [29.7605, -2.0795], [29.76, -2.08]]] },
    };
    const mixed = JSON.stringify({ type: "FeatureCollection", features: [existingNoUpi, fresh, { ...fresh, properties: { parcel_upi: " 2/01/05/01/9999 " } }] });

    // The preview endpoint (used by the page) reports the same duplicates the append will skip.
    const { uploadFingerprints } = await import("../../lib/plans/duplicates");
    const { parseUploadFile } = await import("../../lib/geo/parse-upload");
    const parsed = await parseUploadFile("mixed.geojson", new TextEncoder().encode(mixed).buffer as ArrayBuffer);
    const layerFields = [{ name: "parcel_upi", type: "esriFieldTypeString", editable: true }, { name: "plan_id", type: "esriFieldTypeString", editable: true }];
    const preview = await planner.request(`${APP}/api/plans/duplicates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: uploadFingerprints(parsed.features, parsed.fieldNames, layerFields) }),
    });
    const previewBody = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(previewBody));
    assert.deepEqual(
      previewBody.duplicates.map((d: { index: number; reason: string }) => [d.index, d.reason]),
      [[0, "geometry"], [2, "upi"]],
    );

    res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: ["mixed.geojson", "application/geo+json", new Blob([mixed])] }) });
    body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.objectIds.length, 1);
    assert.equal(body.duplicates.length, 2);
    assert.equal((await records()).filter((r) => r.parcel_upi === "2/01/05/01/9999").length, 1);
    assert.equal((await records()).filter((r) => r.plan_id === "PP-RESURVEY").length, 0);
  });

  it("rejects invalid files and values, naming the feature and field", async () => {
    const planner = new Browser();
    await planner.signIn("planner.huye");
    const post = async (parts: Record<string, UploadPart>) => {
      const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload(parts) });
      return { status: res.status, body: await res.json() };
    };

    let r = await post({ file: ["samples/invalid-projected-coordinates.geojson", "application/geo+json"] });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /projected coordinate system/);

    const tooLong = JSON.stringify({
      type: "FeatureCollection",
      features: [1, 2].map((i) => ({
        type: "Feature",
        properties: { plan_id: `P${i}`, district_1: i === 2 ? "x".repeat(60) : "Muhanga" },
        // Distinct locations: identical shapes would (correctly) be skipped as repeats.
        geometry: { type: "Polygon", coordinates: [[[29.6 + i * 0.01, -2.09], [29.601 + i * 0.01, -2.09], [29.601 + i * 0.01, -2.089], [29.6 + i * 0.01, -2.09]]] },
      })),
    });
    r = await post({ file: ["long.geojson", "application/geo+json", new Blob([tooLong])] });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Feature 2, field "district_1".*too long \(60\/50/);

    r = await post({ file: SHAPEFILE, documents: ["samples/muhanga-parcels-wgs84.geojson", "application/pdf"] });
    assert.equal(r.status, 415);
    assert.equal(r.body.field, "documents");
  });

  it("shows planners NLA's response and documents on their own submissions only", async () => {
    const planner = new Browser();
    await planner.signIn("planner.muhanga");
    const plan = JSON.stringify({
      type: "FeatureCollection",
      features: [0, 1].map((i) => ({
        type: "Feature",
        // remarks/approval_date are NLA's fields: the planner's values must not be stored.
        properties: { plan_id: "PP-REVIEW-1", parcel_upi: `REVIEW-${i}`, district_1: "Muhanga", remarks: "planner text", approval_date: "2026-01-01" },
        geometry: { type: "Polygon", coordinates: [[[29.79 + i * 0.001, -2.07], [29.7905 + i * 0.001, -2.07], [29.7905 + i * 0.001, -2.0695], [29.79 + i * 0.001, -2.07]]] },
      })),
    });
    const res = await planner.request(`${APP}/api/plans/submit`, {
      method: "POST",
      body: await upload({ file: ["review.geojson", "application/geo+json", new Blob([plan])], documents: PDF }),
    });
    const { objectIds } = await res.json();
    assert.equal(res.status, 201);
    const stored = (await records()).filter((r) => objectIds.includes(r.OBJECTID));
    assert.ok(stored.every((r) => r.remarks == null && r.approval_date == null), "NLA fields are not taken from the file");

    // React separates text parts with <!-- --> markers; drop them to assert on what the planner reads.
    let page = (await (await planner.get(`${APP}/submissions`)).text()).replace(/<!-- -->/g, "");
    assert.match(page, /My submissions/);
    // Newest submission first, as the planner sees it (titled by date; no IDs shown).
    assert.match(page, /<ul[^>]*><li[^>]*>.*?Waiting for NLA.*?2 parcels/s);
    assert.doesNotMatch(page.match(/<ul[^>]*>.*?<\/ul>/s)![0], /PP-REVIEW-1|OBJECTID/);

    // An NLA reviewer comments on the first parcel, attaches a document, and approves the second parcel.
    const review = new FormData();
    review.set("oid", String(objectIds[0]));
    review.set("remarks", "Widen the road reserve to 12 m");
    review.set("attachment", new Blob([await readFile("samples/sample-plan-document.pdf")], { type: "application/pdf" }), "nla-review.pdf");
    const reviewed = await (await fetch(`${emulatorUrl}/dev/respond`, { method: "POST", body: review })).json();
    const nlaDoc = reviewed.attachments.find((a: { name: string }) => a.name === "nla-review.pdf");
    const ownDoc = reviewed.attachments.find((a: { name: string }) => a.name === "sample-plan-document.pdf");
    const approve = new FormData();
    approve.set("oid", String(objectIds[1]));
    approve.set("approval_date", "2026-10-09");
    await fetch(`${emulatorUrl}/dev/respond`, { method: "POST", body: approve });

    page = await (await planner.get(`${APP}/submissions`)).text();
    const first = page.match(/<ul[^>]*><li[^>]*>(.*?)<\/li>/s)![1]!.replace(/<!-- -->/g, "");
    // A parcel with NLA's comment and no approval date is returned: the planner has to act.
    assert.match(first, /Returned for changes/);
    // Two PDFs are attached to the parcel; only the reviewer's counts as a document from NLA.
    assert.match(first, /1 document from NLA/);
    assert.match(page, /Widen the road reserve to 12 m/, "NLA's comment is in the page data");

    // Downloads and parcel shapes are limited to the planner's own submissions.
    const file = await planner.get(`${APP}/api/plans/attachment?oid=${objectIds[0]}&aid=${nlaDoc.id}&name=nla-review.pdf`);
    assert.equal(file.status, 200);
    assert.match(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), /%PDF-/);
    const shapes = await (await planner.get(`${APP}/api/plans/mine/parcels?oids=${objectIds.join(",")}`)).json();
    assert.equal(shapes.features.length, 2);
    assert.equal(shapes.features[1].properties.approval_date, "2026-10-09");

    const other = new Browser();
    await other.signIn("planner.huye");
    assert.equal((await other.get(`${APP}/api/plans/attachment?oid=${objectIds[0]}&aid=${ownDoc.id}`)).status, 404);
    assert.equal((await (await other.get(`${APP}/api/plans/mine/parcels?oids=${objectIds.join(",")}`)).json()).features.length, 0);
    assert.doesNotMatch(await (await other.get(`${APP}/submissions`)).text(), /Widen the road reserve/);
  });

  it("NLA reviews in the review app: return with comments, revised plan, approval", async () => {
    // A planner submits two parcels with a PDF.
    const planner = new Browser();
    await planner.signIn("planner.huye");
    const plan = (shift: number) =>
      JSON.stringify({
        type: "FeatureCollection",
        features: [0, 1].map((i) => ({
          type: "Feature",
          properties: { plan_id: "PP-HUYE-1", parcel_upi: `HUYE-${i}`, district_1: "Huye" },
          geometry: { type: "Polygon", coordinates: [[[29.75 + i * 0.001, -2.6], [29.7505 + i * 0.001 + shift, -2.6], [29.7505 + i * 0.001, -2.5995], [29.75 + i * 0.001, -2.6]]] },
        })),
      });
    const send = (body: string, replaces?: number) =>
      upload({ file: ["huye.geojson", "application/geo+json", new Blob([body])], documents: PDF }).then((form) => {
        if (replaces !== undefined) form.set("replaces", String(replaces));
        return planner.request(`${APP}/api/plans/submit`, { method: "POST", body: form });
      });
    let res = await send(plan(0));
    assert.equal(res.status, 201);
    const first = (await res.json()).objectIds as number[];
    const submittedAt = (await records()).find((r) => r.OBJECTID === first[0])!.created_date as number;

    // Only NLA reviewers get into the review app; the planner's session is not accepted there.
    assert.match((await new Browser(REVIEW).signIn("planner.huye")).search, /auth_error=.*not\+an\+NLA\+plan\+reviewer/);
    const decide = (who: Browser | string, fields: Record<string, string>, pdf?: boolean) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      if (pdf) form.append("documents", new Blob([readFileSync("samples/sample-plan-document.pdf")], { type: "application/pdf" }), "nla-comments.pdf");
      return typeof who === "string"
        ? fetch(`${REVIEW}/api/review/decision`, { method: "POST", body: form, headers: { cookie: who } })
        : who.request(`${REVIEW}/api/review/decision`, { method: "POST", body: form });
    };
    const target = { planner: "planner.huye", submittedAt: String(submittedAt) };
    assert.equal((await decide(planner.cookieHeader, { ...target, decision: "approve" })).status, 401);
    assert.equal((await fetch(`${APP}/api/review/decision`, { method: "POST", body: new FormData() })).status, 404);

    const reviewer = new Browser(REVIEW);
    assert.equal((await reviewer.signIn("reviewer.nla")).pathname, "/");
    let page = (await (await reviewer.get(`${REVIEW}/`)).text()).replace(/<!-- -->/g, "");
    assert.match(page, /Physical Plan Review/);
    assert.match(page, /Huye Planner.*?To review/s, "the queue shows the planner's full name");
    // Reviewer sessions are not accepted by the submission app either.
    assert.equal((await fetch(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: GEOJSON }), headers: { cookie: reviewer.cookieHeader } })).status, 401);

    // Returning needs a comment; the comment and NLA's PDF go back to the planner.
    assert.equal((await decide(reviewer, { ...target, decision: "return" })).status, 422);
    res = await decide(reviewer, { ...target, decision: "return", comment: "Parcel HUYE-1 overlaps the wetland buffer" }, true);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).submission.status, "returned");
    let stored = (await records()).filter((r) => first.includes(r.OBJECTID));
    assert.ok(stored.every((r) => r.remarks === "Parcel HUYE-1 overlaps the wetland buffer" && r.approval_date == null && r.last_edited_user === "reviewer.nla"));
    assert.deepEqual(stored[0]!.attachments.sort(), ["nla-comments.pdf", "sample-plan-document.pdf"]);

    page = (await (await planner.get(`${APP}/submissions`)).text()).replace(/<!-- -->/g, "");
    assert.match(page.match(/<ul[^>]*><li[^>]*>(.*?)<\/li>/s)![1]!, /Returned for changes/);
    assert.match(page, /overlaps the wetland buffer/);
    page = (await (await planner.get(`${APP}/?revise=${submittedAt}`)).text()).replace(/<!-- -->/g, "");
    assert.match(page, /Revised plan/);

    // The revised plan replaces the returned parcels (same UPIs, so not refused as duplicates) and keeps NLA's PDF.
    res = await send(plan(0.0001), submittedAt);
    const revised = await res.json();
    assert.equal(res.status, 201, JSON.stringify(revised));
    assert.equal(revised.objectIds.length, 2);
    assert.equal(revised.replacedCount, 2);
    const all = await records();
    assert.ok(!all.some((r) => first.includes(r.OBJECTID)), "returned parcels are replaced");
    stored = all.filter((r) => revised.objectIds.includes(r.OBJECTID));
    assert.ok(stored.every((r) => r.remarks == null && r.approval_date == null), "the revision waits for NLA again");
    assert.deepEqual(stored[0]!.attachments.sort(), ["nla-comments.pdf", "sample-plan-document.pdf"]);
    assert.equal((await send(plan(0), submittedAt)).status, 409, "a submission is revised once");

    // NLA approves the revision: approval_date is what the public map filters on.
    const revisedAt = String(stored[0]!.created_date);
    res = await decide(reviewer, { planner: "planner.huye", submittedAt: revisedAt, decision: "approve" });
    assert.equal(res.status, 200);
    stored = (await records()).filter((r) => revised.objectIds.includes(r.OBJECTID));
    assert.ok(stored.every((r) => typeof r.approval_date === "number" && r.remarks == null));
    assert.equal((await decide(reviewer, { planner: "planner.huye", submittedAt: revisedAt, decision: "approve" })).status, 409);
    page = (await (await planner.get(`${APP}/submissions`)).text()).replace(/<!-- -->/g, "");
    assert.match(page.match(/<ul[^>]*><li[^>]*>(.*?)<\/li>/s)![1]!, /Approved/);

    // Reviewers can open any planner's documents and parcels.
    const doc = await reviewer.get(`${REVIEW}/api/plans/mine/parcels?oids=${revised.objectIds.join(",")}`);
    assert.equal((await doc.json()).features.length, 2);
  });

  it("signs out and revokes the session", async () => {
    const planner = new Browser();
    await planner.signIn("planner.muhanga");
    const res = await planner.request(`${APP}/api/auth/logout`, { method: "POST" });
    assert.equal(res.status, 303);
    assert.equal(planner.signedIn, false);
    const after = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await upload({ file: SHAPEFILE }) });
    assert.equal(after.status, 401);
  });
});
