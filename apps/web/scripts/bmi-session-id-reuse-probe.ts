/**
 * bmi-session-id-reuse-probe — LIVE, READ-ONLY.
 *
 * Proves the stable-`x-session-id` change is safe against the real BMI Office
 * API. The unit tests only prove the STRING is stable; they cannot prove BMI
 * tolerates one session id being reused, which is the actual risk the change
 * introduces. Two ways it could bite:
 *
 *   1. STALENESS — if BMI caches per session, a reused id could serve a frozen
 *      snapshot while a fresh id sees current data.
 *   2. CONCURRENCY — if BMI holds per-session request state, two in-flight
 *      reads sharing one id could interfere (wrong body, 4xx/5xx, or a hang).
 *
 * Design. Every claim gets a CONTROL:
 *   - Staleness: INTERLEAVED PAIRS. Read with a fresh random id, then
 *     immediately with the stable id, and compare the two bodies. Adjacent in
 *     time, so a real booking landing mid-run changes both arms together
 *     instead of faking a divergence.
 *   - Concurrency: N reads fired at once, ALL sharing the stable id.
 *   - Identity: assert the refactor did not change the two id VALUES that were
 *     already stable — `sweep-headpinzftmyers` is the string BMI Office named
 *     on 2026-08-25, and their monitoring would lose the thread if we renamed it.
 *
 * WRITES: none. Only /auth/token, /metadata and /dayPlanner (GET).
 * COST: ~11 reads per center — under one minute of what group-quote-dispatch
 * already spends, which matters while BMI is saturated.
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-session-id-reuse-probe.mts
 */

import https from "https";
import { createHash, randomUUID } from "crypto";
import { officeReadSessionId } from "../lib/bmi-office-ids";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

/**
 * Env only — no hardcoded fallback. lib/bmi-scan.ts and lib/bmi-office-actions.ts
 * carry a literal service password as a default; a probe must not spread it into
 * more files. Same precedence the sweep route uses: base64 first, then plain.
 */
const envUser = process.env.BMI_OFFICE_USERNAME;
const envPass = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD;
if (!envUser || !envPass) {
  console.error(
    "Need BMI_OFFICE_USERNAME and BMI_OFFICE_PASSWORD(_B64).\n" +
      "  npx tsx --env-file=../../.env.local scripts/bmi-session-id-reuse-probe.ts",
  );
  process.exit(2);
}
// Re-bound as plain strings: the guard above narrows here, but that narrowing
// does not reach into the request helpers below.
const OFFICE_USER: string = envUser;
const OFFICE_PASS: string = envPass;

const CENTERS = ["headpinzftmyers", "headpinznaples"] as const;
const PAIRS = 4; // interleaved fresh/stable comparisons per center
const CONCURRENT = 3; // simultaneous reads sharing one stable id

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`   FAIL  ${msg}`);
};
const pass = (msg: string) => console.log(`   ok    ${msg}`);

function req(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data, ms: Date.now() - t0 }),
        );
      },
    );
    r.on("error", reject);
    r.setTimeout(45_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

async function token(clientKey: string): Promise<string> {
  const res = await req(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200) throw new Error(`auth ${clientKey} → ${res.status}`);
  return JSON.parse(res.body).access_token;
}

const headers = (tok: string, clientKey: string, sessionId: string) => ({
  Authorization: `Bearer ${tok}`,
  "x-fast-version": SMS_VERSION,
  "x-session-id": sessionId,
  clientkey: clientKey,
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * dayPlanner re-encrypts `projectReference` on EVERY response: the values are
 * `U2FsdGVkX1…` = base64 "Salted__", a CryptoJS/OpenSSL salted ciphertext of the
 * same plaintext with a fresh random salt each time. Fixed width, so the body
 * LENGTH never changes while every byte-hash differs — which is what made the
 * first version of this probe report a false divergence on 8/8 pairs.
 * (scripts/bmi-dayplanner-response-variance.ts is the diagnostic that proved it.)
 *
 * Blanking the field is also what makes the comparison meaningful: if two
 * normalized bodies are equal, then projectReference was the ONLY difference —
 * so this doubles as the check that nothing else drifted.
 */
const PROJECT_REFERENCE = /"projectReference":"[^"]*"/g;
const normalize = (s: string) => s.replace(PROJECT_REFERENCE, '"projectReference":"<salted>"');

/** Small, comparable read: today-only dayPlanner. */
function plannerPath(clientKey: string, resourceParam: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `/api/${clientKey}/dayPlanner?${resourceParam}&from=${today}&till=${today}&showAll=true`;
}

async function probeCenter(clientKey: string) {
  console.log(`\n── ${clientKey} ${"─".repeat(Math.max(0, 46 - clientKey.length))}`);
  const stableRead = officeReadSessionId("read", clientKey);
  const stableScan = officeReadSessionId("scan", clientKey);
  console.log(`   session ids under test: "${stableRead}", "${stableScan}"`);

  const tok = await token(clientKey);

  // Resource ids, via the stable id — if a stable id were rejected outright,
  // this first real call is where it shows.
  const meta = await req("GET", `/api/${clientKey}/metadata`, headers(tok, clientKey, stableRead));
  if (meta.status !== 200) {
    fail(`metadata with stable id "${stableRead}" → ${meta.status}`);
    return;
  }
  pass(`metadata accepted the stable id (${meta.status}, ${meta.ms}ms)`);

  const parsed = JSON.parse(meta.body);
  const ids = new Set<string>();
  for (const r of (parsed.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (parsed.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");
  console.log(`   ${ids.size} resource ids → dayPlanner (today only)`);

  const path = plannerPath(clientKey, resourceParam);

  // ── 1. Staleness: interleaved fresh-vs-stable pairs ──────────────
  const freshMs: number[] = [];
  const stableMs: number[] = [];
  let divergences = 0;
  for (let i = 1; i <= PAIRS; i++) {
    const fresh = await req("GET", path, headers(tok, clientKey, randomUUID()));
    const stable = await req("GET", path, headers(tok, clientKey, stableRead));
    if (fresh.status !== 200 || stable.status !== 200) {
      fail(`pair ${i}: fresh → ${fresh.status}, stable → ${stable.status}`);
      continue;
    }
    freshMs.push(fresh.ms);
    stableMs.push(stable.ms);
    const fn = normalize(fresh.body);
    const sn = normalize(stable.body);
    // Guard the comparator itself: if normalize() ever nuked the payload, an
    // all-pass result would mean nothing.
    if (i === 1 && (!fn.includes('"projects":[') || fn.length < fresh.body.length * 0.9)) {
      fail(
        `normalize() mangled the body (${fresh.body.length}b → ${fn.length}b) — comparison void`,
      );
    }
    const fh = hash(fn);
    const sh = hash(sn);
    const same = fh === sh;
    if (!same) divergences++;
    console.log(
      `   pair ${i}: fresh ${fh} (${fresh.ms}ms) ${same ? "==" : "!="} stable ${sh} (${stable.ms}ms)` +
        `  ${fresh.body.length}b/${stable.body.length}b`,
    );
  }
  if (divergences === 0) {
    pass(`no staleness: reused id matched a fresh id on all ${PAIRS} pairs`);
  } else {
    // Not automatically a bug — a booking can land mid-run — but it is the
    // signature a caching bug would leave, so it must not pass silently.
    fail(`reused id diverged from a fresh id on ${divergences}/${PAIRS} pairs — INVESTIGATE`);
  }

  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b) / xs.length) : 0;
  console.log(`   latency: fresh avg ${avg(freshMs)}ms vs stable avg ${avg(stableMs)}ms`);

  // ── 2. Concurrency: simultaneous reads sharing ONE stable id ─────
  const together = await Promise.all(
    Array.from({ length: CONCURRENT }, () =>
      req("GET", path, headers(tok, clientKey, stableRead)).catch((e) => ({
        status: -1,
        body: String(e),
        ms: -1,
      })),
    ),
  );
  const bad = together.filter((r) => r.status !== 200);
  const hashes = new Set(
    together.filter((r) => r.status === 200).map((r) => hash(normalize(r.body))),
  );
  console.log(
    `   concurrent x${CONCURRENT} on one id: statuses [${together.map((r) => r.status).join(", ")}], ` +
      `${hashes.size} distinct body hash(es)`,
  );
  if (bad.length) fail(`${bad.length}/${CONCURRENT} concurrent reads on a shared id failed`);
  else if (hashes.size !== 1)
    fail(`concurrent reads on a shared id returned ${hashes.size} different bodies`);
  else pass(`${CONCURRENT} concurrent reads on one shared id: all 200, identical bodies`);
}

async function main() {
  console.log("BMI Office — stable x-session-id live probe (READ-ONLY)");

  // ── 0. Identity: the refactor must not have renamed anything ─────
  console.log("\n── id values ───────────────────────────────────────────");
  const checks: Array<[string, string]> = [
    [officeReadSessionId("sweep", "headpinzftmyers"), "sweep-headpinzftmyers"],
    [officeReadSessionId("sweep", "headpinznaples"), "sweep-headpinznaples"],
    [officeReadSessionId("race-dayof", "headpinzftmyers"), "race-dayof-headpinzftmyers"],
  ];
  for (const [got, want] of checks) {
    if (got === want) pass(`unchanged: "${got}"`);
    else fail(`RENAMED: got "${got}", BMI knows "${want}"`);
  }

  for (const c of CENTERS) {
    try {
      await probeCenter(c);
    } catch (err) {
      fail(`${c}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — live probe complete`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
