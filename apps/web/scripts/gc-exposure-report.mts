/**
 * READ-ONLY exposure report: every game-card load we've recorded, by path and
 * state — the remediation list for the "DC→center sync down" incident
 * (2026-07-20). Loads marked `loaded` were confirmed by the CLOUD (SOAP code 0
 * or kiosk bridge preLoaded); with the center sync broken, cloud-confirmed
 * tokens exist at the Intercard data center but may never have reached the
 * center's transaction server (readers see an empty card).
 *
 * Usage: npx tsx scripts/gc-exposure-report.mts
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// Load DATABASE_URL from .env.local without depending on dotenv.
if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, "");
  } catch {
    /* fall through */
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not found");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const CENTER: Record<number, string> = {
  12: "HeadPinz FM",
  6: "Naples",
  13: "FastTrax FM",
};

const summary = await sql`
  SELECT location_code, kind, state, load_state, COUNT(*) AS n,
         SUM(tokens) AS tokens, SUM(bonus_tokens) AS bonus,
         SUM(amount_cents) AS cents,
         MIN(created_at) AS first, MAX(created_at) AS last
  FROM intercard_transactions
  GROUP BY location_code, kind, state, load_state
  ORDER BY location_code, kind, state, load_state
`;

console.log("=== SUMMARY (all time) ===");
for (const r of summary) {
  console.log(
    `${(CENTER[r.location_code as number] ?? r.location_code).toString().padEnd(12)} ` +
      `${String(r.kind).padEnd(8)} ${String(r.state).padEnd(13)} ${String(r.load_state).padEnd(11)} ` +
      `n=${String(r.n).padStart(3)}  tokens=${String(r.tokens).padStart(6)}+${String(r.bonus).padEnd(5)} ` +
      `$${(Number(r.cents) / 100).toFixed(2).padStart(8)}  ${String(r.first).slice(0, 10)} → ${String(r.last).slice(0, 10)}`,
  );
}

// Money taken (charged or completed) — the rows that matter for guests.
const rows = await sql`
  SELECT txn_id, kind, location_code, account_number, tokens, bonus_tokens,
         amount_cents, state, load_state, queue_state, created_at
  FROM intercard_transactions
  WHERE state IN ('charged', 'completed')
  ORDER BY created_at ASC
`;

console.log(`\n=== CHARGED LOADS (remediation list) — ${rows.length} rows ===`);
for (const r of rows) {
  console.log(
    `${String(r.created_at).slice(0, 19)}  ${(CENTER[r.location_code as number] ?? r.location_code).toString().padEnd(12)} ` +
      `${String(r.kind).padEnd(8)} card=${String(r.account_number).padEnd(10)} ` +
      `${String(r.tokens).padStart(5)}+${String(r.bonus_tokens).padEnd(4)} tok  ` +
      `$${(Number(r.amount_cents) / 100).toFixed(2).padStart(7)}  ${r.state}/${r.load_state}${r.queue_state ? "/" + r.queue_state : ""}`,
  );
}

console.log(
  "\nloaded = cloud confirmed the credit (tokens AT THE DATA CENTER; delivery to the center's floor depends on the sync).",
);
console.log("pending/load_failed = cloud never even confirmed — reconcile cron owns these.");
