/**
 * DEV ONLY: `npm run dev:local` starts the local ArcGIS emulator and `next dev` pointed at it.
 * Real environment values from .env.local are overridden for this process only (process env
 * takes precedence over .env files in Next.js), so nothing about the real setup changes.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { EMULATOR_GROUP_ID, EMULATOR_LAYER_URL, EMULATOR_PORT, EMULATOR_PORTAL_URL, startEmulator } from "./arcgis-emulator";

const APP_PORT = Number(process.env.PORT ?? 3000);
const APP_URL = `http://localhost:${APP_PORT}`;

async function main() {
  const emulator = await startEmulator().catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") throw new Error(`Port ${EMULATOR_PORT} is in use. Stop the other process or set EMULATOR_PORT.`);
    throw err;
  });

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(APP_PORT)], {
    stdio: "inherit",
    env: {
      ...process.env,
      ARCGIS_PORTAL_URL: EMULATOR_PORTAL_URL,
      ARCGIS_FEATURE_LAYER_URL: EMULATOR_LAYER_URL,
      ARCGIS_OAUTH_CLIENT_ID: "local-emulator",
      ARCGIS_OAUTH_REDIRECT_URI: `${APP_URL}/api/auth/callback`,
      ARCGIS_ALLOWED_GROUP_ID: EMULATOR_GROUP_ID,
      APP_URL,
      SESSION_SECRET: "local-emulator-session-secret-not-for-production",
    },
  });

  console.log(`
  ┌───────────────────────────────────────────────────────────────┐
  │  LOCAL TEST MODE (ArcGIS emulator, nothing reaches ArcGIS)      │
  │  Intake app:         ${APP_URL.padEnd(41)}│
  │  Emulator / records: ${`http://localhost:${EMULATOR_PORT}/`.padEnd(41)}│
  │  Test sign-in:       ${"planner.muhanga / rla-test".padEnd(41)}│
  └───────────────────────────────────────────────────────────────┘
`);

  const shutdown = () => {
    child.kill();
    emulator.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", (code) => {
    emulator.close();
    process.exit(code ?? 0);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
