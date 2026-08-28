#!/usr/bin/env node
/**
 * ADMIN TOKEN LEAK PIN — fails the build if the permanent admin secret can
 * reach a browser.
 *
 * ADMIN_CAMERA_TOKEN opens every admin page and every admin API on both brand
 * domains, and it is not rotatable without breaking every staff bookmark and
 * every alert ever sent. For a long time the `/admin/{token}/*` page server
 * components handed it straight to their client components, so it shipped in
 * ~20 browser bundles. The SSO work replaced that with a signed 8-hour token
 * (lib/admin-api-token.ts) — but nothing stopped the next person from typing
 * `process.env.ADMIN_CAMERA_TOKEN` into a client file and quietly putting it
 * back.
 *
 * This does. It scans the modules that can end up in a client bundle and fails
 * on any reference to the static token env vars:
 *
 *   1. any module whose first non-empty line is "use client"
 *   2. everything under src/components/**            (client by convention)
 *   3. every src/features/<x>/api.ts                  (browser fetch layer)
 *   4. every app/admin/**\/*Client*.tsx                (the boards themselves)
 *
 * Run by `npm run test -w fasttrax-web`, before vitest, so a leak fails fast.
 *
 * If you hit this: you want `mintAdminApiToken()` in the PAGE (a server
 * component) and the resulting string passed down as a prop. Never the env var.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/** The env names that must never be readable from a browser bundle. */
const FORBIDDEN = ["ADMIN_CAMERA_TOKEN", "ADMIN_ETICKETS_TOKEN"];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo", ".git"]);
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (CODE_EXT.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

/** `"use client"` (or `'use client'`) as the module's first real statement. */
function isUseClient(src) {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    return /^["']use client["'];?$/.test(t);
  }
  return false;
}

function rel(file) {
  return path.relative(WEB_ROOT, file).replace(/\\/g, "/");
}

/** Why this file is treated as browser-reachable — printed with the failure. */
function clientReason(file, src) {
  const r = rel(file);
  if (isUseClient(src)) return '"use client" module';
  if (r.startsWith("src/components/")) return "under src/components/** (client by convention)";
  if (/^src\/features\/[^/]+\/api\.ts$/.test(r)) return "a feature's browser fetch layer";
  if (/^app\/admin\/.*Client[^/]*\.tsx$/.test(r)) return "an admin board client component";
  return null;
}

const failures = [];
let scanned = 0;
let clientModules = 0;

for (const dir of ["app", "src", "components", "lib", "hooks"]) {
  for await (const file of walk(path.join(WEB_ROOT, dir))) {
    if (/\.(?:test|spec)\.[tj]sx?$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    scanned++;
    const reason = clientReason(file, src);
    if (!reason) continue;
    clientModules++;
    for (const name of FORBIDDEN) {
      if (!src.includes(name)) continue;
      const line = src.split("\n").findIndex((l) => l.includes(name)) + 1;
      failures.push({ file: rel(file), line, name, reason });
    }
  }
}

if (failures.length > 0) {
  console.error("\n✖ Admin token leak — the static admin secret is reachable from a browser:\n");
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    references ${f.name} — ${f.reason}`);
  }
  console.error(
    "\n  Fix: mint a short-lived credential in the PAGE (a server component) with",
    "\n  mintAdminApiToken() from @/lib/admin-api-token and pass the string down as",
    "\n  a prop. The client keeps sending it as x-admin-token / ?token= exactly as",
    "\n  before — the middleware accepts both.\n",
  );
  process.exit(1);
}

console.log(
  `✓ admin token leak check: ${clientModules} browser-reachable modules of ${scanned} scanned, none reference ${FORBIDDEN.join(" / ")}`,
);
