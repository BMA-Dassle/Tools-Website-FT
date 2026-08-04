/**
 * The one API-side variable the docs implicate and we never sent: `team_member_id`.
 *
 * Square gates unlinked refunds on a per-team-member permission — "issue unlinked
 * refunds", granted in Dashboard → Team. `POST /v2/refunds` accepts an optional
 * `team_member_id`. Every attempt so far omitted it, so Square had no actor to
 * evaluate that permission against. If the gate is the permission rather than the
 * account, naming an authorized team member is exactly what unblocks it — and
 * `INSUFFICIENT_PERMISSIONS_FOR_REFUND` is a documented CreateRefund error, so
 * permissions demonstrably participate in this call's authorization.
 *
 * Steps:
 *   P0  list team members (read-only) — who is owner/admin, who is ACTIVE
 *   P1  unlinked refund → funded gift card, WITH team_member_id = owner
 *   P2  same for the next ACTIVE member, if P1 declines (a second data point
 *       distinguishes "this member lacks it" from "the field changes nothing")
 *   P3  control: identical request with NO team_member_id, same run, same card —
 *       so the comparison is same-session and same-destination, not cross-day
 *
 * Non-accounting location, comp-funded gift card, drained at the end. Net zero.
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-refund-teammember-probe.mts          # dry run
 *   npx tsx scripts/unlinked-refund-teammember-probe.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOCATION = "6MZJFTGAYD7TC";
const SEED = 500;
const CENTS = 400;
const REASON = "Refund: Reservation Deposit";
const KEY = `utmp-${randomUUID().slice(0, 8)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }) =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";

// ── P0: team members (read-only, runs in dry mode too) ──────────────────────
console.log("═══ P0  team members ═══");
const tm = await sq("POST", "/team-members/search", {
  limit: 50,
  query: { filter: { status: "ACTIVE" } },
});
const members = (tm.json?.team_members ?? []) as any[];
if (!tm.ok) console.log(`  search failed: ${errStr(tm)}`);
for (const m of members.slice(0, 15)) {
  console.log(
    `  ${m.id}  ${m.given_name ?? ""} ${m.family_name ?? ""}`.trimEnd() +
      `  owner=${m.is_owner === true}  status=${m.status}  email=${m.email_address ?? "-"}`,
  );
}
const owner = members.find((m) => m.is_owner === true);
const others = members.filter((m) => m.id !== owner?.id);
console.log(
  `\n  ${members.length} ACTIVE member(s); owner = ${owner ? `${owner.id}` : "NOT FOUND"}`,
);

if (!LIVE) {
  console.log("\n=== DRY RUN (pass --live to execute) ===");
  console.log(`Would fund a gift card ${SEED}¢, then attempt unlinked ${CENTS}¢ refunds:`);
  console.log(`  P1  with team_member_id = ${owner?.id ?? "(owner not found)"}`);
  console.log(`  P2  with team_member_id = ${others[0]?.id ?? "(none)"}`);
  console.log("  P3  with NO team_member_id (same-session control)");
  console.log("Then drain the card. Net money movement: zero.");
  process.exit(0);
}

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}\n    ${a}`);
};
let cardId: string | undefined;
const accepted: string[] = [];

try {
  // ── funded, ACTIVE, Square-issued gift card ──────────────────────────────
  const c = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL" },
  });
  if (!c.ok) throw new Error(`create card: ${errStr(c)}`);
  cardId = c.json.gift_card.id as string;
  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-co`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: SEED, currency: "USD" },
        },
      ],
      discounts: [
        { name: "Probe comp", amount_money: { amount: SEED, currency: "USD" }, scope: "ORDER" },
      ],
    },
  });
  if (!co.ok) throw new Error(`comp order: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, {
    idempotency_key: `${KEY}-cp`,
    payment_ids: [],
  });
  const act = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: cardId,
      activate_activity_details: {
        order_id: co.json.order.id,
        line_item_uid: co.json.order.line_items[0].uid,
      },
    },
  });
  if (!act.ok) throw new Error(`activate: ${errStr(act)}`);
  const s0 = await sq("GET", `/gift-cards/${cardId}`);
  console.log(
    `\ndestination: ${cardId} state=${s0.json?.gift_card?.state} ` +
      `balance=${s0.json?.gift_card?.balance_money?.amount}¢`,
  );

  const attempt = async (label: string, tag: string, teamMemberId?: string) => {
    const r = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-${tag}`,
      unlinked: true,
      destination_id: cardId,
      location_id: LOCATION,
      amount_money: { amount: CENTS, currency: "USD" },
      reason: REASON,
      ...(teamMemberId ? { team_member_id: teamMemberId } : {}),
    });
    record(
      label,
      r.ok
        ? `ACCEPTED — refund ${r.json.refund?.id} status=${r.json.refund?.status}`
        : `REFUSED — ${codes(r)} — ${errStr(r)}`,
    );
    if (r.ok) accepted.push(r.json.refund.id);
    return r.ok;
  };

  const p1 = owner
    ? await attempt(`P1  unlinked ${CENTS}¢ WITH team_member_id = owner ${owner.id}`, "p1", owner.id)
    : (record("P1  with owner team_member_id", "SKIPPED — no owner in team list"), false);

  if (!p1 && others[0]) {
    await attempt(
      `P2  same WITH team_member_id = ${others[0].id} (${others[0].given_name ?? "?"})`,
      "p2",
      others[0].id,
    );
  }

  await attempt("P3  CONTROL — same request, NO team_member_id", "p3");

  const anyOk = accepted.length > 0;
  record(
    "VERDICT",
    anyOk
      ? "An unlinked refund was ACCEPTED — `team_member_id` was the missing piece. The permission " +
          "is evaluated against the named actor, and our calls had been sending none."
      : "`team_member_id` changes nothing — every shape still declines. Naming an authorized actor " +
          "is not the gate, so the block is above the request: the account's plan tier or the " +
          "application's authorization. No request-level fix exists.",
  );
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  console.log("\n═══ cleanup ═══");
  if (cardId) {
    let pending = false;
    for (const id of accepted) {
      const g = await sq("GET", `/refunds/${id}`);
      if (!["COMPLETED", "FAILED", "REJECTED"].includes(g.json?.refund?.status ?? "")) pending = true;
    }
    if (pending) {
      console.log(`  LEAVING ${cardId} — a refund to it is still PENDING (never drain in flight).`);
    } else {
      const g = await sq("GET", `/gift-cards/${cardId}`);
      const bal = g.json?.gift_card?.balance_money?.amount ?? 0;
      if (bal > 0) {
        const d = await sq("POST", "/gift-cards/activities", {
          idempotency_key: `${KEY}-drain`,
          gift_card_activity: {
            type: "ADJUST_DECREMENT",
            location_id: LOCATION,
            gift_card_id: cardId,
            adjust_decrement_activity_details: {
              amount_money: { amount: bal, currency: "USD" },
              reason: "PURCHASE_WAS_REFUNDED",
            },
          },
        });
        console.log(`  drain ${bal}¢ → ${d.ok ? "0¢" : errStr(d)}`);
      } else {
        console.log("  card already 0¢");
      }
    }
  }
  console.log("\n═══ FINDINGS ═══");
  for (const f of findings) console.log(`• ${f}`);
}
