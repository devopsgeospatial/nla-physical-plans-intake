/**
 * DEV ONLY: captures README screenshots of the real UI (production build) against the ArcGIS emulator,
 * using the locally installed Microsoft Edge (or Chrome) via playwright-core.
 *
 *   npm run build && npm run screenshots
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, type Page } from "playwright-core";

process.env.EMULATOR_PORT = "4198";
const APP_PORT = 3198;
const APP = `http://localhost:${APP_PORT}`;
const OUT = "docs/screenshots";

async function main() {
  const mod = await import("./arcgis-emulator");
  const emulator = await mod.startEmulator();
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const app = spawn(process.execPath, [nextBin, "start", "-p", String(APP_PORT)], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      ARCGIS_PORTAL_URL: mod.EMULATOR_PORTAL_URL,
      ARCGIS_FEATURE_LAYER_URL: mod.EMULATOR_LAYER_URL,
      ARCGIS_OAUTH_CLIENT_ID: "screenshots",
      ARCGIS_ALLOWED_GROUP_ID: mod.EMULATOR_GROUP_ID,
      ARCGIS_OAUTH_REDIRECT_URI: `${APP}/api/auth/callback`,
      APP_URL: APP,
      SESSION_SECRET: "screenshot-session-secret-that-is-long-enough",
    },
  });
  for (let i = 0; i < 60 && !(await fetch(APP).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge" });
  try {
    await mkdir(OUT, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    const shot = (name: string) => page.screenshot({ path: `${OUT}/${name}.png` });

    await page.goto(APP);
    await shot("01-sign-in");

    await page.getByRole("link", { name: "Sign in with ArcGIS" }).click();
    await page.waitForURL(/oauth2\/authorize/);
    await shot("02-arcgis-sign-in-emulated");

    await page.getByText("Viewer Account").click();
    await page.waitForURL(/auth_error/);
    await shot("03-viewer-refused");

    await page.getByRole("link", { name: "Sign in with ArcGIS" }).click();
    await page.getByText("Muhanga Planner").click();
    await page.waitForSelector("text=Boundary preview");

    await page.fill("#plan_name", "Muhanga Town Centre Master Plan");
    await page.selectOption("#district", "Muhanga");
    await page.selectOption("#plan_type", "Master Plan");
    await page.setInputFiles("#boundary", "samples/muhanga-test-plan.geojson");
    await page.waitForSelector("text=Valid Polygon");
    await page.setInputFiles("#documents", "samples/sample-plan-document.pdf");
    await waitForTiles(page);
    await shot("04-form-with-boundary-preview");

    await page.getByRole("button", { name: "Submit plan" }).click();
    await page.waitForSelector("text=Plan submitted");
    await waitForTiles(page);
    await shot("05-submitted");

    await page.getByRole("button", { name: "Start a new submission" }).click();
    await page.fill("#plan_name", "Kamonyi Subdivision (invalid boundary)");
    await page.selectOption("#district", "Kamonyi");
    await page.selectOption("#plan_type", "Subdivision");
    await page.setInputFiles("#boundary", "samples/invalid-self-intersecting.geojson");
    await page.waitForSelector("text=self-intersecting");
    await page.locator("#boundary").scrollIntoViewIfNeeded();
    await waitForTiles(page);
    await shot("06-invalid-boundary-rejected");

    await page.goto(`http://localhost:${mod.EMULATOR_PORT}/`);
    await shot("07-stored-record");
    console.log(`Screenshots written to ${OUT}/`);
  } finally {
    await browser.close();
    app.kill();
    emulator.close();
  }
}

/** Waits for Leaflet basemap tiles to finish loading (best effort; needs internet for the Esri basemap). */
async function waitForTiles(page: Page) {
  await page
    .waitForFunction(() => {
      const tiles = [...document.querySelectorAll<HTMLImageElement>(".leaflet-tile")];
      return tiles.length > 0 && tiles.every((t) => t.complete);
    }, undefined, { timeout: 15_000 })
    .catch(() => console.warn("basemap tiles did not finish loading; continuing"));
  await page.waitForTimeout(800); // let fitBounds animation settle
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
