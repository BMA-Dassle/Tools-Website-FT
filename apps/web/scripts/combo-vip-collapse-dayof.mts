/**
 * Collapse Ultimate VIP combo day-of orders to ONE "Ultimate VIP Experience"
 * line per center, on the new dedicated catalog items + the new split:
 *   FastTrax FM (racing)  → VIP_EXPERIENCE_RACING  $44 wd / $49 we
 *   HeadPinz FM (bowling) → VIP_EXPERIENCE_BOWLING $21 wd / $26 we
 * (Tuesday = Mega = weekday.) Replaces the old itemized 6-line split. License/
 * POV/shoes fold into the two amounts. The COMBINED per-combo total is unchanged
 * ($65 wd / $75 we pp), so the shared gift card still covers both legs; only the
 * per-center split moves (weekday: ±$0.01pp) and the line presentation collapses.
 *
 * Only edits OPEN, undiscounted orders. DRY RUN by default; pass --live to apply.
 * Targets ALL FUTURE event dates strictly AFTER the cutoff (default 2026-06-23, so
 * today + past are skipped). Tier (weekday/weekend) is computed per booking from its
 * own event date. Pass YYYY-MM-DD to override the cutoff.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const LIVE = process.argv.includes("--live");
// Only events STRICTLY AFTER this date (default skips today 2026-06-23 + past).
const CUTOFF = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? "2026-06-23";
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const SQB = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const { sql } = await import("@/lib/db");
const q = sql();

const FT_LOC = "LAB52GY480CJF"; // FastTrax FM
const HP_LOC = "TXBSQN0FEKQ11"; // HeadPinz FM
const VIP_RACING = "XH7LTCURLERNTQ34A6GCOOJB";
const VIP_BOWLING = "LS7F7HYTFMQTWIHZHHOHKSPO";

// dow → weekend? (Tuesday=Mega counts as weekday). Fri/Sat/Sun = weekend.
function isWeekend(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 5 || dow === 6;
}
// Per-event-date tier → split (Tue=Mega=weekday; Fri/Sat/Sun=weekend).
const newFt = (ymd: string) => (isWeekend(ymd) ? 4900 : 4400);
const newHp = (ymd: string) => (isWeekend(ymd) ? 2600 : 2100);
const perPerson = (ymd: string) => (isWeekend(ymd) ? 7500 : 6500); // combined, for N + safety

// A combo line on a day-of order. Square shows the CATALOG ITEM name (the passed
// `name` is ignored when catalog_object_id is set), so match the real item names
// seen in prod — "Ultimate Qualifier" (races), "ViewPoint Cameras" (POV),
// "FastTrax License", "VIP Experience" (VIP lane), "Shoe Rental Web" — plus the
// legacy "VIP Exp - " prefix and the revenue-split labels, for safety.
const COMBO_LINE =
  /Ultimate Qualifier|Ultimate VIP Experience|VIP Experience|ViewPoint Cameras|FastTrax License|Starter Race|Intermediate Race|POV|VIP Bowling|Shoe Rental|Shoes|^VIP Exp -/i;

type Row = {
  oid: string;
  dep: string | null;
  product_kind: string;
  booked_at: string | Date | null;
  guest_name: string | null;
  gan: string | null;
};
const rows = (await q`
  SELECT square_dayof_order_id AS oid, square_deposit_order_id AS dep, product_kind,
         booked_at, guest_name, square_gift_card_gan AS gan
  FROM bowling_reservations
  WHERE combo_special_id = 'race-bowl' AND square_dayof_order_id IS NOT NULL
`) as Row[];

// Group the two legs of each combo by the shared deposit order (gift card fallback).
const byCombo = new Map<string, Row[]>();
for (const r of rows) {
  const k = String(r.dep ?? r.gan ?? r.oid);
  if (!byCombo.has(k)) byCombo.set(k, []);
  byCombo.get(k)!.push(r);
}

const etDate = (v: string | Date | null): string | null => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
};
const etTime = (v: string | Date | null): string =>
  v
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(v))
    : "—";

const getOrder = async (oid: string) =>
  (await (await fetch(`${SQB}/orders/${oid}`, { headers: H })).json()).order;

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

console.log(
  `\n${LIVE ? "=== LIVE COLLAPSE ===" : "=== DRY RUN (pass --live to apply) ==="}  FUTURE events after ${CUTOFF}\n`,
);

let targeted = 0;
let applied = 0;
for (const [, legs] of byCombo) {
  const openLeg = legs.find((l) => l.product_kind === "open") ?? legs[0];
  const ev = etDate(openLeg.booked_at);
  if (!ev || ev <= CUTOFF) continue; // future events only (skip today + past)
  targeted++;
  const weekend = isWeekend(ev);
  const NEW_FT = newFt(ev);
  const NEW_HP = newHp(ev);
  const PER_PERSON = perPerson(ev);
  const guest = String(legs[0].guest_name ?? "?").slice(0, 18);

  // Fetch both Square orders (dedupe oids — the two legs carry the two orders).
  const oids = [...new Set(legs.map((l) => l.oid))];
  const orders = await Promise.all(
    oids.map(async (oid) => ({ oid, o: await getOrder(oid) })),
  );

  console.log(
    `── ${guest.padEnd(18)}  ${ev} ${weekend ? "(wknd $75)" : "(wkdy $65)"}  lane ${etTime(openLeg.booked_at)}  (${oids.length} order/s)`,
  );

  // Safety: derive headcount N from the COMBINED combo-line pretax across both
  // orders / the per-person price, so it's robust to any prior line split.
  let combinedComboCents = 0;
  const plans: Array<{
    oid: string;
    o: any;
    entity: "ft" | "hp";
    clearUids: string[];
    keep: any[];
    comboCents: number;
    hasDiscount: boolean;
  }> = [];
  for (const { oid, o } of orders) {
    if (!o) {
      console.log(`   ‼ ${oid.slice(0, 8)} — order not found`);
      continue;
    }
    const entity = o.location_id === HP_LOC ? "hp" : o.location_id === FT_LOC ? "ft" : "?";
    const items = (o.line_items ?? []) as any[];
    const comboItems = items.filter((li) => COMBO_LINE.test(li.name ?? ""));
    const keep = items.filter((li) => !COMBO_LINE.test(li.name ?? ""));
    const comboCents = comboItems.reduce(
      (s, li) => s + (li.base_price_money?.amount ?? 0) * Number(li.quantity ?? 1),
      0,
    );
    combinedComboCents += comboCents;
    console.log(
      `   ${entity.toUpperCase()} ${oid.slice(0, 8)} [${o.state}] total ${money(o.total_money?.amount ?? 0)}` +
        `  lines: ${items.map((i) => `${i.name}×${i.quantity}`).join(", ")}`,
    );
    if (entity === "?") console.log(`   ‼ unknown location ${o.location_id} — skipping this combo`);
    const hasDiscount =
      (o.discounts?.length ?? 0) > 0 || (o.net_amounts?.discount_money?.amount ?? 0) > 0;
    if (hasDiscount)
      console.log(`     ↳ has discount/loyalty reward (${money(o.net_amounts?.discount_money?.amount ?? 0)}) — NOT eligible for auto-collapse`);
    plans.push({ oid, o, entity: entity as "ft" | "hp", clearUids: comboItems.map((li) => li.uid), keep, comboCents, hasDiscount });
  }

  const N = Math.round(combinedComboCents / PER_PERSON);
  const exact = combinedComboCents / PER_PERSON;
  if (N < 1 || Math.abs(exact - N) > 0.02) {
    console.log(`   ‼ headcount didn't reconcile (combo pretax ${money(combinedComboCents)} / ${money(PER_PERSON)} = ${exact.toFixed(3)}) — SKIP`);
    continue;
  }
  const known = plans.every((p) => p.entity === "ft" || p.entity === "hp");
  console.log(
    `   → headcount ${N}; NEW: FastTrax ${money(NEW_FT)}×${N} + HeadPinz ${money(NEW_HP)}×${N} = ${money((NEW_FT + NEW_HP) * N)} (was ${money(combinedComboCents)})`,
  );
  if (!known) {
    console.log(`   ‼ a leg has an unknown location — SKIP (manual review)`);
    continue;
  }
  // Eligible = OPEN and undiscounted. A settled (COMPLETED) leg already drew its
  // share from the gift card; a discounted leg carries a loyalty reward whose
  // line-level distribution we won't disturb. Report both, edit neither.
  const openPlans = plans.filter((p) => p.o?.state === "OPEN" && !p.hasDiscount);
  for (const p of plans.filter((p) => p.o?.state !== "OPEN")) {
    console.log(`   • ${p.entity.toUpperCase()} ${p.oid.slice(0, 8)} is ${p.o?.state} — left as-is (settled, can't edit)`);
  }
  for (const p of plans.filter((p) => p.o?.state === "OPEN" && p.hasDiscount)) {
    console.log(`   • ${p.entity.toUpperCase()} ${p.oid.slice(0, 8)} OPEN but DISCOUNTED — left as-is (loyalty reward; manual)`);
  }
  if (openPlans.length === 0) {
    console.log(`   • no eligible (OPEN + undiscounted) legs — nothing to do`);
    continue;
  }

  if (!LIVE) continue;

  // Clear the old combo lines + add ONE collapsed line on an order.
  const applyOne = async (p: (typeof openPlans)[number]): Promise<boolean> => {
    const unit = p.entity === "ft" ? NEW_FT : NEW_HP;
    const catalog = p.entity === "ft" ? VIP_RACING : VIP_BOWLING;
    const body = {
      idempotency_key: `vipcollapse-${p.oid.slice(-12)}`,
      order: {
        version: p.o.version,
        line_items: [
          {
            catalog_object_id: catalog,
            quantity: String(N),
            base_price_money: { amount: unit, currency: "USD" },
          },
        ],
      },
      ...(p.clearUids.length
        ? { fields_to_clear: p.clearUids.map((u) => `line_items[${u}]`) }
        : {}),
    };
    const res = await fetch(`${SQB}/orders/${p.oid}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok || d.errors) {
      console.log(`   ‼ ${p.entity.toUpperCase()} ${p.oid.slice(0, 8)} FAILED: ${JSON.stringify(d.errors ?? d)}`);
      return false;
    }
    applied++;
    console.log(
      `   ✓ ${p.entity.toUpperCase()} ${p.oid.slice(0, 8)} → ${(d.order?.line_items ?? []).map((i: any) => `${i.name}×${i.quantity}`).join(", ")} | total ${money(d.order?.total_money?.amount ?? 0)}`,
    );
    return true;
  };

  // Partial-failure safety: apply the DECREASING leg (HeadPinz: wd −$0.01pp,
  // we −$5pp) FIRST, and raise FastTrax ONLY if HeadPinz updated — so the
  // combined can never exceed the funded gift card. Never raise FastTrax alone.
  const hpPlan = openPlans.find((p) => p.entity === "hp");
  const ftPlan = openPlans.find((p) => p.entity === "ft");
  const hpOk = hpPlan ? await applyOne(hpPlan) : false;
  if (ftPlan) {
    if (hpPlan && hpOk) await applyOne(ftPlan);
    else
      console.log(
        `   • FT ${ftPlan.oid.slice(0, 8)} SKIPPED — won't raise FastTrax without its HeadPinz leg also updating (gift-card safety)`,
      );
  }
}

console.log(`\n${LIVE ? `=== DONE — ${applied} order(s) updated across ${targeted} future combo(s) ===` : `=== DRY RUN COMPLETE — ${targeted} future combo(s) after ${CUTOFF} ===`}`);
process.exit(0);
