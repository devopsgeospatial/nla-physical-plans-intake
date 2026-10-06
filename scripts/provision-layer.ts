/**
 * Creates the intake feature layer from the command line with a username/password:
 *
 *   npm run provision-layer -- --name Physical_Plan_Submissions --match-sr <reference layer URL>
 *
 * Usually not needed: a signed-in publisher can create the layer from the app's setup screen instead.
 * Reads ARCGIS_PORTAL_URL / ARCGIS_USERNAME / ARCGIS_PASSWORD / ARCGIS_TOKEN_REFERER / ARCGIS_REFERENCE_LAYER_URL
 * from .env.local. The account must be a built-in login (generateToken does not work for SSO or MFA).
 */
import { createTokenProvider } from "../lib/arcgis/auth";
import { provisionLayer } from "../lib/arcgis/provision";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} (expected in .env.local).`);
  return value.replace(/\/+$/, "");
}

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main() {
  const portalUrl = env("ARCGIS_PORTAL_URL");
  const username = env("ARCGIS_USERNAME");
  const tokens = createTokenProvider({
    portalUrl,
    referer: process.env.ARCGIS_TOKEN_REFERER || "http://localhost:3000",
    expirationMinutes: 30,
    credentials: { mode: "password", username, password: env("ARCGIS_PASSWORD") },
  });

  const result = await provisionLayer({
    portalUrl,
    username,
    tokens,
    serviceName: argValue("--name", "Physical_Plan_Submissions"),
    referenceLayerUrl: argValue("--match-sr", process.env.ARCGIS_REFERENCE_LAYER_URL ?? "") || undefined,
    log: (message) => console.log(message),
  });
  console.log("");
  console.log("Done. Set in .env.local:");
  console.log(`  ARCGIS_FEATURE_LAYER_URL=${result.layerUrl}`);
  console.log(`Portal item: ${result.itemUrl}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `ERROR: ${err.message}` : err);
  process.exit(1);
});
