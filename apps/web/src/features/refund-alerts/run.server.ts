/**
 * Refund policy alerts — orchestrator for the cron.
 *
 * Scans Square for recent refunds, matches them to our reservations by
 * payment id (deposit + day-of), drops every refund our own flows created
 * (see detect.ts), and posts one loud card per run to the call-center Teams
 * chat for the rest.
 *
 * Anti-spam mirrors vip-move-alerts:
 *   1. fire-once Redis NX key per Square refund id,
 *   2. dedup FAILS CLOSED (Redis error -> treat as already sent),
 *   3. a failed Teams send never releases keys,
 *   4. one card per run (all fresh violations combined),
 *   5. daily send-cap valve,
 *   6. REFUND_ALERTS_ENABLED=false kill switch (checked by the route).
 */
import { neon } from "@neondatabase/serverless";
import redis from "@/lib/redis";
import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import {
  DAILY_SEND_CAP,
  DEDUP_TTL_S,
  LOOKBACK_HOURS,
  refundAlertsChatId,
  reservationsBoardUrl,
} from "./config";
import {
  findExternalRefunds,
  type ExternalRefund,
  type RefundLite,
  type ReservationLite,
} from "./detect";
import { buildRefundAlertCard, refundAlertSummaryText } from "./teams-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function sql() {
  return neon(process.env.DATABASE_URL!);
}

/** All Square refunds created in the lookback window, newest page first. */
async function listRecentRefunds(): Promise<RefundLite[]> {
  const begin = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();
  const out: RefundLite[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ begin_time: begin, sort_order: "DESC", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SQUARE_BASE}/refunds?${params}`, { headers: sqHeaders() });
    if (!res.ok) throw new Error(`Square list refunds ${res.status}`);
    const data = await res.json();
    for (const r of (data.refunds ?? []) as Array<Record<string, unknown>>) {
      out.push({
        id: String(r.id),
        paymentId: String(r.payment_id ?? ""),
        status: String(r.status ?? ""),
        amountCents: Number((r.amount_money as { amount?: number })?.amount ?? 0),
        reason: (r.reason as string) ?? null,
        createdAt: String(r.created_at ?? ""),
        teamMemberId: (r.team_member_id as string) ?? null,
      });
    }
    cursor = data.cursor as string | undefined;
    if (!cursor) break;
  }
  return out;
}

/** Our reservations keyed by every payment id they carry (deposit + day-of). */
async function reservationsByPaymentIds(
  paymentIds: string[],
): Promise<Map<string, ReservationLite>> {
  const map = new Map<string, ReservationLite>();
  if (!paymentIds.length || !process.env.DATABASE_URL) return map;
  const q = sql();
  const rows = (await q`
    SELECT id, guest_name, status, product_kind, center_code, total_cents,
           refund_cents, square_refund_id, qamf_reservation_id,
           square_deposit_payment_id, dayof_payment_id
    FROM bowling_reservations
    WHERE square_deposit_payment_id = ANY(${paymentIds})
       OR dayof_payment_id = ANY(${paymentIds})
  `) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const lite: ReservationLite = {
      id: Number(r.id),
      guestName: (r.guest_name as string) ?? null,
      status: String(r.status ?? ""),
      productKind: String(r.product_kind ?? ""),
      centerCode: (r.center_code as string) ?? null,
      totalCents: Number(r.total_cents ?? 0),
      refundCents: Number(r.refund_cents ?? 0),
      squareRefundId: (r.square_refund_id as string) ?? null,
      qamfReservationId: (r.qamf_reservation_id as string) ?? null,
    };
    for (const key of [r.square_deposit_payment_id, r.dayof_payment_id]) {
      if (key) map.set(String(key), lite);
    }
  }
  return map;
}

/** Every refund id the cancel cascade has recorded — cheap 60-day window. */
async function recordedCascadeRefundIds(): Promise<Set<string>> {
  const out = new Set<string>();
  if (!process.env.DATABASE_URL) return out;
  try {
    const q = sql();
    const rows = (await q`
      SELECT refund_ids FROM reservation_cancel_events
      WHERE refund_ids IS NOT NULL AND created_at > NOW() - INTERVAL '60 days'
    `) as Array<{ refund_ids: unknown }>;
    for (const row of rows) {
      let ids: unknown = row.refund_ids;
      if (typeof ids === "string") {
        try {
          ids = JSON.parse(ids);
        } catch {
          ids = [ids];
        }
      }
      if (Array.isArray(ids)) for (const id of ids) out.add(String(id));
    }
  } catch (err) {
    // Table may not exist yet in a fresh env — treat as no recorded ids.
    console.warn("[refund-alerts] cancel-events read failed:", err);
  }
  return out;
}

/** Best-effort "who did it" lookup for Dashboard/POS refunds. */
async function teamMemberNames(entries: ExternalRefund[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(entries.map((e) => e.refund.teamMemberId).filter(Boolean))] as string[];
  for (const id of ids) {
    try {
      const res = await fetch(`${SQUARE_BASE}/team-members/${id}`, { headers: sqHeaders() });
      if (!res.ok) continue;
      const tm = (await res.json()).team_member;
      const name = [tm?.given_name, tm?.family_name].filter(Boolean).join(" ").trim();
      if (name) names.set(id, name);
    } catch {
      /* card falls back to "Square team member" */
    }
  }
  return names;
}

/** Fire-once claim. FAILS CLOSED — on a Redis error we suppress rather than
 *  risk re-yelling every tick until Redis recovers. */
async function claimOnce(key: string): Promise<boolean> {
  try {
    return (await redis.set(key, "1", "EX", DEDUP_TTL_S, "NX")) === "OK";
  } catch (err) {
    console.warn("[refund-alerts] redis dedup failed (suppressing send):", err);
    return false;
  }
}

/** Daily cap valve — also fails closed. */
async function underDailyCap(ymd: string): Promise<boolean> {
  try {
    const key = `refund-alert:sent:${ymd}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, DEDUP_TTL_S);
    if (n > DAILY_SEND_CAP) {
      console.error(`[refund-alerts] daily send cap hit (${n} > ${DAILY_SEND_CAP}) — suppressing`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[refund-alerts] redis cap check failed (suppressing send):", err);
    return false;
  }
}

export interface RunResult {
  refundsScanned: number;
  matchedReservations: number;
  violations: Array<{
    refundId: string;
    reservationId: number;
    guest: string | null;
    amountCents: number;
    reason: string | null;
  }>;
  sent: boolean;
  skippedDedup: number;
  dryRun: boolean;
  errors: string[];
}

export async function runRefundAlerts(opts?: { dryRun?: boolean }): Promise<RunResult> {
  const dryRun = opts?.dryRun ?? false;
  const result: RunResult = {
    refundsScanned: 0,
    matchedReservations: 0,
    violations: [],
    sent: false,
    skippedDedup: 0,
    dryRun,
    errors: [],
  };

  const refunds = await listRecentRefunds();
  result.refundsScanned = refunds.length;
  if (!refunds.length) return result;

  const byPayment = await reservationsByPaymentIds([
    ...new Set(refunds.map((r) => r.paymentId).filter(Boolean)),
  ]);
  result.matchedReservations = byPayment.size;
  if (!byPayment.size) return result;

  const recorded = await recordedCascadeRefundIds();
  const external = findExternalRefunds(refunds, byPayment, recorded);
  result.violations = external.map((e) => ({
    refundId: e.refund.id,
    reservationId: e.reservation.id,
    guest: e.reservation.guestName,
    amountCents: e.refund.amountCents,
    reason: e.refund.reason,
  }));
  if (!external.length || dryRun) return result;

  // Claim every violation's key FIRST, then send one combined card.
  const fresh: ExternalRefund[] = [];
  for (const e of external) {
    if (await claimOnce(`refund-alert:${e.refund.id}`)) fresh.push(e);
    else result.skippedDedup++;
  }
  if (!fresh.length) return result;

  const ymd = new Date().toISOString().slice(0, 10);
  if (!(await underDailyCap(ymd))) return result;

  try {
    const names = await teamMemberNames(fresh);
    await sendAdaptiveCardToChannel(
      refundAlertsChatId(),
      buildRefundAlertCard(fresh, { boardUrl: reservationsBoardUrl(), teamMemberNames: names }),
      { summaryText: refundAlertSummaryText(fresh) },
    );
    result.sent = true;
  } catch (err) {
    // Keys stay claimed on purpose — see the anti-spam contract up top.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[refund-alerts] Teams send failed:", msg);
    result.errors.push(msg);
  }

  return result;
}
