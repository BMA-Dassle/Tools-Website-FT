import { NextRequest, NextResponse, after } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import redis from "@/lib/redis";
import {
  unifiedReserve,
  readTerminalReserveRecovery,
  BillExpiredError,
  ReserveInProgressError,
  type TerminalReserveRecovery,
} from "~/features/booking/service/unified-reserve";
import { radioServerFor } from "~/features/kiosk/assist-alert";

// The recovery (grace + reserve replay) runs in after(); give it headroom.
export const maxDuration = 60;

// Square delivers payment.updated within seconds of capture — right while the
// client is still running its OWN reserve. This webhook is a BACKSTOP for when
// the client never finishes (walk-away), so it waits this long and re-checks
// before acting, to avoid racing (and false-alarming on) a booking about to
// succeed on its own.
const RESERVE_GRACE_MS = 8000;

/**
 * Square webhook receiver — kiosk direct-Terminal captured-but-unreserved backstop.
 *
 * The kiosk arms the reader against OUR deposit order, then the client is meant
 * to call reserve-all with the completed paymentId. If the client dies between
 * the tap and reserve AND the guest never comes back (so the prepare-time inline
 * resume never fires), the card is captured with NO booking. This webhook is the
 * server-side recovery: on a COMPLETED payment for one of our kiosk deposit
 * orders that has no booking yet, it replays `unifiedReserve` verbatim (idempotent
 * via baseKey) using the full reserve input persisted at prepare.
 *
 * NEVER auto-refunds: the codebase rule is forward-recovery, deposit stays put. A
 * dead (auto-cancelled) bill can't be rebooked, so we alert staff to refund/rebook.
 *
 * Dormant until SQUARE_WEBHOOK_SIGNATURE_KEY is set + the subscription is created
 * in the Square dashboard. Handles `payment.updated` / `payment.created`.
 */

const SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
// The EXACT notification URL configured in the Square dashboard — Square signs
// (url + body), so it must match byte-for-byte. Falls back to reconstructing
// from the request when unset (works when no proxy rewrites the path/host).
const NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || "";
const RADIO_ALERT_URL = "https://bma-soteria-alerts.azurewebsites.net/radio";

function notificationUrl(req: NextRequest): string {
  if (NOTIFICATION_URL) return NOTIFICATION_URL;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "";
  return `${proto}://${host}${new URL(req.url).pathname}`;
}

/** Square signature: base64 HMAC-SHA256 of (notificationUrl + rawBody). */
function verifySignature(rawBody: string, signature: string | null, url: string): boolean {
  if (!SIGNATURE_KEY || !signature) return false;
  const expected = createHmac("sha256", SIGNATURE_KEY)
    .update(url + rawBody)
    .digest("base64");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Durable orphan marker + best-effort radio alert to the venue front desk.
 *  No auto-refund (forward-recovery rule) — a human resolves. Never throws. */
async function alertOrphan(
  orderId: string,
  paymentId: string,
  amountCents: number,
  rec: TerminalReserveRecovery,
  reason: string,
): Promise<void> {
  const bill = rec.session.bmiBillId ?? null;
  console.error(
    `[square-webhook] ORPHAN captured-no-booking order=${orderId} payment=${paymentId} ` +
      `amount=${amountCents} bill=${bill} reason=${reason} — staff must refund/rebook (no auto-refund)`,
  );
  await redis
    .set(
      `kiosk:terminal:orphan:${orderId}`,
      JSON.stringify({
        orderId,
        paymentId,
        amountCents,
        seed: rec.seed,
        bill,
        reason,
        at: new Date().toISOString(),
      }),
      "EX",
      60 * 60 * 24 * 30,
    )
    .catch(() => {});
  try {
    const server = radioServerFor({
      center: rec.session.center === "naples" ? "naples" : "fort-myers",
      brand: rec.session.entryBrand === "headpinz" ? "headpinz" : "fasttrax",
    });
    await fetch(RADIO_ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server,
        target: "FOH",
        priority: 1,
        message: `Kiosk payment needs attention at the front desk — a card was charged $${(amountCents / 100).toFixed(2)} but the booking did not complete`,
        name: `KioskOrphan${orderId.slice(-6)}`,
        cooldown: 60,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* radio best-effort — the durable marker + loud log are the record of truth */
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-square-hmacsha256-signature");
  if (!verifySignature(rawBody, signature, notificationUrl(req))) {
    // Fail closed: unconfigured (no key) or a bad signature both land here.
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: {
    type?: string;
    data?: {
      object?: {
        payment?: {
          id?: string;
          status?: string;
          order_id?: string;
          amount_money?: { amount?: number };
        };
      };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (event.type !== "payment.updated" && event.type !== "payment.created") {
    return NextResponse.json({ ignored: true, reason: "event type" });
  }
  const payment = event.data?.object?.payment;
  const orderId = payment?.order_id;
  const paymentId = payment?.id;
  const amountCents = payment?.amount_money?.amount ?? 0;
  if (payment?.status !== "COMPLETED" || !orderId || !paymentId) {
    return NextResponse.json({ ignored: true, reason: "not a completed payment with order" });
  }

  // Is this one of OUR kiosk terminal deposits? (Every other Square payment in
  // the account has no recovery record → ignored.)
  const rec = await readTerminalReserveRecovery(orderId);
  if (!rec) {
    return NextResponse.json({ ignored: true, reason: "not a kiosk terminal deposit" });
  }

  // Already booked? (fast common-case no-op — the client's own reserve, or a
  // prior webhook delivery, already completed it.)
  const bill = rec.session.bmiBillId;
  if (bill) {
    const confirmed = await redis.get(`bmi:confirmed:${bill}`).catch(() => null);
    if (confirmed) {
      return NextResponse.json({ ignored: true, reason: "already confirmed" });
    }
  }

  // Ack Square immediately, then recover in the background AFTER a grace period,
  // so we (a) never risk Square's delivery timeout while unifiedReserve runs and
  // (b) let the client's own reserve win the common race instead of duplicating
  // its work or false-alarming on it.
  const recover = async () => {
    try {
      await new Promise((r) => setTimeout(r, RESERVE_GRACE_MS));
      // The client almost certainly finished during the grace window — re-check.
      if (bill) {
        const confirmed = await redis.get(`bmi:confirmed:${bill}`).catch(() => null);
        if (confirmed) return;
      }
      // Serialize against a concurrent webhook delivery / the client's reserve.
      const lockKey = `kiosk:terminal:webhook:${orderId}`;
      let locked = "OK";
      try {
        locked = ((await redis.set(lockKey, "1", "EX", 120, "NX")) as string | null) ?? "OK";
      } catch {
        locked = "OK"; // Redis down — unifiedReserve's own lock + baseKey still guard it
      }
      if (locked !== "OK") return;
      try {
        await unifiedReserve({
          session: rec.session,
          contact: rec.contact,
          externalPayment: { paymentId, depositOrderId: orderId, amountCents, source: "terminal" },
        });
        console.log(
          `[square-webhook] recovered booking for order=${orderId} bill=${bill ?? "n/a"}`,
        );
      } catch (err) {
        if (err instanceof ReserveInProgressError) {
          // The client is mid-reserve right now — it owns this booking. Not an
          // orphan; do NOT alert. (unifiedReserve is idempotent, so even if we
          // both proceeded there'd be no double-book — but skip the noise.)
          return;
        }
        if (err instanceof BillExpiredError) {
          // The BMI hold auto-cancelled before we could book — can't rebook.
          await alertOrphan(orderId, paymentId, amountCents, rec, "bill_expired");
          return;
        }
        console.error(`[square-webhook] reserve replay failed order=${orderId}:`, err);
        await alertOrphan(orderId, paymentId, amountCents, rec, "reserve_error");
      } finally {
        await redis.del(lockKey).catch(() => {});
      }
    } catch (e) {
      console.error(`[square-webhook] recover crashed order=${orderId}:`, e);
    }
  };
  try {
    after(recover);
  } catch {
    // Outside a request scope (shouldn't happen for a route handler) — run inline.
    void recover();
  }
  return NextResponse.json({ accepted: true });
}
