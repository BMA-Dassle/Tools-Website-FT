import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import redis from "@/lib/redis";
import {
  getBowlingReservationByQamfId,
  updateBowlingReservationStatus,
  updateBowlingReservationCancelled,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";
import { getReservation } from "@/lib/qamf-bowling";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { sendLaneReadyNotification } from "@/lib/bowling-lane-ready-notify";

/**
 * QubicaAMF bowling reservation + lane webhook receiver.
 *
 * Implements the Standard Webhooks spec
 * (https://www.standardwebhooks.com) per QAMF "Bowling Reservation
 * Webhooks - Specifications V1.3":
 *
 *   - Validates `webhook-id` for idempotency (Redis dedup, 3d TTL)
 *   - Validates `webhook-timestamp` against server clock (±5 min skew)
 *   - Validates `webhook-signature` (HMAC-SHA256, base64)
 *   - Processes events **inline** (no queue delay)
 *   - Falls back to Redis dead-letter queue on processing failure
 *   - Maintains a heartbeat key for cron / dashboard health checks
 *
 * Event types (`Type` field on the JSON body):
 *   reservation.created  — logged, no action (we create the Neon row)
 *   reservation.updated  — status mapping + lane-open trigger
 *   reservation.deleted  — cancellation + Square refund
 *   lanes.updated        — skipped (physical lane noise)
 *
 * Processing (inline, instant):
 *   reservation.updated  → maps QAMF status → Neon status:
 *     Confirmed  → confirmed
 *     Arrived    → arrived  + processLaneOpen (Square day-of order)
 *     Completed  → completed
 *     Canceled   → cancelled + Square refund
 *
 *   Lane-open fires when Data.Status="Arrived" OR Data.Lanes[].Status="Running".
 *   QAMF sends both simultaneously when lanes open.
 *
 *   reservation.deleted  → cancellation + Square refund
 *
 * Dead-letter: if inline processing throws, the event is pushed to the
 * Redis queue for the bowling-events-consumer cron to retry.
 */

const SECRETS_RAW = process.env.QAMF_BOWLING_WEBHOOK_SECRET || "";
const QUEUE_KEY = "qamf:bowling:events:queue"; // dead-letter fallback only
const QUEUE_MAX_LEN = 5000;
const QUEUE_TTL = 60 * 60 * 24; // 24h
const HEARTBEAT_KEY = "qamf:bowling:last-event";
const HEARTBEAT_TTL = 60 * 60; // 1h
const DEBUG_LOG_KEY = "qamf:bowling:debug-log";
const DEBUG_LOG_MAX = 500;
const DEBUG_LOG_TTL = 60 * 60 * 24 * 7; // 7 days
const DEDUP_KEY_PREFIX = "qamf:bowling:dedup:";
const DEDUP_TTL = 60 * 60 * 24 * 3; // 3d
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// QAMF reservation-level status → Neon status mapping.
// "Ready" and "Running" are lane-level statuses only — never in Data.Status.
// See docs/qamf-lane-lifecycle.md for the full state machine.
const QAMF_STATUS_MAP: Record<string, BowlingReservation["status"] | "cancel"> = {
  Confirmed:  "confirmed",
  Arrived:    "arrived",
  Completed:  "completed",
  Canceled:   "cancel",
  Cancelled:  "cancel",
};

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/** Multi-key support for HMAC rotation. */
function loadSecrets(): string[] {
  return SECRETS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Standard Webhooks signature format: `v1,<base64-sig>` */
function verifySignature(
  signatureHeader: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: string,
): boolean {
  const secrets = loadSecrets();
  if (secrets.length === 0) return false;
  if (!signatureHeader || !webhookId || !webhookTimestamp) return false;

  const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const incomingSigs = signatureHeader.split(" ").filter(Boolean);

  for (const sig of incomingSigs) {
    const base64 = sig.startsWith("v1,") ? sig.slice(3) : sig;
    const incomingBuf = Buffer.from(base64, "base64");
    if (incomingBuf.length === 0) continue;

    for (const key of secrets) {
      const keyVariants = [
        Buffer.from(key, "base64"),
        Buffer.from(key, "utf8"),
      ];
      for (const keyBuf of keyVariants) {
        if (keyBuf.length === 0) continue;
        const expected = createHmac("sha256", keyBuf).update(signedPayload).digest();
        if (
          expected.length === incomingBuf.length &&
          timingSafeEqual(expected, incomingBuf)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

interface QamfEnvelope {
  Type?: string;
  CenterId?: number;
  Timestamp?: string;
  Data?: {
    Id?: string;
    Status?: string;
    Lanes?: Array<{ Id?: string; LaneNumber?: number; Status?: string }>;
    [key: string]: unknown;
  };
}

// ── Inline event processing ─────────────────────────────────────────

async function handleCancellation(
  reservation: BowlingReservation & { lines: unknown[] },
  webhookId: string,
): Promise<{ refunded: boolean; error: boolean }> {
  if (reservation.status === "cancelled") {
    console.log(`[qamf-bowling] neonId=${reservation.id} already cancelled — skip`);
    return { refunded: false, error: false };
  }

  let squareRefundId: string | undefined;
  let refundCents = 0;
  let refunded = false;
  let hadError = false;

  if (reservation.squareDepositPaymentId && reservation.squareGiftCardId) {
    try {
      const idempotencyKey = `qamf-cancel-${webhookId}`;
      const result = await processSquareBowlingRefund({
        depositPaymentId: reservation.squareDepositPaymentId,
        giftCardId:       reservation.squareGiftCardId,
        dayofOrderId:     reservation.squareDayofOrderId,
        locationId:       reservation.centerCode,
        idempotencyKey,
      });
      squareRefundId = result.refundId;
      refundCents    = result.refundedCents;
      refunded = true;
      console.log(
        `[qamf-bowling] neonId=${reservation.id} refunded ${refundCents}¢ refundId=${result.refundId}`,
      );
    } catch (err) {
      console.error(
        `[qamf-bowling] neonId=${reservation.id} refund failed:`,
        err instanceof Error ? err.message : err,
      );
      hadError = true;
    }
  } else {
    console.log(
      `[qamf-bowling] neonId=${reservation.id} no deposit on file — marking cancelled without refund`,
    );
  }

  await updateBowlingReservationCancelled(reservation.id, { squareRefundId, refundCents });
  console.log(`[qamf-bowling] neonId=${reservation.id} marked cancelled`);
  return { refunded, error: hadError };
}

/**
 * Process a single QAMF webhook event inline.
 *
 * Returns a result descriptor for the response body. Throws only on
 * truly unexpected errors — those bubble up to the dead-letter handler.
 */
async function processEvent(
  body: QamfEnvelope,
  webhookId: string,
  centerId: number | null,
): Promise<Record<string, unknown>> {
  const eventType = typeof body.Type === "string" ? body.Type : "unknown";
  const data = body.Data;
  const qamfId = data?.Id ?? "";
  const qamfStatus = data?.Status ?? "";

  // Only process our web reservations (QAMF IDs start with "X")
  if (qamfId && !qamfId.startsWith("X")) {
    console.log(`[qamf-bowling] skipping non-web qamfId=${qamfId} type=${eventType}`);
    return { kind: "skipped", reason: "non-web" };
  }

  if (eventType === "reservation.created") {
    console.log(`[qamf-bowling] reservation.created qamfId=${qamfId} — no action`);
    return { kind: "skipped", reason: "created" };
  }

  if (!qamfId) {
    console.warn(`[qamf-bowling] no Data.Id in event type=${eventType}`);
    return { kind: "unknown", reason: "no-qamf-id" };
  }

  // Look up the Neon reservation
  const reservation = await getBowlingReservationByQamfId(qamfId);
  if (!reservation) {
    console.warn(`[qamf-bowling] no Neon row for qamfId=${qamfId} type=${eventType}`);
    return { kind: "unknown", reason: "no-neon-row" };
  }

  // ── reservation.deleted → always cancel + refund ──────────────────
  if (eventType === "reservation.deleted") {
    console.log(`[qamf-bowling] reservation.deleted qamfId=${qamfId} neonId=${reservation.id}`);
    const cr = await handleCancellation(reservation, webhookId);
    return { kind: "cancelled", refunded: cr.refunded, error: cr.error ? "refund-failed" : undefined };
  }

  // ── reservation.updated → map status + lane-open trigger ──────────
  if (eventType === "reservation.updated") {
    let laneOpenAction: string | undefined;

    // Lane-open trigger: Data.Status="Arrived" OR Lanes[].Status="Running"
    const webhookLanes = Array.isArray(data?.Lanes)
      ? (data!.Lanes as Array<{ LaneNumber?: number; Status?: string }>)
      : [];
    const hasRunningLane = webhookLanes.some((l) => l.Status === "Running");
    const isArrived = qamfStatus === "Arrived";

    if ((isArrived || hasRunningLane) && !reservation.dayofOrderSentAt) {
      const tLaneOpen = Date.now();
      console.log(
        `[qamf-bowling] lane-open trigger neonId=${reservation.id} qamfId=${qamfId}` +
        ` Data.Status="${qamfStatus}" hasRunningLane=${hasRunningLane}` +
        ` webhookId=${webhookId}`,
      );

      // Extract lane numbers from webhook payload
      let laneNumbers: number[] = webhookLanes
        .filter((l) => l.Status === "Running")
        .map((l) => l.LaneNumber)
        .filter((n): n is number => typeof n === "number");

      // Fallback: fetch from QAMF if no Running lanes in payload
      if (laneNumbers.length === 0) {
        const qamfCenterId = centerId ?? CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
        if (qamfCenterId) {
          try {
            const tQamf = Date.now();
            const qamfRes = await getReservation(qamfCenterId, qamfId);
            console.log(`[qamf-bowling] getReservation fallback neonId=${reservation.id} ${Date.now() - tQamf}ms`);
            laneNumbers = (qamfRes.Lanes ?? [])
              .map((l) => l.LaneNumber)
              .filter((n): n is number => typeof n === "number");
          } catch (err) {
            console.warn(
              `[qamf-bowling] getReservation failed for lane-open neonId=${reservation.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

      try {
        const laneResult = await processLaneOpen({
          reservation,
          laneNumbers,
          idempotencyBase: `lane-open-${reservation.id}`,
          source: "webhook",
        });
        laneOpenAction = "lane-open";
        console.log(
          `[qamf-bowling] lane-open neonId=${reservation.id} totalMs=${Date.now() - tLaneOpen}` +
          ` lane="${laneResult.laneLabel}" kitchen=${laneResult.kitchenItemsUpdated}` +
          ` paymentId=${laneResult.paymentId ?? "none"}` +
          (laneResult.error ? ` error=${laneResult.error}` : ""),
        );
      } catch (err) {
        console.error(
          `[qamf-bowling] processLaneOpen threw neonId=${reservation.id} totalMs=${Date.now() - tLaneOpen}:`,
          err instanceof Error ? err.message : err,
        );
        laneOpenAction = "lane-open-failed";
      }
      // Fall through — let the status map advance Neon status

      // Send lane-ready SMS/email if not already sent
      if (!reservation.laneReadySentAt) {
        try {
          const ll = laneNumbers.length === 1
            ? `Lane ${laneNumbers[0]}`
            : laneNumbers.length > 1
            ? `Lanes ${laneNumbers.join(", ")}`
            : "";
          await sendLaneReadyNotification(reservation, ll);
        } catch (err) {
          console.warn(
            `[qamf-bowling] lane-ready SMS failed neonId=${reservation.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // Map QAMF status → Neon status
    const neonAction = QAMF_STATUS_MAP[qamfStatus];
    if (!neonAction) {
      console.log(
        `[qamf-bowling] reservation.updated qamfId=${qamfId} status=${qamfStatus} — no mapped action`,
      );
      return { kind: "skipped", reason: "unmapped-status", laneOpenAction };
    }

    if (neonAction === "cancel") {
      console.log(
        `[qamf-bowling] reservation.updated status=${qamfStatus}` +
        ` → cancellation qamfId=${qamfId} neonId=${reservation.id}`,
      );
      const cr = await handleCancellation(reservation, webhookId);
      return { kind: "cancelled", refunded: cr.refunded, laneOpenAction, error: cr.error ? "refund-failed" : undefined };
    }

    // Status transition — skip no-ops and downgrades
    const current = reservation.status;
    if (current === neonAction) {
      return { kind: "skipped", reason: "already-at-status", laneOpenAction };
    }
    if (current === "completed" || current === "cancelled") {
      console.log(
        `[qamf-bowling] skipping ${current} → ${neonAction} (terminal) neonId=${reservation.id}`,
      );
      return { kind: "skipped", reason: "terminal-state", laneOpenAction };
    }

    await updateBowlingReservationStatus(reservation.id, neonAction);
    console.log(
      `[qamf-bowling] neonId=${reservation.id} qamfId=${qamfId} status ${current} → ${neonAction}`,
    );
    return { kind: "updated", from: current, to: neonAction, laneOpenAction };
  }

  console.log(`[qamf-bowling] unhandled eventType=${eventType} qamfId=${qamfId}`);
  return { kind: "unknown", reason: "unhandled-type" };
}

// ── POST handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const started = Date.now();

  // Header extraction
  const webhookId = req.headers.get("webhook-id") || "";
  const webhookTimestamp = req.headers.get("webhook-timestamp") || "";
  const webhookSignature = req.headers.get("webhook-signature") || "";

  // ── 1. Header presence ─────────────────────────────────────────────
  const secrets = loadSecrets();
  if (secrets.length > 0) {
    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      return NextResponse.json(
        { error: "missing webhook-id / webhook-timestamp / webhook-signature" },
        { status: 400 },
      );
    }
  } else if (!webhookId) {
    return NextResponse.json(
      { error: "missing webhook-id (bootstrap mode requires id for dedup)" },
      { status: 400 },
    );
  }

  // ── 2. Read RAW body for signature verification ────────────────────
  const rawBody = await req.text();

  // ── 3. Timestamp skew check ────────────────────────────────────────
  if (webhookTimestamp) {
    const tsSeconds = parseInt(webhookTimestamp, 10);
    if (!Number.isFinite(tsSeconds)) {
      return NextResponse.json({ error: "invalid webhook-timestamp" }, { status: 400 });
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds);
    if (skew > TIMESTAMP_TOLERANCE_SECONDS) {
      console.warn(
        `[qamf-bowling] timestamp skew ${skew}s exceeds ${TIMESTAMP_TOLERANCE_SECONDS}s tolerance — rejecting`,
      );
      return NextResponse.json({ error: "timestamp out of tolerance" }, { status: 400 });
    }
  }

  // ── 4. Signature verification ──────────────────────────────────────
  if (secrets.length > 0) {
    const ok = verifySignature(webhookSignature, webhookId, webhookTimestamp, rawBody);
    if (!ok) {
      console.warn("[qamf-bowling] signature verification failed for webhook-id:", webhookId);
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } else {
    console.warn(
      "[qamf-bowling] QAMF_BOWLING_WEBHOOK_SECRET not set — accepting unverified payloads (bootstrap mode)",
    );
  }

  // ── 5. Idempotency (Redis dedup on webhook-id) ─────────────────────
  const dedupKey = DEDUP_KEY_PREFIX + webhookId;
  const claimed = await redis.set(dedupKey, "1", "EX", DEDUP_TTL, "NX");
  if (claimed !== "OK") {
    return NextResponse.json({ ok: true, kind: "duplicate", webhookId });
  }

  // ── 6. Parse body ──────────────────────────────────────────────────
  let body: QamfEnvelope = {};
  try {
    body = JSON.parse(rawBody) as QamfEnvelope;
  } catch {
    body = {};
  }

  const eventType = typeof body.Type === "string" ? body.Type : "unknown";
  const centerId = typeof body.CenterId === "number" ? body.CenterId : null;

  // ── 7. Debug log (all events, including lanes.updated) ─────────────
  const debugEntry = JSON.stringify({
    webhookId,
    eventType,
    centerId,
    receivedAt: new Date().toISOString(),
    raw: body,
  });
  redis
    .lpush(DEBUG_LOG_KEY, debugEntry)
    .then(() => redis.ltrim(DEBUG_LOG_KEY, 0, DEBUG_LOG_MAX - 1))
    .then(() => redis.expire(DEBUG_LOG_KEY, DEBUG_LOG_TTL))
    .catch(() => void 0);

  // ── 8. Drop lanes.updated (physical lane noise) ────────────────────
  if (eventType === "lanes.updated") {
    redis
      .set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL)
      .catch(() => void 0);
    return NextResponse.json({ ok: true, kind: "skipped", eventType });
  }

  // ── 9. Process event INLINE ────────────────────────────────────────
  // Events are processed immediately — no queue delay. If processing
  // throws, the event is pushed to a dead-letter queue for the
  // bowling-events-consumer cron to retry.
  let result: Record<string, unknown>;
  try {
    result = await processEvent(body, webhookId, centerId);
  } catch (err) {
    console.error(
      `[qamf-bowling] processEvent threw for webhookId=${webhookId} type=${eventType}:`,
      err instanceof Error ? err.message : err,
    );

    // Dead-letter: push to queue for cron retry
    const deadLetter = JSON.stringify({
      webhookId,
      webhookTimestamp,
      eventType,
      centerId,
      sourceTimestamp: typeof body.Timestamp === "string" ? body.Timestamp : null,
      receivedAt: new Date().toISOString(),
      raw: body,
      deadLetter: true,
    });
    redis
      .lpush(QUEUE_KEY, deadLetter)
      .then(() => redis.ltrim(QUEUE_KEY, 0, QUEUE_MAX_LEN - 1))
      .then(() => redis.expire(QUEUE_KEY, QUEUE_TTL))
      .catch(() => void 0);

    result = { kind: "error", error: err instanceof Error ? err.message : "processing failed" };
  }

  // Heartbeat
  redis
    .set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL)
    .catch(() => void 0);

  console.log(
    `[qamf-bowling] ${eventType} webhookId=${webhookId.slice(0, 8)}… → ${result.kind} (${Date.now() - started}ms)`,
  );

  return NextResponse.json({ ok: true, eventType, elapsedMs: Date.now() - started, ...result });
}
