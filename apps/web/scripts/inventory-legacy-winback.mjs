/**
 * inventory-legacy-winback.mjs  — READ ONLY. Makes ZERO writes anywhere.
 *
 * Surfaces the "legacy" group-event cohort for the $20 win-back campaign:
 * events that are confirmed in BMI, have a deposit paid, still owe a balance,
 * are in the FUTURE, and are NOT already on the new group_function_quotes flow.
 *
 * Source of truth is BMI (real dates/deposit/balance), reached the same way
 * lib/bmi-scan.ts does: BMI Office dayPlanner for the project list + state,
 * then Pandora (/v2/bmi/reservation) to enrich products/payments/contact.
 *
 * MODES
 *   node scripts/inventory-legacy-winback.mjs --states
 *       Enumerate distinct dayPlanner stateIds across future projects (count +
 *       sample names) and enrich a few samples per state, so we can IDENTIFY the
 *       confirmation/deposit-paid state id (don't guess). Run this first.
 *
 *   node scripts/inventory-legacy-winback.mjs --state=<id> [--state=<id> ...]
 *       Cohort listing filtered to those dayPlanner state id(s). Prints the
 *       eligible events + EXCLUDED ones (post-pay / no-deposit / past / already
 *       ingested) with the reason, plus totals and incentive cost.
 *
 * FLAGS
 *   --center=fort-myers|naples   limit to one BMI db (default: both)
 *   --months=N                   forward scan window in 30-day chunks (default 12)
 *   --max-enrich=N               safety cap on Pandora enrich calls (default 600)
 */

import { readFileSync } from "node:fs";
import https from "node:https";

// ── env ──────────────────────────────────────────────────────────────
const envPath = new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const env = {};
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) env[m[1]] = m[2];
}

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS = env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const SWAGGER_KEY = env.SWAGGER_ADMIN_KEY || "";
const DATABASE_URL = env.DATABASE_URL || env.POSTGRES_URL || "";

// Mirrors lib/bmi-scan.ts CENTERS + lib/hermes-client.ts PANDORA_LOCATION_IDS.
const CENTERS = [
  {
    clientKey: "headpinzftmyers",
    centerCode: "fort-myers",
    label: "Fort Myers/FT",
    pandoraLoc: "TXBSQN0FEKQ11",
  },
  {
    clientKey: "headpinznaples",
    centerCode: "naples",
    label: "Naples",
    pandoraLoc: "PPTR5G2N0QXF7",
  },
];

// Built-in BMI pseudo-states (lib + bmi-confirm-proof.mjs). Custom workflow
// states (large positive ids) are named via /metadata when available.
const BUILTIN_STATE_NAMES = {
  "-1": "New",
  "-2": "Reservation",
  "-3": "Confirmation",
  "-4": "Cancellation",
  "-5": "Arrived",
};

// ── args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const STATES_MODE = Boolean(flag("states", false));
const STATE_IDS = args.filter((a) => a.startsWith("--state=")).map((a) => a.split("=")[1]);
const ONLY_CENTER = flag("center", null);
const MONTHS = Number(flag("months", 12));
const MAX_ENRICH = Number(flag("max-enrich", 600));
const NOW = new Date();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── BMI Office API (https module, matches lib/bmi-scan.ts) ─────────────
function officeReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function officeToken(clientKey) {
  const res = await officeReq(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200)
    throw new Error(`Office auth failed (${clientKey}): ${res.status} ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

function officeHeaders(token, clientKey) {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `inv-${Date.now()}`,
    clientkey: clientKey,
  };
}

function extractAllResourceIds(meta) {
  const ids = new Set();
  for (const r of meta.resources || []) ids.add(String(r.id));
  for (const g of meta.resourceGroups || [])
    for (const r of g.resources || []) ids.add(String(r.id));
  return [...ids];
}

function monthlyWindows(from, months) {
  const out = [];
  const cursor = new Date(from);
  for (let i = 0; i < months; i++) {
    const start = cursor.toISOString().slice(0, 10);
    cursor.setDate(cursor.getDate() + 30);
    out.push({ from: start, till: cursor.toISOString().slice(0, 10) });
  }
  return out;
}

/** Pull all future, non-online projects for a center. Returns {projects, stateNames}. */
async function scanProjects(center) {
  const token = await officeToken(center.clientKey);
  const headers = officeHeaders(token, center.clientKey);

  const metaRes = await officeReq("GET", `/api/${center.clientKey}/metadata`, headers);
  if (metaRes.status >= 400) throw new Error(`metadata ${metaRes.status}`);
  const meta = JSON.parse(metaRes.body);
  const ids = extractAllResourceIds(meta);
  const resourceParam = ids.map((id) => `resourceIds=${id}`).join("&");

  // Best-effort: map custom workflow state ids → names from metadata.
  const stateNames = { ...BUILTIN_STATE_NAMES };
  for (const s of meta.projectStates || meta.states || meta.projectStatuses || []) {
    if (s && s.id != null)
      stateNames[String(s.id)] = s.name || s.displayName || s.description || "";
  }

  const seen = new Set();
  const projects = [];
  for (const w of monthlyWindows(NOW, MONTHS)) {
    try {
      const dpRes = await officeReq(
        "GET",
        `/api/${center.clientKey}/dayPlanner?${resourceParam}&from=${w.from}&till=${w.till}&showAll=true`,
        headers,
      );
      if (dpRes.status >= 400) continue;
      const dp = JSON.parse(dpRes.body);
      for (const p of dp.reservations?.projects || []) {
        if (String(p.kindId) === "-10") continue; // online reservations
        const id = String(p.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const d = new Date(normalizeDate(p.date));
        if (isNaN(d.getTime()) || d <= NOW) continue; // future only
        projects.push({ ...p, _date: d });
      }
    } catch (err) {
      console.warn(`  [${center.label}] window ${w.from}→${w.till} failed: ${err.message}`);
    }
    await sleep(80);
  }
  return { projects, stateNames };
}

function normalizeDate(raw) {
  if (!raw) return raw;
  const hasTz = raw.includes("Z") || raw.includes("+") || /\d-\d{2}:\d{2}$/.test(raw);
  return hasTz ? raw : `${raw}-04:00`; // ET, matches bmi-scan.ts
}

// ── Pandora enrichment ─────────────────────────────────────────────────
async function fetchReservation(pandoraLoc, reservationId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${PANDORA_BASE}/v2/bmi/reservation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SWAGGER_KEY}` },
        body: JSON.stringify({ locationID: pandoraLoc, reservationId }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      if (!body || !body.success) return null;
      return body.data;
    } catch (err) {
      if (attempt === 0) {
        await sleep(500);
        continue;
      } // one retry on timeout/network
      console.warn(`    (pandora ${reservationId} failed: ${err.name})`);
      return null;
    }
  }
  return null;
}

/** Derive money facts from an enriched Pandora reservation. */
function moneyFacts(r) {
  const products = r?.products || [];
  const payments = r?.payments || [];
  const isPostPay = products.some((p) => p.name === "GF Post Paid Account");
  const isTaxExempt = products.some((p) => p.name === "GF Tax Exempt");
  const subtotal = products.reduce((s, p) => s + (Number(p.total) || 0), 0);
  // p.tax is a per-line RATE (e.g. 0.065) per bmi-scan.ts.
  const tax = isTaxExempt
    ? 0
    : products.reduce((s, p) => s + (Number(p.tax) || 0) * (Number(p.total) || 0), 0);
  const total = subtotal + tax;
  const deposit = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const balance = Math.round((total - deposit) * 100) / 100;
  return {
    isPostPay,
    isTaxExempt,
    total: Math.round(total * 100) / 100,
    deposit: Math.round(deposit * 100) / 100,
    balance,
    products,
    payments,
  };
}

// ── Existing-quotes guard (Neon, read only) ────────────────────────────
async function loadExistingReservationIds() {
  if (!DATABASE_URL) return new Set();
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(DATABASE_URL);
    const rows = await sql`SELECT bmi_reservation_id FROM group_function_quotes`;
    return new Set(rows.map((r) => String(r.bmi_reservation_id)));
  } catch (err) {
    console.warn(`  (could not read existing quotes: ${err.message} — treating all as new)`);
    return new Set();
  }
}

// ── modes ──────────────────────────────────────────────────────────────
async function runStatesMode(centers) {
  for (const center of centers) {
    console.log(
      `\n${"═".repeat(72)}\n  [${center.label}] dayPlanner state enumeration (future projects)\n${"═".repeat(72)}`,
    );
    let projects, stateNames;
    try {
      ({ projects, stateNames } = await scanProjects(center));
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      continue;
    }
    const byState = new Map();
    for (const p of projects) {
      const sid = String(p.stateId);
      if (!byState.has(sid)) byState.set(sid, { count: 0, samples: [] });
      const e = byState.get(sid);
      e.count++;
      if (e.samples.length < 3) e.samples.push(p);
    }
    const sorted = [...byState.entries()].sort((a, b) => b[1].count - a[1].count);
    console.log(`  ${projects.length} future projects across ${sorted.length} states:\n`);
    for (const [sid, e] of sorted) {
      console.log(`  state ${sid} (${stateNames[sid] || "?"}) — ${e.count} project(s)`);
      for (const s of e.samples) {
        console.log(
          `      ${s._date.toISOString().slice(0, 10)}  #${s.number || "?"}  ${s.displayName || s.name}`,
        );
      }
    }
    // Enrich up to 2 samples per state to reveal which states carry a paid deposit.
    console.log(`\n  — deposit/balance probe (2 samples/state via Pandora) —`);
    let enriched = 0;
    for (const [sid, e] of sorted) {
      for (const s of e.samples.slice(0, 2)) {
        if (enriched >= MAX_ENRICH) break;
        const r = await fetchReservation(center.pandoraLoc, String(s.id));
        enriched++;
        await sleep(120);
        if (!r) {
          console.log(`      state ${sid} #${s.number}: (no pandora data)`);
          continue;
        }
        const m = moneyFacts(r);
        console.log(
          `      state ${sid} (${stateNames[sid] || "?"}) #${s.number}: total $${m.total} deposit $${m.deposit} balance $${m.balance}` +
            `${m.isPostPay ? " [POSTPAY]" : ""}${m.isTaxExempt ? " [taxexempt]" : ""}`,
        );
      }
    }
  }
  console.log(
    `\nNext: pick the state id whose samples reliably show deposit > 0 + balance > 0, then run:`,
  );
  console.log(`  node scripts/inventory-legacy-winback.mjs --state=<id> [--state=<id>]`);
}

async function runCohortMode(centers) {
  if (STATE_IDS.length === 0) {
    console.error(
      "No --state=<id> provided. Run with --states first to identify the confirmation state id(s).",
    );
    process.exit(2);
  }
  const stateSet = new Set(STATE_IDS.map(String));
  const existing = await loadExistingReservationIds();
  console.log(`Filtering to dayPlanner state id(s): ${[...stateSet].join(", ")}`);
  console.log(`Known reservation ids already on new flow: ${existing.size}\n`);

  const eligible = [];
  const excluded = [];
  let enriched = 0;

  for (const center of centers) {
    let projects;
    try {
      ({ projects } = await scanProjects(center));
    } catch (err) {
      console.log(`  [${center.label}] ERROR: ${err.message}`);
      continue;
    }
    const inState = projects.filter((p) => stateSet.has(String(p.stateId)));
    console.log(
      `  [${center.label}] ${projects.length} future projects, ${inState.length} in target state(s).`,
    );

    for (const p of inState) {
      const resId = String(p.id);
      if (existing.has(resId)) {
        excluded.push({
          center: center.label,
          resId,
          name: p.displayName || p.name,
          reason: "already on new flow",
          date: p._date,
        });
        continue;
      }
      if (enriched >= MAX_ENRICH) {
        excluded.push({
          center: center.label,
          resId,
          name: p.displayName || p.name,
          reason: "enrich cap reached",
          date: p._date,
        });
        continue;
      }

      const r = await fetchReservation(center.pandoraLoc, resId);
      enriched++;
      await sleep(120);
      if (!r) {
        excluded.push({
          center: center.label,
          resId,
          name: p.displayName || p.name,
          reason: "no pandora data",
          date: p._date,
        });
        continue;
      }

      const m = moneyFacts(r);
      const row = {
        center: center.label,
        resId,
        date: p._date,
        number: r.event?.number || p.number || "",
        name: r.event?.name || p.displayName || p.name || "",
        total: m.total,
        deposit: m.deposit,
        balance: m.balance,
        guest: `${r.customer?.first || ""} ${r.customer?.last || ""}`.trim(),
        email: r.customer?.email || "",
        phone: r.customer?.phone || "",
      };
      if (m.isPostPay) {
        excluded.push({ ...row, reason: "post-pay (no touch)" });
        continue;
      }
      if (m.deposit <= 0) {
        excluded.push({ ...row, reason: "no deposit" });
        continue;
      }
      if (m.balance <= 1) {
        excluded.push({ ...row, reason: "no balance due" });
        continue;
      }
      eligible.push(row);
    }
  }

  eligible.sort((a, b) => a.date - b.date);
  console.log(
    `\n${"═".repeat(72)}\n  ELIGIBLE LEGACY WIN-BACK COHORT (${eligible.length})\n${"═".repeat(72)}`,
  );
  let owed = 0;
  for (const r of eligible) {
    owed += r.balance;
    console.log(
      `${r.date.toISOString().slice(0, 10)} | ${r.center.padEnd(12)} | bal $${r.balance.toFixed(2).padStart(9)} ` +
        `(total $${r.total.toFixed(2)}, dep $${r.deposit.toFixed(2)}) | res ${r.resId} | ${r.guest} <${r.email}> ${r.phone} | ${r.name}`,
    );
  }
  console.log(`\nEXCLUDED (${excluded.length}):`);
  const byReason = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason)) console.log(`   ${reason}: ${n}`);

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Eligible events:        ${eligible.length}`);
  console.log(`Total balance owed:     $${owed.toFixed(2)}`);
  console.log(`Incentive cost @ $20:   $${(eligible.length * 20).toFixed(2)}`);
  console.log(
    `Run date:               ${NOW.toISOString().slice(0, 10)}  (READ ONLY — nothing was written)`,
  );
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  if (!SWAGGER_KEY) {
    console.error("Missing SWAGGER_ADMIN_KEY in .env.local");
    process.exit(1);
  }
  const centers = ONLY_CENTER ? CENTERS.filter((c) => c.centerCode === ONLY_CENTER) : CENTERS;
  if (centers.length === 0) {
    console.error(`Unknown --center=${ONLY_CENTER}`);
    process.exit(1);
  }

  if (STATES_MODE) await runStatesMode(centers);
  else await runCohortMode(centers);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
