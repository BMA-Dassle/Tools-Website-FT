/**
 * Adapter #1 — prepaid deal packs (`deal_purchases`).
 *
 * The projection is a PURE function of a `DealPurchaseRow`, split out from the
 * adapter's I/O so it can be tested exhaustively without a database. That split
 * is not stylistic: vitest here runs in `environment: "node"` with no jsdom, so
 * anything left inside a component or welded to a query is untestable in this
 * repo. Every status arm, every capability refusal, and the gift handling are
 * asserted against fixtures in `deals.test.ts`.
 *
 * ONE THING THIS FILE DELIBERATELY DOES NOT DO: treat `refunded_at` as a refund.
 * On `deal_purchases` that column means "the vouchers were voided" and nothing
 * else — no money has ever moved through this feature. It projects to
 * `RefundState.voided`, which is a different thing from `full`. When real
 * refunds land, they get their own columns and this mapping gets a second arm;
 * conflating them now would make the first real refund indistinguishable from a
 * void in every report built on this board.
 */

import {
  DEAL_LOCATION_INFO,
  dealExpiryFrom,
  dealVoucherSummary,
  dealVoucherItems,
  getDeal,
  type DealLocationKey,
} from "~/features/deals";
import { getDealPurchase, type DealPurchaseRow } from "~/features/deals/data/deal-purchases-db";
import {
  getDealMoneyState,
  getDealMoneyStates,
  markDealVouchersVoided,
  type DealMoneyState,
} from "~/features/deals/data/deal-purchases-money";
import {
  searchDealPurchases,
  summarizeDealPurchases,
} from "~/features/deals/data/deal-purchases-search";
import { packLabel, packLegMap, packUnitKey, PackShapeError } from "~/features/deals/service/pack-legs";
import { dealScheduleUrl, fulfilDealPurchase } from "~/features/deals/service/purchase";
import { getVoucherStatus, voidNativeVoucher } from "~/features/game-cards/service/native-voucher";
import {
  emailPurchasedVouchers,
  smsPurchasedVouchers,
} from "~/features/game-cards/service/voucher-mail";
import { listSaleActions, recordSaleAction } from "../data/web-sales-audit-db";
import { easternRangeToUtc } from "../service/dates";
import type {
  ResendArgs,
  ResendOutcome,
  SaleCapability,
  SaleDetail,
  SaleFact,
  SaleLeg,
  SaleListQuery,
  SaleSummary,
  SaleTimelineEntry,
  SaleTone,
  WebSaleAdapter,
  WebSaleRow,
} from "../types";

/* ────────────────────────────── pure projection ────────────────────────── */

interface StatusView {
  label: string;
  tone: SaleTone;
  problem: string | null;
}

/**
 * Native status → what a human reads, and whether they should act.
 *
 * `problem` is the load-bearing field: it drives the "Needs attention" card and
 * its filter, which is what ops will actually use the board for. It is a
 * sentence, not a code, and it says what happens next so nobody has to ask
 * whether a stuck row is already being retried.
 */
export function dealStatusView(row: DealPurchaseRow): StatusView {
  switch (row.status) {
    case "pending":
      // A card form somebody opened and walked away from. Noise, not work —
      // never charged, so there is nothing to chase.
      return { label: "Not charged", tone: "muted", problem: null };
    case "charge_failed":
      return {
        label: "Declined",
        tone: "danger",
        problem: row.lastError || "The card was declined and nothing was taken.",
      };
    case "charged":
      return {
        label: "Awaiting codes",
        tone: "warn",
        problem: "Paid, but the vouchers were never cut — the reconcile cron retries every 30 min.",
      };
    case "minted":
      return {
        label: "Codes not sent",
        tone: "warn",
        problem: "Vouchers exist but the email never sent — the reconcile cron retries every 30 min.",
      };
    case "scheduled":
      return { label: "Gift scheduled", tone: "pending", problem: null };
    case "sent":
      return { label: "Sent", tone: "ok", problem: null };
    default:
      // A status this build has never heard of is worth surfacing, not hiding:
      // it means the writer shipped ahead of the reader.
      return { label: row.status, tone: "warn", problem: `Unrecognised status "${row.status}".` };
  }
}

/** Ad attribution, in the words the board shows. */
export function dealAttributionLabel(utm: Record<string, string> | null): string {
  if (!utm) return "direct";
  const named = [utm.utm_source, utm.utm_campaign].filter(Boolean).join(" / ");
  if (named) return named;
  return utm.gclid ? "google ads" : "unknown";
}

const PAID_FOR_ACTIONS = new Set(["charged", "minted", "scheduled", "sent"]);

/**
 * What staff may do to this row, and — when they may not — why.
 *
 * Every refusal is expressed as a PRESENT capability with a `blockedReason`, not
 * as an absent one. A button that vanishes is a support ticket; a disabled button
 * that says "never charged — nothing to send" is an answer.
 */
export function dealCapabilities(row: DealPurchaseRow, money?: DealMoneyState | null): SaleCapability[] {
  const paid = PAID_FOR_ACTIONS.has(row.status);
  const voided = isVoided(row, money);

  const resend: SaleCapability = { action: "resend", label: "Resend" };
  if (!paid) resend.blockedReason = "That purchase was never charged — nothing to send.";
  else if (row.codes.length === 0) resend.blockedReason = "No codes minted yet — try again shortly.";

  const refund: SaleCapability = { action: "refund", label: "Refund" };
  if (!paid) refund.blockedReason = "Never charged — there is nothing to refund.";
  else if (voided) refund.blockedReason = "Already voided on this purchase.";
  else if (!row.squarePaymentId)
    refund.blockedReason = "No Square payment recorded — refund this one by hand.";

  const voidCap: SaleCapability = { action: "void", label: "Void" };
  if (!paid) voidCap.blockedReason = "Never charged — there are no live vouchers.";
  else if (voided) voidCap.blockedReason = "Already voided.";
  else if (row.codes.length === 0) voidCap.blockedReason = "No codes minted yet.";

  return [resend, refund, voidCap];
}

/** `Laser Tag + Game Card Pack` sold to somebody else, at a named venue. */
function dealSublabel(row: DealPurchaseRow): string {
  const venue = DEAL_LOCATION_INFO[row.locationKey as DealLocationKey]?.label ?? row.locationKey;
  const parts = [venue];
  if (row.qty > 1) parts.push(row.combine ? `${row.qty} packs combined` : `${row.qty} separate codes`);
  if (row.isGift) parts.push(`gift for ${row.recipientName ?? "a recipient"}`);
  return parts.join(" · ");
}

/**
 * Voided-ness, from whichever column carries it.
 *
 * New voids write `vouchers_voided_at` only; the legacy `refunded_at` is
 * backfilled into it but still present on rows written before that migration and
 * on any writer that has not been updated yet. Reading both is what stops a
 * fresh void from rendering as an ordinary live sale.
 */
function isVoided(row: DealPurchaseRow, money?: DealMoneyState | null): boolean {
  return !!money?.vouchersVoidedAt || row.refundedAt !== null;
}

export function projectDealRow(row: DealPurchaseRow, money?: DealMoneyState | null): WebSaleRow {
  const deal = getDeal(row.dealSlug);
  const info = DEAL_LOCATION_INFO[row.locationKey as DealLocationKey];
  const status = dealStatusView(row);

  return {
    id: `deals:${row.id}`,
    source: "deals",
    ref: String(row.id),
    // `created_at`, matching the adapter's ORDER BY and keyset key exactly — see
    // the note on WebSaleRow.soldAt about why this must not be `charged_at`.
    soldAt: row.createdAt,
    buyer: {
      name: row.buyerName,
      email: row.buyerEmail,
      phone: row.buyerPhone,
      recipientName: row.isGift ? row.recipientName : null,
      recipientEmail: row.isGift ? row.recipientEmail : null,
      recipientPhone: row.isGift ? row.recipientPhone : null,
    },
    product: {
      label: deal?.name ?? row.dealSlug,
      sublabel: dealSublabel(row),
      qty: row.qty,
    },
    money: {
      paidCents: row.totalCents,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
    },
    status: { code: row.status, ...status },
    refund: buildRefundState(row, money),
    attribution: { label: dealAttributionLabel(row.utm), utm: row.utm },
    venue: {
      key: row.locationKey,
      label: info?.label ?? row.locationKey,
      // Deals are HeadPinz-only — FastTrax sells neither laser tag nor gel blasters.
      brand: "headpinz",
    },
    square: {
      orderId: row.squareOrderId,
      paymentIds: row.squarePaymentId ? [row.squarePaymentId] : [],
    },
    searchTerms: [...row.codes, row.voucherBatchId, row.idempotencyKey].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
    capabilities: dealCapabilities(row, money),
  };
}

/**
 * Refund state, keeping a VOID distinct from money coming back.
 *
 * Money is checked first: a purchase can be refunded and then have its leftover
 * vouchers voided, and the refund is the more consequential fact. A void with no
 * refunded cents is exactly what it says — value killed, charge untouched.
 */
function buildRefundState(row: DealPurchaseRow, money?: DealMoneyState | null): WebSaleRow["refund"] {
  if (money && money.refundedCents > 0) {
    return {
      kind: money.fullyRefundedAt ? "full" : "partial",
      refundedCents: money.refundedCents,
      at: money.fullyRefundedAt,
      // The destination lives on the refund ledger, not here — the board shows
      // the amount, and the drawer shows where it went.
      destination: null,
    };
  }
  const voidedAt = money?.vouchersVoidedAt ?? row.refundedAt;
  return voidedAt
    ? { kind: "voided", at: voidedAt, reason: money?.vouchersVoidedReason ?? row.refundReason }
    : { kind: "none" };
}

/* ─────────────────────── detail: legs, timeline, facts ─────────────────── */

/**
 * The purchase's legs, grouped by PACK rather than by code.
 *
 * A combined 3-pack is one code carrying twelve legs; listing twelve flat rows
 * is unreadable and, worse, is not the unit anything acts on — Square can only
 * return whole units of an order line, so a refund is always "2 of 3 packs".
 * Grouping here means the drawer and the refund modal describe the sale the same
 * way.
 */
async function dealLegs(row: DealPurchaseRow): Promise<SaleLeg[]> {
  const deal = getDeal(row.dealSlug);
  if (!deal || row.codes.length === 0) return [];

  let map;
  try {
    map = packLegMap({
      combine: row.combine,
      qty: row.qty,
      codes: row.codes,
      itemsPerPack: deal.items.length,
    });
  } catch (err) {
    // A purchase whose codes disagree with its shape has no defined mapping.
    // Say so in the drawer rather than inventing one.
    if (err instanceof PackShapeError) {
      console.error(`[web-sales] purchase ${row.id} has an unmappable pack shape:`, err.message);
      return [];
    }
    throw err;
  }

  // One status read per distinct code, not per pack — a combined purchase would
  // otherwise hit the same voucher `qty` times.
  const statuses = new Map(
    await Promise.all(
      [...new Set(row.codes)].map(async (code) => [code, await getVoucherStatus(code)] as const),
    ),
  );

  const legs: SaleLeg[] = [];
  for (const { pack, code, legIndexes } of map) {
    const status = statuses.get(code);
    const unitKey = packUnitKey(code, pack);
    const unitLabel =
      row.qty > 1 ? `${packLabel(pack, row.qty)} · ${code}` : packLabel(pack, row.qty);

    legIndexes.forEach((legIndex, slot) => {
      const state = status?.items.find((i) => i.index === legIndex);
      legs.push({
        key: `${code}#${legIndex}`,
        label: state?.label ?? `Item ${slot + 1}`,
        spent: state?.spent ?? false,
        // `voucher_claims` records when a leg was taken; the projection does not
        // carry it, so the drawer shows spent-ness without a timestamp rather
        // than guessing one.
        spentAt: null,
        // Real per-leg pricing arrives with the refund math, where it decides
        // money. Here it only labels, so an honest zero beats a wrong number.
        valueCents: 0,
        unitKey,
        unitLabel,
      });
    });
  }
  return legs;
}

/** Oldest first. Row timestamps, then whatever staff did from the board. */
function dealTimeline(
  row: DealPurchaseRow,
  actions: Awaited<ReturnType<typeof listSaleActions>>,
): SaleTimelineEntry[] {
  const entries: SaleTimelineEntry[] = [];
  const push = (at: string | null, label: string, detail?: string | null, tone?: SaleTone) => {
    if (at) entries.push({ at, label, detail: detail ?? null, tone });
  };

  push(row.createdAt, "Purchase started", null, "muted");
  push(row.chargedAt, "Card charged", row.squarePaymentId, "ok");
  push(row.mintedAt, "Vouchers minted", row.codes.join(", ") || null, "ok");
  push(row.sentAt, row.isGift ? "Buyer receipt sent" : "Codes emailed", row.buyerEmail, "ok");
  push(row.giftSentAt, "Gift delivered to recipient", row.recipientEmail, "ok");
  push(row.refundedAt, "Vouchers voided", row.refundReason, "danger");

  for (const a of actions) {
    const detail = a.detail ?? {};
    const to = [detail.email, detail.phone].filter(Boolean).join(" · ") || null;
    entries.push({
      at: a.createdAt,
      label: `Admin ${a.action}`,
      detail: to,
      tone: a.action === "void" ? "danger" : "pending",
    });
  }

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function dealFacts(row: DealPurchaseRow): SaleFact[] {
  const deal = getDeal(row.dealSlug);
  const facts: SaleFact[] = [];
  const add = (label: string, value: string | null | undefined, opts: Partial<SaleFact> = {}) => {
    if (value) facts.push({ label, value, ...opts });
  };

  add("Square order", row.squareOrderId, {
    mono: true,
    href: row.squareOrderId
      ? `https://squareup.com/dashboard/orders/overview/${row.squareOrderId}`
      : undefined,
  });
  add("Square payment", row.squarePaymentId, { mono: true });
  add("Voucher batch", row.voucherBatchId, { mono: true });
  add("Idempotency key", row.idempotencyKey, { mono: true });
  add("Codes", row.codes.join(", ") || null, { mono: true });
  add(
    "Expires",
    deal ? dealExpiryFrom(new Date(row.createdAt), deal.expiresMonths).slice(0, 10) : null,
  );
  add("Clickwrap", row.clickwrapVersion);
  add("Gift message", row.giftMessage);
  add("Gift scheduled for", row.giftSendAt?.slice(0, 10));
  for (const [k, v] of Object.entries(row.utm ?? {})) add(k, v);
  return facts;
}

/* ──────────────────────────────── resend ───────────────────────────────── */

/**
 * Who a resend goes to by DEFAULT.
 *
 * The recipient on a gift, the buyer otherwise. Sending a gift's codes back to
 * the buyer would hand a bearer instrument to the wrong person — and the buyer
 * already has their own receipt.
 */
export function dealResendDefaults(row: DealPurchaseRow): { email: string | null; phone: string | null } {
  return row.isGift
    ? { email: row.recipientEmail, phone: row.recipientPhone }
    : { email: row.buyerEmail, phone: row.buyerPhone };
}

function dealMailArgs(row: DealPurchaseRow, to: string) {
  const deal = getDeal(row.dealSlug);
  const packsPerCode = row.combine ? row.qty : 1;
  return {
    to,
    name: row.isGift ? row.recipientName : row.buyerName,
    productName: deal?.name ?? row.dealSlug,
    codes: row.codes,
    items: deal ? dealVoucherItems(deal, packsPerCode) : [],
    valueSummary: deal ? dealVoucherSummary(deal, packsPerCode) : undefined,
    expiresAt: deal ? dealExpiryFrom(new Date(row.createdAt), deal.expiresMonths) : null,
    scheduleUrl: deal
      ? absoluteUrl(dealScheduleUrl({ deal, location: row.locationKey, codes: row.codes }))
      : null,
    scheduleLabel: deal
      ? `Pick your ${deal.scheduleSlug === "gel-blaster" ? "gel blaster" : "laser tag"} time`
      : null,
    ...(row.isGift
      ? { gift: { fromName: row.buyerName, message: row.giftMessage } }
      : {}),
  };
}

function absoluteUrl(path: string | null): string | null {
  const origin = (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(/\/$/, "");
  return path ? `${origin}${path}` : null;
}

/**
 * What the resend would actually say.
 *
 * Built by the REAL send functions in preview mode, not by a second builder, so
 * the modal cannot drift from the message.
 */
async function dealResendPreview(
  row: DealPurchaseRow,
  channel: "sms" | "email" | "both",
): Promise<{ subject: string | null; text: string }> {
  const deal = getDeal(row.dealSlug);
  const to = dealResendDefaults(row);

  if (channel === "sms") {
    const sms = await smsPurchasedVouchers({
      phone: to.phone ?? "+10000000000",
      productName: deal?.name ?? row.dealSlug,
      codes: row.codes,
      ...(row.isGift ? { giftFromName: row.buyerName } : {}),
      preview: true,
    });
    return { subject: null, text: sms.text ?? "" };
  }

  const mail = await emailPurchasedVouchers({
    ...dealMailArgs(row, to.email ?? "preview@example.com"),
    preview: true,
  });
  return { subject: mail.subject ?? null, text: mail.text ?? "" };
}

/**
 * Send the codes again, optionally somewhere else.
 *
 * WHEN THERE IS NO OVERRIDE and the purchase is still unfulfilled, this defers
 * to `fulfilDealPurchase` — the same idempotent mint-then-send the reconcile
 * cron runs. That path is fenced on `voucher_batch_id IS NULL`, so it re-sends
 * without cutting new codes, and it is the only thing that can rescue a row that
 * never minted.
 *
 * WITH an override it calls the mail functions directly, because
 * `fulfilDealPurchase` hardcodes the address on the row. Deliberately NOT a loop
 * over a per-code send: that would fire three emails at a buyer who bought three
 * separate packs and expects one.
 */
async function dealResend(row: DealPurchaseRow, args: ResendArgs): Promise<ResendOutcome> {
  const deal = getDeal(row.dealSlug);
  const fallback = dealResendDefaults(row);
  const email = args.overrideEmail ?? fallback.email;
  const phone = args.overridePhone ?? fallback.phone;
  const wantEmail = args.channel === "email" || args.channel === "both";
  const wantSms = args.channel === "sms" || args.channel === "both";
  const redirected = !!args.overrideEmail || !!args.overridePhone;

  await recordSaleAction({
    source: "deals",
    ref: String(row.id),
    action: "resend",
    actor: args.actor,
    detail: { channel: args.channel, email, phone, redirected },
  });

  // Unfulfilled and going to the address on file → let the idempotent fulfilment
  // path handle it, so a row that never minted gets its codes cut too.
  if (!redirected && (row.status === "charged" || row.status === "minted")) {
    const res = await fulfilDealPurchase(row);
    return {
      emailOk: !res.emailPending,
      smsOk: null,
      note: res.mintPending
        ? "Still waiting on codes — the reconcile cron will keep trying."
        : res.emailPending
          ? "Codes exist but the email did not send."
          : "Sent.",
    };
  }

  if (row.codes.length === 0) {
    throw new Error("No codes on this purchase yet — nothing to resend.");
  }

  let emailOk: boolean | null = null;
  let smsOk: boolean | null = null;
  const problems: string[] = [];

  if (wantEmail) {
    if (!email) {
      problems.push("no email address");
      emailOk = false;
    } else {
      const res = await emailPurchasedVouchers({
        ...dealMailArgs(row, email),
        eventReason: "admin-resend",
      });
      emailOk = res.ok;
      if (!res.ok) problems.push(`email failed: ${res.error ?? "unknown"}`);
    }
  }

  if (wantSms) {
    if (!phone) {
      problems.push("no phone number");
      smsOk = false;
    } else {
      const res = await smsPurchasedVouchers({
        phone,
        productName: deal?.name ?? row.dealSlug,
        codes: row.codes,
        ...(row.isGift ? { giftFromName: row.buyerName } : {}),
        eventReason: "admin-resend",
      });
      smsOk = res.ok;
      if (!res.ok) problems.push(`SMS failed: ${res.error ?? "unknown"}`);
    }
  }

  const sent = [emailOk === true ? `email → ${email}` : null, smsOk === true ? `SMS → ${phone}` : null]
    .filter(Boolean)
    .join(" · ");
  return {
    emailOk,
    smsOk,
    note: problems.length > 0 ? `${sent ? `${sent}. ` : ""}${problems.join("; ")}` : `Sent ${sent}.`,
  };
}

/* ───────────────────────────────── void ────────────────────────────────── */

/**
 * Kill the value; leave the money exactly where it is.
 *
 * This is NOT a refund and must never be confused with one. It is for the cases
 * where the guest should not keep the vouchers but the charge stands or is being
 * handled elsewhere — fraud, a code posted publicly, a contested charge we are
 * defending. The money verbs live in their own PRs with their own ledger.
 *
 * Already-redeemed legs stay redeemed. `voidNativeVoucher` only stamps the
 * voucher; it deliberately does not touch `voucher_claims`, because the guest
 * genuinely had that value and rewriting the claim would desync Intercard, which
 * has already dispensed against it.
 *
 * Per-code failures are logged and the loop continues. A partial void followed
 * by a hard abort would leave some codes live and no record of why, which is
 * strictly worse than voiding what we can and recording the rest.
 */
async function dealVoid(
  row: DealPurchaseRow,
  reason: string,
  actor: string,
): Promise<{ voided: number; note: string }> {
  const deal = getDeal(row.dealSlug);
  const failures: string[] = [];
  let voided = 0;

  for (const code of row.codes) {
    try {
      await voidNativeVoucher(code, `admin void: ${reason}`);
      voided += 1;
    } catch (err) {
      failures.push(code);
      console.error(`[web-sales] could not void ${code}:`, err);
    }
  }

  // Persist the void state even when some codes failed — the record of intent
  // matters more than the completeness of the sweep, and the failures are named
  // in the note so staff can finish by hand.
  await markDealVouchersVoided(row.id, reason);
  await recordSaleAction({
    source: "deals",
    ref: String(row.id),
    action: "void",
    actor,
    detail: { reason, voided, failed: failures },
  });

  const name = deal?.name ?? row.dealSlug;
  return {
    voided,
    note:
      failures.length > 0
        ? `Voided ${voided} of ${row.codes.length} codes for ${name}. Failed: ${failures.join(", ")}.`
        : // Say plainly that no money moved. The single-product board's note said
          // the same thing, and it is the sentence that stops a void being
          // mistaken for a refund.
          `Vouchers voided for ${name}. No money moved — refund the card separately if that is what you meant.`,
  };
}

/* ──────────────────────────────── the adapter ──────────────────────────── */

const STATUS_FILTERS = [
  { value: "sent", label: "Sent" },
  { value: "scheduled", label: "Gift scheduled" },
  { value: "minted", label: "Codes not sent" },
  { value: "charged", label: "Awaiting codes" },
  { value: "charge_failed", label: "Declined" },
  { value: "pending", label: "Not charged" },
] as const;

export const dealsAdapter: WebSaleAdapter = {
  id: "deals",
  label: "Deal packs",
  sublabel: "Prepaid voucher bundles sold on headpinz.com/deals",
  statusFilters: STATUS_FILTERS,
  venues: [
    { key: "headpinz", label: DEAL_LOCATION_INFO.headpinz.label, brand: "headpinz" },
    { key: "naples", label: DEAL_LOCATION_INFO.naples.label, brand: "headpinz" },
  ],
  /**
   * Only what this adapter actually implements. `refund` and `void` join the
   * list in the PRs that add their handlers — the shell hides any action absent
   * here even when a row declares the capability, so a half-built verb can never
   * surface a button that does nothing.
   */
  actions: ["resend", "void"],
  resendChannels: ["email", "sms", "both"],

  async list(q: SaleListQuery): Promise<WebSaleRow[]> {
    const { startUtc, endUtc } = easternRangeToUtc(q.from, q.to);
    const rows = await searchDealPurchases({
      startUtc,
      endUtc,
      status: q.status,
      venue: q.venue,
      q: q.q,
      before: q.before,
      limit: q.limit,
    });
    // One batched read for the whole page rather than a query per row.
    const money = await getDealMoneyStates(rows.map((r) => r.id));
    return rows.map((r) => projectDealRow(r, money.get(r.id) ?? null));
  },

  async summarize(q: Omit<SaleListQuery, "before" | "limit">): Promise<SaleSummary> {
    const { startUtc, endUtc } = easternRangeToUtc(q.from, q.to);
    const totals = await summarizeDealPurchases({
      startUtc,
      endUtc,
      status: q.status,
      venue: q.venue,
      q: q.q,
    });

    return {
      grossCents: totals.grossCents,
      // No money has moved through this feature yet — `refunded_at` is a void.
      // Reporting it as refunded dollars would invent a number.
      refundedCents: 0,
      saleCount: totals.saleCount,
      unitCount: totals.packsSold,
      problemCount: totals.problemCount,
      // Per-deal cards, shown only when deals is the sole selected source. This
      // is the rollup the single-product board had, carried across intact.
      extra: totals.byDeal.map((d) => ({
        label: getDeal(d.dealSlug)?.name ?? d.dealSlug,
        value: String(d.packsSold),
        sublabel:
          `packs · $${(d.grossCents / 100).toFixed(2)} gross` +
          (d.unfulfilled > 0 ? ` · ${d.unfulfilled} awaiting codes or email` : ""),
        tone: d.unfulfilled > 0 ? "warn" : "ok",
      })),
    };
  },

  async detail(ref: string): Promise<SaleDetail | null> {
    const row = await getDealPurchase(Number(ref));
    if (!row) return null;
    const [legs, actions, money] = await Promise.all([
      dealLegs(row),
      listSaleActions("deals", ref),
      getDealMoneyState(row.id),
    ]);
    return {
      row: projectDealRow(row, money),
      legs,
      timeline: dealTimeline(row, actions),
      facts: dealFacts(row),
    };
  },

  async previewResend({ ref, channel }) {
    const row = await getDealPurchase(Number(ref));
    if (!row) throw new Error("not_found");
    return dealResendPreview(row, channel);
  },

  async resend(args: ResendArgs): Promise<ResendOutcome> {
    const row = await getDealPurchase(Number(args.ref));
    if (!row) throw new Error("not_found");
    return dealResend(row, args);
  },

  async void({ ref, reason, actor }) {
    const row = await getDealPurchase(Number(ref));
    if (!row) throw new Error("not_found");
    return dealVoid(row, reason, actor);
  },
};
