import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { parseWithRawIds } from "@ft/db";
import {
  getRaceReservationsAwaitingDayofPay,
  getAttractionReservationsAwaitingDayofPay,
  getBowlingReservationByBillId,
  updateBowlingReservationLaneOpen,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/race-dayof-pay
 *
 * BMI has no check-in webhook (unlike QAMF/bowling), so we POLL. This cron
 * settles BMI-side day-of orders from the gift card funded at booking — the same
 * gift-card → day-of-order charge bowling does in processLaneOpen /
 * group-dayof-pay, but triggered by polling BMI state instead of a vendor webhook.
 *
 * Covers two reservation kinds:
 *   - RACE (always).
 *   - STANDALONE ATTRACTION — an attraction reservation with NO bowling/KBF
 *     sharing its day-of order (when bowling IS present, lane-open settles the
 *     combined order, so we leave it alone). See getAttractionReservationsAwaitingDayofPay.
 *
 * Per center:
 *   1. Scan the SMS-Timing Office dayplanner for projects at state -5 (Arrived).
 *   2. Match to our confirmed, unpaid race/attraction reservations (by W-number).
 *   3. Charge the gift card against the open day-of order, COMPLETE it, and
 *      stamp dayof_order_sent_at (idempotency guard — never double-charges).
 *
 * ?dryRun=1 — report what WOULD be charged, no Square writes.
 *
 * Mirrors bmi-cancel-sweep (Office dayplanner scan) + group-dayof-pay (charge).
 * Registered in vercel.json (every 2 min).
 *
 * ⚠️ TEMPORARY FALLBACK (remove once -5 check-in detection is proven reliable):
 * if a race's START TIME has passed and we STILL haven't seen an Arrived (-5)
 * state — including when the dayplanner scan itself fails — we settle the day-of
 * order anyway. The gift card was already funded at booking, so this only moves
 * already-captured funds onto the open order; it guards against a missed/failed
 * check-in scan leaving a raced reservation unpaid. Search "FALLBACK" to delete.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";
const ARRIVED_STATE = "-5";

/**
 * Office tenants to scan, and the centerCode → office clientKey map (mirrors
 * CLIENT_KEYS in lib/bmi-office-actions.ts). RACING is FastTrax Fort Myers but
 * shares the `headpinzftmyers` SMS-Timing tenant with HeadPinz FM bowling — its
 * distinct FastTrax location (LAB52GY480CJF) lives on the Square day-of ORDER
 * (resolveLocationId → FASTTRAX_FM at booking), which is where we charge. So the
 * dayplanner scan tenant is shared; the location attribution rides on the order.
 */
const OFFICE_CLIENT_KEY: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};
const CENTERS = [{ clientKey: "headpinzftmyers" }, { clientKey: "headpinznaples" }] as const;

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

// ── SMS-Timing Office API ───────────────────────────────────────────────────

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
      },
    );
    r.on("error", reject);
    r.setTimeout(20_000, () => {
      r.destroy();
      reject(new Error("Office API timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

async function getOfficeToken(clientKey: string): Promise<string> {
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
  if (res.status !== 200) throw new Error(`Office auth ${res.status}`);
  return JSON.parse(res.body).access_token;
}

interface DpProject {
  id: string;
  number: string;
  stateId: string;
  date: string;
}

/** Reservation numbers vary on the W prefix across systems — compare normalized. */
function normalizeNum(n: string | null | undefined): string {
  return String(n ?? "")
    .replace(/^W/i, "")
    .trim();
}

/**
 * Earliest activity START (epoch ms) for the time-passed fallback. The
 * reservation's `booked_at` is the BOOKING time (not the activity time), so we
 * read the real start from booking_metadata: race HEATS (`heatId`) or attraction
 * SLOTS (`slot`). Both are ET wall-clock with NO offset (e.g.
 * "2026-06-09T16:24:00"), so apply the ET offset (DST-approx by month) before
 * comparing to now. Returns null when no start time is recorded — the caller
 * must NOT fall back without one (e.g. legacy attraction rows with empty metadata).
 */
function bmiStartEpoch(r: BowlingReservation): number | null {
  const md = r.bookingMetadata as
    | { heats?: Array<{ heatId?: string }>; attractions?: Array<{ slot?: string }> }
    | null
    | undefined;
  const times: string[] = [];
  if (Array.isArray(md?.heats))
    for (const h of md.heats) if (typeof h?.heatId === "string") times.push(h.heatId);
  if (Array.isArray(md?.attractions))
    for (const a of md.attractions) if (typeof a?.slot === "string") times.push(a.slot);
  if (times.length === 0) return null;
  let earliest = Infinity;
  for (const t of times) {
    const month = Number(t.slice(5, 7));
    const offset = month >= 3 && month <= 11 ? "-04:00" : "-05:00"; // EDT vs EST (approx)
    const ms = Date.parse(t.replace(/Z$/, "") + offset);
    if (Number.isFinite(ms) && ms < earliest) earliest = ms;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

/** Fetch the dayplanner for a center and return the set of Arrived (-5) project
 *  numbers (normalized). */
async function arrivedNumbers(clientKey: string): Promise<Set<string>> {
  const token = await getOfficeToken(clientKey);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `race-dayof-${clientKey}`,
    clientkey: clientKey,
  };

  const metaRes = await officeReq("GET", `/api/${clientKey}/metadata`, headers);
  if (metaRes.status >= 400) throw new Error(`metadata ${metaRes.status}`);
  const meta = JSON.parse(metaRes.body);
  const ids = new Set<string>();
  for (const r of (meta.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (meta.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");

  const today = new Date().toISOString().slice(0, 10);
  const till = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dpRes = await officeReq(
    "GET",
    `/api/${clientKey}/dayPlanner?${resourceParam}&from=${today}&till=${till}&showAll=true`,
    headers,
  );
  if (dpRes.status >= 400) throw new Error(`dayplanner ${dpRes.status}`);

  // Lossless parse — project numbers/ids can be 17-digit.
  const dp = parseWithRawIds<{ reservations?: { projects?: DpProject[] } }>(dpRes.body);
  const projects = dp.reservations?.projects || [];
  const arrived = new Set<string>();
  for (const p of projects) {
    if (String(p.stateId) === ARRIVED_STATE) arrived.add(normalizeNum(p.number));
  }
  return arrived;
}

// ── Square: charge the gift card against the open day-of order ──────────────
// (single gift card per race; mirrors group-dayof-pay payDayofOrder)

async function chargeDayof(
  r: BowlingReservation,
): Promise<{ paid: boolean; paymentId?: string; note: string }> {
  const orderId = r.squareDayofOrderId!;

  const orderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
  if (!orderRes.ok) return { paid: false, note: `order fetch ${orderRes.status}` };
  const order = (await orderRes.json()).order;
  if (!order) return { paid: false, note: "order not found" };
  const locationId: string = order.location_id;

  if (order.state === "COMPLETED") return { paid: true, note: "order already COMPLETED" };
  let remaining: number = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
  if (remaining <= 0) {
    // $0-model race/attraction: nothing owed (paid in full at booking, often no
    // gift card). COMPLETE the open order so it stops showing "Pending" — this
    // is the gap that left $0 races stuck until a manual sweep. No charge.
    try {
      const version = order.version;
      if (version) {
        await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
          method: "PUT",
          headers: sqHeaders(),
          body: JSON.stringify({ order: { location_id: locationId, version, state: "COMPLETED" } }),
        });
      }
    } catch {
      /* non-fatal — order is already $0, harmless if it stays open */
    }
    return { paid: true, note: "order $0 — completed" };
  }

  // Balance due → needs the funded gift card. $0-model rows reach here only if
  // their order unexpectedly has a balance with no card to cover it; skip safely.
  const gcId = r.squareGiftCardId;
  if (!gcId) return { paid: false, note: "balance due but no gift card" };
  const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${gcId}`, { headers: sqHeaders() });
  if (!gcRes.ok) return { paid: false, note: `gift card fetch ${gcRes.status}` };
  const gcBalance: number = (await gcRes.json()).gift_card?.balance_money?.amount ?? 0;
  if (gcBalance <= 0) return { paid: false, note: "gift card $0 balance" };

  const amountToPay = Math.min(gcBalance, remaining);
  const payRes = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `race-dayof-pay-${r.id}`,
      source_id: gcId, // gift-card ID (gftc:…), NOT the GAN
      amount_money: { amount: amountToPay, currency: "USD" },
      order_id: orderId,
      location_id: locationId,
      autocomplete: true,
      note: `v2 ${r.productKind} day-of (${r.bmiReservationNumber ?? r.id})`,
    }),
  });
  if (!payRes.ok) {
    const e = await payRes.json().catch(() => ({}));
    return { paid: false, note: `payment failed: ${e.errors?.[0]?.detail || payRes.status}` };
  }
  const payData = await payRes.json();
  const paymentId: string | undefined = payData.payment?.id;
  const paidAmount: number = payData.payment?.amount_money?.amount ?? amountToPay;
  remaining -= paidAmount;

  // Complete the order once fully paid (no staff interaction for the $0 model).
  if (remaining <= 0) {
    try {
      const freshRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
      if (freshRes.ok) {
        const version = (await freshRes.json()).order?.version;
        if (version) {
          await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
            method: "PUT",
            headers: sqHeaders(),
            body: JSON.stringify({
              order: { location_id: locationId, version, state: "COMPLETED" },
            }),
          });
        }
      }
    } catch {
      /* non-fatal — payment captured; order stays open, harmless */
    }
  }

  return {
    paid: true,
    paymentId,
    note: `charged $${(paidAmount / 100).toFixed(2)}${remaining > 0 ? ` ($${(remaining / 100).toFixed(2)} remaining)` : ""}`,
  };
}

export async function GET(req: NextRequest) {
  // Auth: scheduled runs use the cron Bearer (verifyCron). A valid admin token
  // (?token=…) bypasses it so the cron can be invoked MANUALLY on-demand — for
  // dev testing and ops. verifyCron also short-circuits in non-prod, so the
  // manual token is the only way to exercise it locally.
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const blocked = verifyCron(req);
    if (blocked) return blocked;
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  // ── Manual single-reservation settle (?billId=…) ───────────────────────────
  // Skips the Office dayplanner detection (which needs prod office creds and
  // 401s in dev). The caller vouches the guest has checked in. The Square side
  // (gift card → day-of order) works anywhere, so this settles one booking for
  // dev testing / ops without the Office API. Idempotent (dayof_order_sent_at).
  const manualBillId = req.nextUrl.searchParams.get("billId");
  if (manualBillId) {
    const r = await getBowlingReservationByBillId(manualBillId);
    if (!r) return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    if (r.productKind !== "race" && r.productKind !== "attraction")
      return NextResponse.json(
        { error: `not a race/attraction reservation (${r.productKind})` },
        { status: 400 },
      );
    if (!r.squareGiftCardId || !r.squareDayofOrderId)
      return NextResponse.json(
        { error: "no gift card / day-of order on reservation" },
        { status: 400 },
      );
    if (r.dayofOrderSentAt)
      return NextResponse.json({ ok: true, billId: manualBillId, alreadySettled: true });
    const label = `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`;
    if (dryRun)
      return NextResponse.json({ ok: true, dryRun: true, billId: manualBillId, wouldPay: label });
    const res = await chargeDayof(r);
    if (res.paid) {
      await updateBowlingReservationLaneOpen(r.id, {
        laneNumbers: [],
        paymentId: res.paymentId,
        source: "race-dayof-pay-manual",
      });
    }
    return NextResponse.json({
      ok: res.paid,
      billId: manualBillId,
      result: res.note,
      paymentId: res.paymentId,
    });
  }

  // Candidates: races + standalone attractions (no bowling sharing the order,
  // which would otherwise be settled by the bowling lane-open flow). Both are
  // BMI-side, settled the same way (check-in -5 + start-time-passed fallback).
  const [raceCandidates, attractionCandidates] = await Promise.all([
    getRaceReservationsAwaitingDayofPay(),
    getAttractionReservationsAwaitingDayofPay(),
  ]);
  const candidates = [...raceCandidates, ...attractionCandidates];

  const centers: Array<Record<string, unknown>> = [];
  let totalPaid = 0;

  for (const center of CENTERS) {
    const mine = candidates.filter(
      (r) => (OFFICE_CLIENT_KEY[r.centerCode] ?? "headpinzftmyers") === center.clientKey,
    );
    const result: Record<string, unknown> = {
      clientKey: center.clientKey,
      candidates: mine.length,
      arrived: 0,
      paid: [] as string[],
      wouldPay: [] as string[],
      skipped: [] as string[],
    };
    if (mine.length === 0) {
      centers.push(result);
      continue;
    }

    // Scan for Arrived (-5) states. If it fails we DON'T bail — the temporary
    // start-time-passed fallback below still settles overdue races.
    let arrived = new Set<string>();
    try {
      arrived = await arrivedNumbers(center.clientKey);
      result.arrived = arrived.size;
    } catch (err) {
      result.scanError = err instanceof Error ? err.message : "dayplanner scan failed";
    }

    for (const r of mine) {
      const label = `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`;
      const isArrived = arrived.has(normalizeNum(r.bmiReservationNumber));
      // ⚠️ TEMPORARY FALLBACK (see header — remove once -5 detection is trusted):
      // settle once the actual race START TIME (earliest heat) has passed even if
      // we never saw Arrived. Uses booking_metadata heat time, NOT booked_at
      // (which is the booking timestamp for race/attraction anchor rows).
      const startEpoch = bmiStartEpoch(r);
      const startPassed = startEpoch != null && Date.now() > startEpoch;
      const viaFallback = !isArrived && startPassed;
      if (!isArrived && !viaFallback) {
        (result.skipped as string[]).push(`${label}: not checked in (-5) yet`);
        continue;
      }
      const tag = viaFallback ? " [FALLBACK: start time passed]" : "";
      if (dryRun) {
        (result.wouldPay as string[]).push(`${label}${tag}`);
        continue;
      }
      try {
        const res = await chargeDayof(r);
        if (res.paid) {
          await updateBowlingReservationLaneOpen(r.id, {
            laneNumbers: [],
            paymentId: res.paymentId,
            source: viaFallback ? "race-dayof-pay-fallback-timepassed" : "race-dayof-pay",
          });
          (result.paid as string[]).push(`${label}${tag}: ${res.note}`);
          totalPaid += 1;
        } else {
          (result.skipped as string[]).push(`${label}: ${res.note}`);
        }
      } catch (err) {
        (result.skipped as string[]).push(
          `${label}: ${err instanceof Error ? err.message : "charge error"}`,
        );
      }
    }
    centers.push(result);
  }

  console.log(
    `[race-dayof-pay] dryRun=${dryRun} candidates=${candidates.length} paid=${totalPaid}`,
  );
  return NextResponse.json({
    ok: true,
    dryRun,
    candidates: candidates.length,
    paid: totalPaid,
    centers,
  });
}
