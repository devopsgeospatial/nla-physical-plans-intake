/**
 * End-to-end: the production build (`next start`) against the local ArcGIS emulator.
 * Exercises OAuth sign-in (PKCE), access checks, submission with PDF, validation errors and sign-out
 * over real HTTP. Requires `next build` first (npm run test:e2e does both).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createRequire } from "node:module";
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

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  app = spawn(process.execPath, [nextBin, "start", "-p", String(APP_PORT)], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
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
  throw new Error("app did not start; run `next build` first");
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

async function submission(fields: Record<string, string>, files: Record<string, [string, string]>): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [field, [path, type]] of Object.entries(files)) {
    form.append(field, new Blob([await readFile(path)], { type }), path.split("/").pop());
  }
  return form;
}

const validFields = { plan_name: "Muhanga Test Plan", district: "Muhanga", plan_type: "Master Plan" };
const validFiles: Record<string, [string, string]> = {
  boundary: ["samples/muhanga-test-plan.geojson", "application/geo+json"],
  documents: ["samples/sample-plan-document.pdf", "application/pdf"],
};

describe("plan submission (production build vs ArcGIS emulator)", () => {
  it("shows the sign-in screen and refuses anonymous submissions", async () => {
    const page = await (await fetch(APP)).text();
    assert.match(page, /Sign in with ArcGIS/);
    const res = await fetch(`${APP}/api/plans/submit`, { method: "POST", body: await submission(validFields, validFiles) });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).signInRequired, true);
  });

  it("refuses a Viewer account and a user outside the submitters group", async () => {
    const viewer = new Browser();
    const v = await viewer.signIn("viewer.only");
    assert.match(v.searchParams.get("auth_error") ?? "", /Edit features/);
    assert.equal(viewer.signedIn, false);

    const outsider = new Browser();
    const o = await outsider.signIn("outsider");
    assert.match(o.searchParams.get("auth_error") ?? "", /not a member/);
  });

  it("rejects a tampered OAuth state", async () => {
    const res = await fetch(`${APP}/api/auth/callback?code=x&state=forged`, { redirect: "manual" });
    assert.match(new URL(res.headers.get("location")!).searchParams.get("auth_error") ?? "", /could not be verified/);
  });

  it("signs in a planner, submits a plan with a PDF, and stores it in TM Rwanda", async () => {
    const planner = new Browser();
    const landing = await planner.signIn("planner.muhanga");
    assert.equal(landing.pathname, "/");
    assert.equal(planner.signedIn, true);
    assert.match(await (await planner.get(APP)).text(), /Muhanga Planner[\s\S]*Boundary preview/);

    const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await submission(validFields, validFiles) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.submittedBy, "planner.muhanga");
    assert.equal(body.attributes.status, "SUBMITTED");
    assert.equal(body.attachments.length, 1);

    // Read back from the "ArcGIS" side.
    const stored = await (await fetch(`${emulatorUrl}/arcgis/rest/services/Physical_Plan_Submissions/FeatureServer/0/query?f=json&token=x`)).json();
    assert.equal(stored.error?.code, 499, "layer must not be readable without a token");
    const page = await (await fetch(`${emulatorUrl}/`)).text();
    assert.match(page, /Muhanga Test Plan[\s\S]*planner\.muhanga[\s\S]*4738\d\d\.\d, 47689\d\d\.\d[\s\S]*sample-plan-document\.pdf/);
    const pdf = await fetch(`${emulatorUrl}/files/${body.objectId}/${body.attachments[0].attachmentId}`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), /%PDF-/);
  });

  it("returns field-specific validation errors", async () => {
    const planner = new Browser();
    await planner.signIn("planner.huye");
    const post = async (fields: Record<string, string>, files: Record<string, [string, string]>) => {
      const res = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await submission(fields, files) });
      return { status: res.status, body: await res.json() };
    };

    let r = await post(validFields, { ...validFiles, boundary: ["samples/invalid-self-intersecting.geojson", "application/geo+json"] });
    assert.equal(r.status, 422);
    assert.equal(r.body.field, "boundary");
    assert.match(r.body.error, /self-intersecting/);

    r = await post(validFields, { ...validFiles, boundary: ["samples/invalid-projected-coordinates.geojson", "application/geo+json"] });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /projected coordinate system/);

    r = await post(validFields, { ...validFiles, documents: ["samples/muhanga-test-plan.geojson", "application/pdf"] });
    assert.equal(r.status, 415);
    assert.equal(r.body.field, "documents");

    r = await post({ ...validFields, district: "Atlantis" }, validFiles);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "district");
  });

  it("signs out and revokes the session", async () => {
    const planner = new Browser();
    await planner.signIn("planner.muhanga");
    const res = await planner.request(`${APP}/api/auth/logout`, { method: "POST" });
    assert.equal(res.status, 303);
    assert.equal(planner.signedIn, false);
    const after = await planner.request(`${APP}/api/plans/submit`, { method: "POST", body: await submission(validFields, validFiles) });
    assert.equal(after.status, 401);
  });
});
