/**
 * Settle waiver signatures that BMI ALREADY HONOURS.
 *
 * A signature that rode the `waiver-push` topic and was dropped at 20 deliveries
 * keeps `outcome = 'queued'` forever — nothing sweeps that table and no
 * `bmi_sync_queue` row stands behind it. The admin board then reports it as
 * "the signature is safe in Neon but BMI does not have it", and keeps saying so.
 *
 * For most of those rows that sentence is FALSE. Measured 2026-08-13, after the
 * Pandora outage: of 15 stranded signatures, 11 already had a valid waiver at
 * the guest's own center, several running to 2027. The push had in fact
 * succeeded, or the guest already held one — only our label was wrong.
 *
 * A board that cries wolf gets ignored, and the real rows get ignored with it,
 * so clearing the false ones is not cosmetic. This is the same failure as
 * counting `queued` as done, pointed the other way.
 *
 * WHAT THIS DOES NOT DO: it never writes to BMI. Not a waiver, not a repair,
 * nothing. It asks the vendor what it already holds and makes our record agree.
 * A row the vendor cannot vouch for is left exactly as it is and reported as
 * still owed — those need `sync-redrive-0813.mts`, which does push.
 *
 * Every row is re-probed AT WRITE TIME rather than trusting an earlier survey,
 * so a stale reading cannot settle a row that is genuinely outstanding.
 *
 *   npx tsx scripts/waiver-settle-already-valid.mts           # dry run
 *   APPLY=1 npx tsx scripts/waiver-settle-already-valid.mts   # write
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.env.APPLY === "1";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const CENTER: Record<string, string> = {
  LAB52GY480CJF: "FastTrax",
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
const cn = (id: any) => CENTER[String(id)] ?? String(id ?? "—");

if (!PKEY) {
  console.error("SWAGGER_ADMIN_KEY missing — cannot ask BMI anything. Refusing to settle blind.");
  process.exit(1);
}

console.log(
  `\n════ settle waivers BMI already honours (${APPLY ? "APPLY" : "DRY-RUN"}) ` +
    `${new Date().toLocaleString()} ════`,
);

const rows = (await sql`
  SELECT s.id, s.person_id, s.location_id,
         ROUND(EXTRACT(EPOCH FROM (now() - s.ts)) / 60)::int AS age_min,
         (SELECT j.display_name FROM kiosk_waiver_joins j
           WHERE j.person_id = s.person_id ORDER BY j.created_at DESC LIMIT 1) AS name
  FROM waiver_signatures s
  WHERE s.push_transport = 'vercel-queue'
    AND (s.outcome IS NULL OR s.outcome = 'queued')
    AND s.ts > now() - INTERVAL '48 hours'
  ORDER BY s.ts
`) as any[];

console.log(`\n${rows.length} signature(s) still unsettled.\n`);

let settled = 0;
let owed = 0;
let unknown = 0;

for (const r of rows) {
  const who = r.name ? `${r.name} (${r.person_id})` : String(r.person_id);
  let expiry: string | null = null;
  let verdict: "valid" | "no-waiver" | "unknown" = "unknown";
  let detail = "";

  try {
    const res = await fetch(
      `https://bma-pandora-api.azurewebsites.net/v2/bmi/person/` +
        `${encodeURIComponent(String(r.location_id))}/${encodeURIComponent(String(r.person_id))}`,
      { headers: { Authorization: `Bearer ${PKEY}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.ok) {
      const b: any = await res.json();
      const w = b?.data?.waiverExpiry;
      if (w && Date.parse(w) > Date.now()) {
        verdict = "valid";
        expiry = String(w).slice(0, 10);
      } else {
        verdict = "no-waiver";
        detail = w ? `expired ${String(w).slice(0, 10)}` : "no waiver on record";
      }
    } else if (res.status === 404) {
      verdict = "no-waiver";
      detail = "404 — person absent at this center";
    } else {
      // 500 = present but unreadable. Cannot prove a waiver, so cannot settle.
      detail = `HTTP ${res.status}`;
    }
  } catch (e) {
    detail = e instanceof Error ? e.message.slice(0, 60) : "unreachable";
  }

  if (verdict === "valid") {
    settled++;
    console.log(
      `  ✓ SETTLE  sig#${String(r.id).padEnd(5)} ${who.padEnd(34)} ` +
        `${cn(r.location_id).padEnd(20)} age=${r.age_min}m  BMI valid to ${expiry}`,
    );
    if (APPLY) {
      // Matches the consumer's own salvage write exactly: outcome 'salvaged',
      // no waiver_id (we did not create one), settled_at now.
      await sql`
        UPDATE waiver_signatures
        SET outcome = 'salvaged', waiver_id = NULL, settled_at = NOW()
        WHERE id = ${r.id} AND (outcome IS NULL OR outcome = 'queued')
      `;
    }
  } else if (verdict === "no-waiver") {
    owed++;
    console.log(
      `  ✗ STILL OWED  sig#${String(r.id).padEnd(5)} ${who.padEnd(30)} ` +
        `${cn(r.location_id).padEnd(20)} age=${r.age_min}m  ${detail}`,
    );
  } else {
    unknown++;
    console.log(
      `  ? UNKNOWN  sig#${String(r.id).padEnd(5)} ${who.padEnd(33)} ` +
        `${cn(r.location_id).padEnd(20)} age=${r.age_min}m  ${detail} — left alone`,
    );
  }
}

console.log(
  `\n──────────────────────────────────────────────────────────────\n` +
    `  ${APPLY ? "settled" : "would settle"}: ${settled}   still owed: ${owed}   ` +
    `could not tell: ${unknown}\n`,
);
if (owed > 0) {
  console.log(
    `  The ${owed} still-owed signature(s) need an actual push, not a label fix:\n` +
      `    APPLY=1 npx tsx scripts/sync-redrive-0813.mts\n`,
  );
}
if (!APPLY && settled > 0) console.log(`  Re-run with APPLY=1 to write.\n`);
