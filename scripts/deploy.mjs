/**
 * Deploys this folder's code to the live apps on Vercel (production).
 *
 *   npm run deploy                     all four apps
 *   npm run deploy -- public landing   only the apps named
 *
 * The same code runs as four Vercel projects; each project's own settings (Environment Variables)
 * decide which app it is (APP_MODE) and which ArcGIS layers it uses.
 */
import { spawnSync } from "node:child_process";

const ORG = "team_saCzBh7XLVaAvvKxriTCPf5u";
const APPS = {
  submission: { project: "prj_LdyHEVj6RHoVxF8SCgbvGIA5ner1", url: "https://nla-physical-plans.vercel.app" },
  review: { project: "prj_phpdskiSIFoE9NNl071tZ0xo0QYD", url: "https://nla-physical-plans-review.vercel.app" },
  public: { project: "prj_jH3gq0uEsOkrcMm40XzaH4BnZP5N", url: "https://nla-physical-plans-public.vercel.app" },
  landing: { project: "prj_5u6at4uEAObg7KjXG1jAU9zeg66T", url: "https://nla-physical-plans-home.vercel.app" },
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !(name in APPS));
if (unknown.length > 0) {
  console.error(`Unknown app: ${unknown.join(", ")}. Choose from: ${Object.keys(APPS).join(", ")}.`);
  process.exit(1);
}
const names = wanted.length > 0 ? wanted : Object.keys(APPS);

const results = [];
for (const name of names) {
  const { project, url } = APPS[name];
  console.log(`\n=== Deploying ${name} (${url}) ===`);
  const run = spawnSync("npx", ["vercel", "deploy", "--prod", "--yes"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: project },
  });
  results.push({ name, url, ok: run.status === 0 });
}

console.log("\nResult:");
for (const r of results) console.log(`  ${r.ok ? "OK    " : "FAILED"} ${r.name.padEnd(10)} ${r.url}`);
if (results.some((r) => !r.ok)) process.exit(1);
