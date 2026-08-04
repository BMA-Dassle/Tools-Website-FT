/**
 * READ-ONLY: list Square disputes (chargebacks) across ALL locations.
 *
 * ListDisputes is filtered per-location; omitting location_id does not reliably
 * return every location (same gotcha as GET /v2/payments), so we iterate
 * /v2/locations and merge + dedupe by dispute id.
 *
 * Usage: npx tsx scripts/square-disputes-open.mts [--all]
 *   default: only OPEN disputes (action still possible/pending)
 *   --all:   include closed outcomes (WON / LOST / ACCEPTED / INQUIRY_CLOSED)
 */
import { readFileSync } from "node:fs";

if (!process.env.SQUARE_ACCESS_TOKEN) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^SQUARE_ACCESS_TOKEN=(.+)$/m);
  if (m) process.env.SQUARE_ACCESS_TOKEN = m[1].trim().replace(/^"|"$/g, "");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) throw new Error("SQUARE_ACCESS_TOKEN not found (env or apps/web/.env.local)");

const BASE = "https://connect.squareup.com/v2";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};

/** States where the dispute is still live and may need us to act. */
const OPEN_STATES = new Set([
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
]);

type Dispute = {
  id?: string;
  dispute_id?: string;
  state?: string;
  reason?: string;
  amount_money?: { amount?: number; currency?: string };
  due_at?: string;
  created_at?: string;
  updated_at?: string;
  card_brand?: string;
  brand_dispute_id?: string;
  location_id?: string;
  evidence_ids?: string[];
  disputed_payment?: { payment_id?: string };
};

async function sq(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body;
}

// 1. every location on the merchant account
const locations: { id: string; name?: string; status?: string }[] =
  (await sq("/locations")).locations ?? [];
console.log(`Locations: ${locations.length}`);

// 2. disputes per location (+ an unscoped pass), merged by id
const byId = new Map<string, Dispute>();
const scopes = [null, ...locations.map((l) => l.id)];

for (const loc of scopes) {
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams();
    if (loc) qs.set("location_id", loc);
    if (cursor) qs.set("cursor", cursor);
    const page = await sq(`/disputes${qs.toString() ? `?${qs}` : ""}`);
    for (const d of (page.disputes ?? []) as Dispute[]) {
      const id = d.id ?? d.dispute_id;
      if (id) byId.set(id, d);
    }
    cursor = page.cursor;
  } while (cursor);
}

const locName = new Map(locations.map((l) => [l.id, l.name ?? l.id]));
const all = [...byId.values()].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
const wantAll = process.argv.includes("--all");
const shown = wantAll ? all : all.filter((d) => OPEN_STATES.has(d.state ?? ""));

const usd = (m?: { amount?: number }) => `$${((m?.amount ?? 0) / 100).toFixed(2)}`;
const now = Date.now();

// ListDisputes does NOT populate evidence_ids (it comes back empty even for
// disputes we have fully submitted). Ask the evidence endpoint for the truth.
const evidence = new Map<string, string[]>();
for (const d of shown) {
  const id = d.id ?? d.dispute_id;
  if (!id) continue;
  const body = await sq(`/disputes/${id}/evidence`);
  evidence.set(id, ((body.evidence ?? []) as { evidence_type?: string }[]).map((e) => e.evidence_type ?? "?"));
}

console.log(`\nDisputes total: ${all.length}   open: ${all.filter((d) => OPEN_STATES.has(d.state ?? "")).length}`);
console.log(`Showing: ${shown.length}${wantAll ? " (all states)" : " (open only)"}\n`);

for (const d of shown) {
  const id = d.id ?? d.dispute_id;
  const due = d.due_at ? new Date(d.due_at) : null;
  const days = due ? Math.round((due.getTime() - now) / 86_400_000) : null;
  console.log(`── ${id}  [${d.state}]`);
  console.log(`   ${usd(d.amount_money)} ${d.amount_money?.currency ?? ""}   reason: ${d.reason}   ${d.card_brand ?? ""}`);
  console.log(`   location: ${locName.get(d.location_id ?? "") ?? d.location_id}`);
  console.log(`   payment:  ${d.disputed_payment?.payment_id ?? "—"}`);
  console.log(`   created:  ${d.created_at ?? "—"}   updated: ${d.updated_at ?? "—"}`);
  if (due) console.log(`   DUE:      ${d.due_at}  (${days} days${days !== null && days < 0 ? " — PAST DUE" : ""})`);
  const ev = evidence.get(id ?? "") ?? [];
  console.log(`   evidence: ${ev.length} item(s)${ev.length ? ` — ${ev.join(", ")}` : "  ** NOTHING SUBMITTED **"}`);
  console.log(`   brand ref: ${d.brand_dispute_id ?? "—"}`);
  console.log("");
}

// state tally across everything we pulled
const tally: Record<string, number> = {};
for (const d of all) tally[d.state ?? "?"] = (tally[d.state ?? "?"] ?? 0) + 1;
console.log("State tally (all disputes ever):", JSON.stringify(tally));
