import { NextRequest, NextResponse } from "next/server";
import {
  getQuotesStuckForBmiSettlement,
  markGfSquareSettledComplete,
  appendAuditLog,
  type GfQuoteStatus,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { isDbConfigured } from "@/lib/db";
import { verifyCron } from "@/lib/cron-auth";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * Square-settled auto-close cron.
 *
 * Some group events never finished our flow (stuck at `contract_sent`,
 * `deposit_paid`, or `balance_link_sent`) but the money was actually collected
 * DIRECTLY IN SQUARE — a paid-out Square order whose NAME starts with "BMI…",
 * created outside our contract/deposit/balance rail. This sweep finds those
 * events, verifies the paid Square order, and jumps them to `completed`, booking
 * the money as fully collected (method 'square').
 *
 * Discovery-first: with `?dryRun=1` it makes ZERO writes and reports, per event,
 * every candidate "BMI…" order found at the event's location (id, where the
 * "BMI…" name lives, source, total, amount delta) so a human can confirm the
 * real shape before any live run. The live path completes ONLY a single
 * confident match (state COMPLETED + EXACT-cents total). Ambiguous / amount
 * mismatch / no match are skipped and reported — never guess on a financial record.
 *
 * Unlike `group-dayof-close`, this sets `completed` DIRECTLY and intentionally does
 * NOT gate on `dayof_paid_at`: these events were paid outside our day-of gift-card
 * rail, so there is no gift-card payout to perform first — the pay-before-close
 * hazard (incident 2026-06-05) does not apply here. We never touch
 * `square_dayof_order_id` or load gift cards.
 *
 * Query params (all optional):
 *   ?dryRun=1            — scan + report candidates, no writes
 *   ?statuses=a,b,c      — override candidate statuses (csv)
 *   ?windowDays=60       — event_date within ± N days of now
 *   ?orderWindowDays=45  — Square order created_at within ± N days of event_date
 *   ?limit=100           — max events scanned
 *
 * Kill switch: env GF_SQUARE_SETTLED_KILL (truthy) short-circuits the whole run.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

const truthy = (v: string | undefined) => /^(1|true|on|yes)$/i.test(v || "");

const DAY_MS = 86_400_000;

type Verdict = "confident_single" | "no_match" | "amount_mismatch" | "ambiguous" | "error";

interface SquareOrder {
  id: string;
  state?: string;
  reference_id?: string;
  source?: { name?: string };
  note?: string;
  total_money?: { amount?: number; currency?: string };
  created_at?: string;
  line_items?: Array<{ name?: string }>;
  tenders?: Array<{ note?: string }>;
  metadata?: Record<string, string>;
}

interface BmiCandidate {
  orderId: string;
  matchedField: string;
  matchedValue: string;
  sourceName: string | null;
  referenceId: string | null;
  state: string | null;
  totalCents: number | null;
  currency: string | null;
  createdAt: string | null;
  amountDeltaCents: number | null;
  reconciles: boolean;
}

interface Analysis {
  quote: GroupFunctionQuote;
  candidates: BmiCandidate[];
  verdict: Verdict;
  matchedOrderId: string | null;
  error?: string;
}

/** Case-insensitive "name starts with BMI" test. */
function startsWithBmi(v: unknown): v is string {
  return typeof v === "string" && v.trim().toUpperCase().startsWith("BMI");
}

/**
 * Find where (if anywhere) a "BMI…" name lives on a Square order. Square has no
 * single canonical "name" field, so we check the likely spots in priority order
 * and report which one matched — that is the discovery payload that lets us lock
 * the match rule.
 */
function findBmiMatch(order: SquareOrder): { field: string; value: string } | null {
  const checks: Array<[string, unknown]> = [
    ["reference_id", order.reference_id],
    ["source.name", order.source?.name],
    ["order.note", order.note],
  ];
  for (const li of order.line_items ?? []) checks.push(["line_item.name", li?.name]);
  for (const [k, val] of Object.entries(order.metadata ?? {})) checks.push([`metadata.${k}`, val]);
  for (const t of order.tenders ?? []) checks.push(["tender.note", t?.note]);
  for (const [field, value] of checks) {
    if (startsWithBmi(value)) return { field, value: value.trim() };
  }
  return null;
}

/** SearchOrders: COMPLETED orders at one location within a created_at window (paginated). */
async function searchCompletedOrders(
  locationId: string,
  startAt: string,
  endAt: string,
): Promise<SquareOrder[]> {
  const orders: SquareOrder[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`${SQUARE_BASE}/orders/search`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            state_filter: { states: ["COMPLETED"] },
            date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
        },
        limit: 200,
        return_entries: false,
        ...(cursor ? { cursor } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`SearchOrders failed (${res.status}) for location ${locationId}`);
    }
    const data = await res.json();
    for (const o of (data.orders ?? []) as SquareOrder[]) orders.push(o);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return orders;
}

async function analyzeQuote(quote: GroupFunctionQuote, orderWindowDays: number): Promise<Analysis> {
  try {
    const eventMs = new Date(quote.event_date).getTime();
    const startAt = new Date(eventMs - orderWindowDays * DAY_MS).toISOString();
    const endAt = new Date(eventMs + orderWindowDays * DAY_MS).toISOString();

    const orders = await searchCompletedOrders(quote.square_location_id, startAt, endAt);

    const candidates: BmiCandidate[] = [];
    for (const order of orders) {
      const match = findBmiMatch(order);
      if (!match) continue;
      const amount = order.total_money?.amount ?? null;
      const currency = order.total_money?.currency ?? null;
      const reconciles =
        order.state === "COMPLETED" && currency === "USD" && amount === quote.total_cents;
      candidates.push({
        orderId: order.id,
        matchedField: match.field,
        matchedValue: match.value,
        sourceName: order.source?.name ?? null,
        referenceId: order.reference_id ?? null,
        state: order.state ?? null,
        totalCents: amount,
        currency,
        createdAt: order.created_at ?? null,
        amountDeltaCents: amount === null ? null : amount - quote.total_cents,
        reconciles,
      });
    }

    const reconciling = candidates.filter((c) => c.reconciles);
    let verdict: Verdict;
    let matchedOrderId: string | null = null;
    if (reconciling.length === 1) {
      verdict = "confident_single";
      matchedOrderId = reconciling[0].orderId;
    } else if (reconciling.length >= 2) {
      verdict = "ambiguous";
    } else if (candidates.length === 0) {
      verdict = "no_match";
    } else {
      verdict = "amount_mismatch";
    }

    return { quote, candidates, verdict, matchedOrderId };
  } catch (err) {
    return {
      quote,
      candidates: [],
      verdict: "error",
      matchedOrderId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /duplicate key|unique constraint/i.test(e?.message || "");
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }
  if (truthy(process.env.GF_SQUARE_SETTLED_KILL)) {
    return NextResponse.json({ ok: true, skipped: "GF_SQUARE_SETTLED_KILL" });
  }

  const params = req.nextUrl.searchParams;
  const dryRun = params.get("dryRun") === "1";
  const statusesParam = (params.get("statuses") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as GfQuoteStatus[];
  const statuses = statusesParam.length > 0 ? statusesParam : undefined;
  const windowDays = Math.min(Math.max(Number(params.get("windowDays")) || 60, 1), 730);
  const orderWindowDays = Math.min(Math.max(Number(params.get("orderWindowDays")) || 45, 1), 365);
  const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 500);

  let quotes: GroupFunctionQuote[];
  try {
    quotes = await getQuotesStuckForBmiSettlement({ statuses, windowDays, limit });
  } catch (err) {
    console.error("[group-square-settled-close] DB query failed:", err);
    return NextResponse.json({ ok: false, error: "DB query failed" }, { status: 500 });
  }

  const analyzed = await Promise.all(quotes.map((q) => analyzeQuote(q, orderWindowDays)));

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      window: { statuses: statuses ?? "default", windowDays, orderWindowDays, limit },
      scanned: quotes.length,
      events: analyzed.map((a) => ({
        quoteId: a.quote.id,
        status: a.quote.status,
        bmiReservationId: a.quote.bmi_reservation_id,
        eventName: a.quote.event_name,
        eventNumber: a.quote.event_number,
        eventDate: a.quote.event_date,
        guestName: `${a.quote.guest_first_name} ${a.quote.guest_last_name}`.trim(),
        locationId: a.quote.square_location_id,
        totalCents: a.quote.total_cents,
        collectedCents: a.quote.collected_cents,
        balanceCents: a.quote.balance_cents,
        isWinback: a.quote.is_winback,
        verdict: a.verdict,
        ...(a.error ? { error: a.error } : {}),
        bmiCandidates: a.candidates,
      })),
    });
  }

  // ── Live ────────────────────────────────────────────────────────────
  const summary = {
    scanned: quotes.length,
    completed: 0,
    skipped: {
      no_match: 0,
      amount_mismatch: 0,
      ambiguous: 0,
      already_completed: 0,
      order_already_used: 0,
    } as Record<string, number>,
    errors: 0,
    completedQuoteIds: [] as number[],
  };

  for (const a of analyzed) {
    if (a.verdict === "error") {
      summary.errors++;
      console.error(`[group-square-settled-close] analyze error quote=${a.quote.id}: ${a.error}`);
      continue;
    }
    if (a.verdict !== "confident_single" || !a.matchedOrderId) {
      summary.skipped[a.verdict]++;
      continue;
    }

    try {
      const applied = await markGfSquareSettledComplete(a.quote.id, {
        squareSettledOrderId: a.matchedOrderId,
      });
      if (applied === 0) {
        summary.skipped.already_completed++;
        continue;
      }
      summary.completed++;
      summary.completedQuoteIds.push(a.quote.id);
      console.log(
        `[group-square-settled-close] completed quote=${a.quote.id} ` +
          `event="${a.quote.event_name}" squareOrder=${a.matchedOrderId} total=${a.quote.total_cents}`,
      );

      // Best-effort side effects (each isolated — none blocks the close).
      try {
        await appendAuditLog({
          quoteId: a.quote.id,
          event: "square_settled_completed",
          metadata: {
            orderId: a.matchedOrderId,
            matchedField: a.candidates.find((c) => c.orderId === a.matchedOrderId)?.matchedField,
            matchedValue: a.candidates.find((c) => c.orderId === a.matchedOrderId)?.matchedValue,
            totalCents: a.quote.total_cents,
            locationId: a.quote.square_location_id,
            priorStatus: a.quote.status,
          },
        });
      } catch (err) {
        console.error(`[group-square-settled-close] audit log failed quote=${a.quote.id}:`, err);
      }

      try {
        const { appendProjectPrivateNote, noteTimestamp } =
          await import("@/lib/bmi-office-actions");
        await appendProjectPrivateNote({
          centerCode: a.quote.center_code,
          projectId: a.quote.bmi_reservation_id,
          note: `[${noteTimestamp()}] Event closed — paid via Square order ${a.matchedOrderId}`,
        });
      } catch (err) {
        console.error(`[group-square-settled-close] BMI note failed quote=${a.quote.id}:`, err);
      }

      firePortalWebhookAsync("payment.balance_charged", {
        documentId: a.quote.contract_short_id,
        bmiCode: a.quote.bmi_reservation_id,
        venue: a.quote.center_code,
        status: "completed",
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        summary.skipped.order_already_used++;
        console.warn(
          `[group-square-settled-close] order ${a.matchedOrderId} already attributed — quote=${a.quote.id} skipped`,
        );
      } else {
        summary.errors++;
        console.error(`[group-square-settled-close] complete failed quote=${a.quote.id}:`, err);
      }
    }
  }

  console.log(
    `[group-square-settled-close] scanned=${summary.scanned} completed=${summary.completed} ` +
      `skipped=${JSON.stringify(summary.skipped)} errors=${summary.errors}`,
  );

  return NextResponse.json({ ok: true, dryRun: false, ...summary });
}
