/**
 * End-to-end: the production build (`next start`) against the local ArcGIS emulator, which mirrors
 * the real Physical_Plans layer. Exercises OAuth sign-in (PKCE), access checks, appending a
 * Shapefile / GeoJSON with attributes and PDFs, rollback, validation errors and sign-out over real
 * HTTP. Requires `next build` first (npm run test:e2e does both).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

const APP_PORT = 3199;
const APP = `http://localhost:${APP_PORT}`;
process.env.EMULATOR_PORT = "4199";

let emulator: Server;
let app: ChildProcess;
let emulatorUrl: string;

before(async () => {
  const mod = await import("../../scripts/dev/arcgis-emulator");
  emulatorUrl = `http://localhost:${mod.EMULATOR_PORT}`;
  emulator = await mod.startEmulator();

  // The production server exactly as deployed (standalone bundle, see npm run build).
  app = spawn(process.execPath, [".next/standalone/server.js"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(APP_PORT),
      HOSTNAME: "127.0.0.1",
      ARCGIS_PORTAL_URL: mod.EMULATOR_PORTAL_URL,
      ARCGIS_FEATURE_LAYER_URL: mod.EMULATOR_LAYER_URL,
      ARCGIS_OAUTH_CLIENT_ID: "e2e",
      ARCGIS_ALLOWED_GROUP_ID: mod.EMULATOR_GROUP_ID,
      ARCGIS_OAUTH_REDIRECT_URI: `${APP}/api/auth/callback`,
      APP_URL: APP,
      SESSION_SECRET: "e2e-session-secret-that-is-long-enough-123",
    },
  });
  for (let i = 0; i < 60; i++) {
    if (await fetch(APP).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("app did not start; run `npm run build` first");
});

after(() => {
  app?.kill();
  emulator?.close();
});

/** Minimal cookie jar + manual redirect following, so each hop can be asserted. */
class Browser {
  private cookies = new Map<string, string>();

  async get(url: string): Promise<Response> {
    return this.request(url, { method: "GET" });
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(APP) && this.cookies.size) {
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
    let res = await this.get(`${APP}/api/auth/login`);
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
