// After `next build` with output: "standalone", the server bundle needs the static assets beside it.
import { cpSync, existsSync } from "node:fs";

if (existsSync(".next/standalone")) {
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });
}
