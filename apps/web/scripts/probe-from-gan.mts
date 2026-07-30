/**
 * READ-ONLY live probe: what does POST /v2/gift-cards/from-gan return for
 * (a) a physical plastic Square gift card and (b) an eGift — and how does the
 * kiosk-planned normalization turn scanner/MSR raw captures into a GAN candidate?
 *
 * Settles, for the kiosk split-tender flow (paste output into
 * tasks/split-tender-probes.md):
 *   Q1. Does the from-gan response carry `type` (PHYSICAL vs DIGITAL) — i.e.
 *       can the kiosk tell a plastic card from an eGift by lookup alone?
 *   Q2. Do real scanner/MSR bursts (track-2 swipes, QR URLs, bare numbers)
 *       normalize to a GAN that from-gan resolves?
 *   Q3. Would isInternalDepositGan block that GAN as an internal deposit card
 *       (prefix check against KNOWN_DEPOSIT_GAN_PREFIXES)?
 *
 * Sequence:
 *   1. Normalize every --raw capture — strip whitespace/dashes; if it looks
 *      like track data (starts ";" or contains "="), extract the digit run
 *      between ";" and "=" or "?"; if it is a URL, print host+path SHAPE and
 *      hunt for an 8–20 alnum segment. Print the masked candidate
 *      (first 2 + last 4) and its classification
 *      (bare-gan | track | url | unrecognized).
 *   2. For each candidate and each --gan: POST /gift-cards/from-gan. Print
 *      found?, state, balance, type (PHYSICAL/DIGITAL/absent), gan last-4,
 *      and whether isInternalDepositGan would block it.
 *   3. Nothing to clean up — this probe performs ZERO mutations (from-gan is a
 *      POST-shaped read). Zero liabilities left either way: nothing is ever
 *      created, and the finally block only asserts that.
 *
 * Privacy: full raw captures, full track data, and full GANs are NEVER logged.
 * Candidates print masked (first 2 + last 4, plus length); lookups print the
 * gan last-4 only. Square error bodies ARE logged (truncated to 400 chars,
 * with the looked-up value redacted to its mask) — diagnosis is the whole point.
 *
 * Exit-code contract:
 *   0 — the probe ran: dry run, lookup misses, even Square errors. This probe
 *       carries no pass/fail signal; the printed observations are the deliverable.
 *   2 — the probe did NOT run to completion: crashed (uncaught exception /
 *       unhandled rejection / mid-loop error), interrupted (SIGINT/SIGTERM),
 *       --live without usable env (.env.local unreadable or SQUARE_ACCESS_TOKEN
 *       unset — dry runs need neither), or a rejected --gan value (must be
 *       8–20 alphanumerics after stripping whitespace/dashes).
 *   1 — never used; reserved for a deliberate verdict, and this probe has none.
 *
 * DRY RUN by default (prints exactly which from-gan calls WOULD be made).
 *   npx tsx scripts/probe-from-gan.mts --raw ";6278…burst…?" --gan 7783320012345678
 *   npx tsx scripts/probe-from-gan.mts --live --gan <plastic gan> --gan <egift gan>
 * Flags:
 *   --gan <value>       repeatable — a GAN to look up directly; whitespace/dashes
 *                       are stripped, then it must be 8–20 alphanumerics
 *                       (same rule as --raw candidates) or the probe exits 2
 *   --raw <burst>       repeatable, QUOTE IT — a raw scanner/MSR capture to normalize
 *   --location <id>     default LAB52GY480CJF (FastTrax Fort Myers — kiosk venue);
 *                       from-gan is account-scoped, kept for log context only
 *   --live              perform the from-gan lookups (still strictly read-only)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const LIVE = process.argv.includes("--live");
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  // Missing env is only fatal when --live — dry runs make zero Square calls.
  if (LIVE) {
    console.error("Could not read .env.local — run from apps/web (needs .env.local).");
    process.exit(2);
  }
}

// ── cleanup + crash/interrupt rails ──────────────────────────────────────────
// Zero mutations by design, so cleanup only asserts that nothing was created.
// Memoized promise: every caller awaits the SAME in-flight run, so no exit
// path can fire mid-cleanup. doCleanup is internally try/caught: unable to throw.
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  return (cleanupPromise ??= doCleanup());
}
async function doCleanup(): Promise<void> {
  try {
    console.log("\ncleanup: nothing to clean up (zero mutations — read-only probe)");
  } catch {
    /* cleanup must never throw */
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await cleanup();
    console.error(`\n${sig} received — interrupted (exit 2). No objects were created; no manual trail needed.`);
    process.exit(2);
  });
}
process.on("uncaughtException", async (err) => {
  console.error("\nUNCAUGHT EXCEPTION:", err);
  await cleanup();
  process.exit(2);
});
process.on("unhandledRejection", async (err) => {
  console.error("\nUNHANDLED REJECTION:", err);
  await cleanup();
  process.exit(2);
});
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const KEY = `probe-${randomUUID().slice(0, 8)}`; // run id for log correlation (no mutations → no idempotency keys)

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const ganArgs: string[] = [];
const rawArgs: string[] = [];
let LOCATION = "LAB52GY480CJF"; // FastTrax Fort Myers — the venue with the kiosk reader
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--gan" && argv[i + 1]) ganArgs.push(argv[++i]);
  else if (argv[i] === "--raw" && argv[i + 1]) rawArgs.push(argv[++i]);
  else if (argv[i] === "--location" && argv[i + 1]) LOCATION = argv[++i];
}

// Validate --gan values UP FRONT: strip whitespace/dashes, then require 8–20
// alphanumerics (the same window --raw candidates must satisfy). Rejecting
// invalid values here keeps them out of the lookups entirely — and keeps the
// error-body redaction from over-firing on short substrings. Values are never
// printed (full GANs are never logged), only their length.
const gans = ganArgs.map((g) => g.replace(/[\s-]+/g, ""));
gans.forEach((g, i) => {
  if (!/^[A-Za-z0-9]{8,20}$/.test(g)) {
    console.error(
      `Invalid --gan #${i + 1}: after stripping whitespace/dashes a GAN must be 8–20 alphanumerics (got length ${g.length}).`,
    );
    console.error('Scanner/MSR captures that need normalization go through --raw "<burst>" instead.');
    process.exit(2); // contract: the probe did not run
  }
});

// Prefix set the kiosk's isInternalDepositGan uses (lib/square-gift-card.ts).
// Dynamic import AFTER env load, matching the house pattern. Needed even in
// dry run (the deposit-block answer), so an import failure is fatal: exit 2
// with a pointer rather than a raw module-not-found crash.
let KNOWN_DEPOSIT_GAN_PREFIXES: readonly string[];
try {
  ({ KNOWN_DEPOSIT_GAN_PREFIXES } = await import("@/lib/gan"));
} catch (err) {
  console.error("Could not import @/lib/gan — run from apps/web (npx tsx scripts/probe-from-gan.mts).");
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A Square call must never throw — surface network failures as an error shape.
    return { ok: false, status: 0, json: { errors: [{ code: "NETWORK", detail: String(err) }] } };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  const ok = res.ok && !(json?.errors?.length > 0);
  return { ok, status: res.status, json };
}

// ── masking — full raw inputs / candidates / GANs are never printed ─────────
function mask(value: string): string {
  if (value.length <= 6) return `${value.slice(0, 1)}…(too short to mask meaningfully)`;
  return `${value.slice(0, 2)}…${value.slice(-4)}`;
}

// ── step-1 normalization — the exact logic the kiosk will use ────────────────
type Classification = "bare-gan" | "track" | "url" | "unrecognized";
interface Normalized {
  classification: Classification;
  candidate: string | null;
  note: string;
}

function normalizeRaw(raw: string): Normalized {
  const trimmed = raw.trim();

  // URL check FIRST: query strings contain "=" and would otherwise be
  // misclassified as track data by the "contains =" heuristic below.
  if (/^(https?:\/\/|www\.)/i.test(trimmed) || trimmed.includes("://")) {
    try {
      const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      // Shape only — every alnum run ≥5 chars becomes {alnumN} so nothing leaks.
      const shape = (s: string) => s.replace(/[A-Za-z0-9]{5,}/g, (m) => `{alnum${m.length}}`);
      const pathShape = shape(u.pathname) || "/";
      const queryShape = [...u.searchParams.entries()].map(([k, v]) => `${k}=${shape(v)}`).join("&");
      // Candidate: longest 8–20 alnum segment among path segments + query values.
      const segments = [...u.pathname.split("/"), ...[...u.searchParams.values()]];
      const candidates = segments.filter((s) => /^[A-Za-z0-9]{8,20}$/.test(s));
      const candidate = candidates.sort((a, b) => b.length - a.length)[0] ?? null;
      return {
        classification: "url",
        candidate,
        note: `host=${u.host} path=${pathShape}${queryShape ? ` query=${queryShape}` : ""}`,
      };
    } catch {
      return { classification: "url", candidate: null, note: "looked like a URL but failed to parse" };
    }
  }

  // Strip whitespace/dashes (scanner bursts often interleave CR/LF; embossed
  // plastic numbers are often read back with dashes/spaces).
  const stripped = trimmed.replace(/[\s-]+/g, "");

  // Track data (MSR swipe): track 2 is ";<PAN>=<discretionary>?".
  if (stripped.startsWith(";") || stripped.includes("=")) {
    let m = stripped.match(/;(\d+)[=?]/); // digit run between ";" and "=" or "?"
    if (!m) m = stripped.match(/^(\d+)=/); // sentinel lost by a keyboard-wedge capture
    return {
      classification: "track",
      candidate: m?.[1] ?? null,
      note: m ? `track-2 style burst (input len ${raw.length})` : `track-shaped burst but no digit run found (input len ${raw.length})`,
    };
  }

  // Bare GAN: Square's custom-GAN window is 8–20 alnum (lib/gan.ts); Square's
  // own auto GANs (16-digit) fall inside it too.
  if (/^[A-Za-z0-9]{8,20}$/.test(stripped)) {
    return { classification: "bare-gan", candidate: stripped, note: `bare value (len ${stripped.length})` };
  }

  return {
    classification: "unrecognized",
    candidate: null,
    note:
      stripped.length >= 8
        ? `no 8–20 alnum candidate after strip (stripped len ${stripped.length}, masked ${mask(stripped)})`
        : `too short after strip (len ${stripped.length})`,
  };
}

// Inline reimplementation of isInternalDepositGan (lib/square-gift-card.ts),
// longest-prefix-first, so the probe reports exactly what checkout would block.
function matchDepositPrefix(gan: string): string | null {
  const upper = gan.toUpperCase();
  const sorted = [...KNOWN_DEPOSIT_GAN_PREFIXES].sort((a, b) => b.length - a.length);
  return sorted.find((p) => upper.startsWith(p.toUpperCase())) ?? null;
}

// ── build the lookup list (dedupe; remember where each candidate came from) ──
interface Lookup {
  gan: string;
  sources: string[];
}
const lookups: Lookup[] = [];
function addLookup(gan: string, source: string) {
  const existing = lookups.find((l) => l.gan === gan);
  if (existing) existing.sources.push(source);
  else lookups.push({ gan, sources: [source] });
}

console.log(`probe-from-gan ${KEY}  location=${LOCATION} (context only — from-gan is account-scoped)`);
console.log(LIVE ? "!!! LIVE against PRODUCTION Square — lookups only, strictly read-only, zero mutations !!!" : "=== DRY RUN (pass --live to perform the from-gan lookups) ===");

if (ganArgs.length === 0 && rawArgs.length === 0) {
  console.log("\nNo inputs. Usage:");
  console.log('  npx tsx scripts/probe-from-gan.mts [--live] --gan <gan> [--gan <gan> …] --raw "<burst>" [--raw "<burst>" …]');
  console.log("\nVERDICT: NO INPUTS — nothing looked up, nothing observed.");
  process.exit(0); // contract: exit 0 always
}

// ── 1. normalize raw captures ────────────────────────────────────────────────
console.log(`\n1. normalizing ${rawArgs.length} raw capture(s)…`);
rawArgs.forEach((raw, i) => {
  const n = normalizeRaw(raw);
  const cand = n.candidate ? `${mask(n.candidate)} (len ${n.candidate.length})` : "NONE";
  console.log(`   1.${i + 1} classification=${n.classification}  candidate=${cand}`);
  console.log(`        ${n.note}`);
  if (n.candidate) addLookup(n.candidate, `--raw #${i + 1} (${n.classification})`);
});
if (rawArgs.length === 0) console.log("   (no --raw inputs)");
gans.forEach((g, i) => addLookup(g, `--gan #${i + 1}`)); // already stripped + validated up front

// ── dry run: print the exact calls that WOULD be made, then exit ─────────────
if (!LIVE) {
  console.log(`\n2. would POST /gift-cards/from-gan for ${lookups.length} candidate(s):`);
  lookups.forEach((l, i) => {
    const prefix = matchDepositPrefix(l.gan);
    console.log(`   2.${i + 1} Would: POST /gift-cards/from-gan { gan: ${mask(l.gan)} }  [from ${l.sources.join(", ")}]`);
    console.log(`        isInternalDepositGan would block: ${prefix ? `YES (prefix ${prefix})` : "no"}`);
  });
  console.log("\ncleanup: nothing to clean up (zero mutations by design)");
  console.log("\nVERDICT: DRY RUN — no Square calls made. Re-run with --live for real lookups.");
  process.exit(0);
}

// ── 2. live from-gan lookups (read-only) ─────────────────────────────────────
if (!TOKEN) {
  console.log("\nERROR: SQUARE_ACCESS_TOKEN is not set — cannot perform lookups.");
  console.log("Run from apps/web (needs .env.local with SQUARE_ACCESS_TOKEN).");
  console.log("\nVERDICT: NOT RUN — missing SQUARE_ACCESS_TOKEN.");
  process.exit(2); // contract: --live without usable env = exit 2
}

let found = 0;
let missed = 0;
let crashed = false;
// Literal gift_card.type values → count ("(absent)" when the field is missing).
// No preconceived PHYSICAL/DIGITAL buckets — the VERDICT reports what Square
// actually returned, including values we did not anticipate.
const typeCounts = new Map<string, number>();

try {
  console.log(`\n2. POST /gift-cards/from-gan for ${lookups.length} candidate(s)…`);
  for (let i = 0; i < lookups.length; i++) {
    const l = lookups[i];
    console.log(`   2.${i + 1} lookup ${mask(l.gan)} (len ${l.gan.length})  [from ${l.sources.join(", ")}]`);
    const r = await sq("POST", "/gift-cards/from-gan", { gan: l.gan });
    const gc = r.json?.gift_card;
    if (!r.ok || !gc?.id) {
      missed++;
      console.log(`        found: NO (HTTP ${r.status})`);
      // Redact the looked-up value before printing — Square error bodies can
      // echo the GAN back (e.g. in `detail`), and full GANs are never logged.
      const errStr = String(JSON.stringify(r.json?.errors ?? r.json)).split(l.gan).join(mask(l.gan));
      console.log(`        error: ${errStr.slice(0, 400)}`);
      continue;
    }
    found++;
    const type: string | undefined = gc.type;
    const typeKey = typeof type === "string" ? type : "(absent)";
    typeCounts.set(typeKey, (typeCounts.get(typeKey) ?? 0) + 1);
    const bal = gc.balance_money?.amount ?? 0;
    const respGan: string = gc.gan ?? l.gan;
    const prefix = matchDepositPrefix(respGan);
    console.log(
      `        found: YES  state=${gc.state ?? "UNKNOWN"}  balance=$${(bal / 100).toFixed(2)}  type=${type ?? "(absent from response)"}  gan last4=${respGan.slice(-4)}`,
    );
    console.log(`        isInternalDepositGan would block: ${prefix ? `YES (prefix ${prefix})` : "no"}`);
  }
} catch (err) {
  // sq() never throws, so anything landing here is a genuine crash → exit 2.
  crashed = true;
  console.error("PROBE ERROR:", err instanceof Error ? err.message : err);
} finally {
  // Structurally unable to throw (memoized promise + internal try/catch), so
  // the VERDICT print + process.exit below always run.
  await cleanup();
}

const typeSummary = [...typeCounts.entries()].map(([t, n]) => `${n}× type=${t}`).join(", ");
console.log(
  `\nVERDICT: ${lookups.length} lookup(s) → ${found} found${found > 0 ? ` (${typeSummary})` : ""}, ${missed} not found/error.`,
);
if (crashed) console.log("→ probe crashed mid-run — observations above may be partial (exit 2).");
console.log("→ paste the observations above into tasks/split-tender-probes.md");
process.exit(crashed ? 2 : 0); // contract: exit 0 = ran (even with misses/errors); exit 2 = crashed
