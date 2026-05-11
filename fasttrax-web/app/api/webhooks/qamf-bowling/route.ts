import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import redis from "@/lib/redis";
import {
  getBowlingReservationByQamfId,
  insertBowlingReservation,
  updateBowlingReservationStatus,
  updateBowlingReservationCancelled,
  updateSquareDayofOrderId,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";
import { getReservation, listLanes } from "@/lib/qamf-bowling";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { sendLaneReadyNotification } from "@/lib/bowling-lane-ready-notify";
import { createWalkinDayofOrder } from "@/lib/bowling-walkin-order";
import { shortenUrl } from "@/lib/short-url";

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

const QAMF_ID_TO_CENTER_CODE: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

/** Prefixes we track in Neon. Everything else (F, W, etc.) is ignored. */
const TRACKED_PREFIXES = ["X", "K", "C"];

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

const WALKIN_SMS_FROM: Record<string, string> = {
  TXBSQN0FEKQ11: "+12393022155",
  PPTR5G2N0QXF7: "+12394553755",
};

/**
 * Handle reservation.created for K (kiosk) and C (conqueror) reservations.
 * Creates a Neon row from QAMF data, optionally sends a check-in SMS.
 *
 * SMS is skipped when:
 *  - No guest phone available (common for C/staff-created)
 *  - Lanes are already Running (K Play Now — guest is headed to the lane)
 */
async function handleWalkinCreated(
  qamfId: string,
  centerId: number | null,
): Promise<Record<string, unknown>> {
  // Dedupe: if Neon row already exists, skip
  const existing = await getBowlingReservationByQamfId(qamfId);
  if (existing) {
    console.log(`[qamf-bowling] walkin ${qamfId} already in Neon neonId=${existing.id} — skip`);
    return { kind: "skipped", reason: "already-exists", neonId: existing.id };
  }

  // Resolve center code from webhook centerId
  const centerCode = centerId ? QAMF_ID_TO_CENTER_CODE[centerId] : undefined;
  if (!centerCode || !centerId) {
    console.warn(`[qamf-bowling] walkin ${qamfId} unknown centerId=${centerId}`);
    return { kind: "skipped", reason: "unknown-center" };
  }

  // Fetch full reservation data from QAMF
  let qamfRes;
  try {
    qamfRes = await getReservation(centerId, qamfId);
  } catch (err) {
    console.error(
      `[qamf-bowling] walkin ${qamfId} getReservation failed:`,
      err instanceof Error ? err.message : err,
    );
    throw err; // Let dead-letter queue retry
  }

  const guest = qamfRes.Customer?.Guest;
  const guestName = guest?.Name ?? null;
  const guestPhone = guest?.PhoneNumber ?? null;
  const guestEmail = guest?.Email ?? null;
  const playerCount = qamfRes.TotalPlayers ?? null;
  const bookedAt = qamfRes.BookedAt ?? new Date().toISOString();
  const bookingSource: "kiosk" | "conqueror" = qamfId.startsWith("K") ? "kiosk" : "conqueror";

  const reservation = await insertBowlingReservation(
    {
      centerCode,
      productKind: "open",
      qamfReservationId: qamfId,
      depositCents: 0,
      totalCents: 0,
      status: "confirmed",
      bookedAt,
      playerCount: playerCount ?? undefined,
      guestName: guestName ?? undefined,
      guestEmail: guestEmail ?? undefined,
      guestPhone: guestPhone ?? undefined,
      notes: qamfRes.Notes ?? qamfRes.Title ?? undefined,
      bookingSource,
    },
    [], // No line items — POS handles pricing
  );

  console.log(
    `[qamf-bowling] walkin created neonId=${reservation.id} qamfId=${qamfId}` +
    ` source=${bookingSource} guest=${guestName ?? "?"} phone=${guestPhone ? "yes" : "no"}`,
  );

  // Check if lanes are already Running (K Play Now → skip SMS)
  const lanes = qamfRes.Lanes ?? [];
  const hasRunningLane = lanes.some((l) => l.Status === "Running");

  // SMS disabled for K/C reservations until we confirm self-service
  // lane open works for kiosk/conqueror bookings.
  // TODO: re-enable check-in SMS once K/C lane open is validated

  return { kind: "walkin-created", neonId: reservation.id, bookingSource };
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

  // Only process tracked prefixes (X=web, K=kiosk, C=conqueror)
  const isTracked = !qamfId || TRACKED_PREFIXES.some((p) => qamfId.startsWith(p));
  if (!isTracked) {
    console.log(`[qamf-bowling] skipping untracked qamfId=${qamfId} type=${eventType}`);
    return { kind: "skipped", reason: "untracked-prefix" };
  }

  if (eventType === "reservation.created") {
    if (!qamfId || qamfId.startsWith("X")) {
      // Web reservations — Neon row already created by /api/bowling/v2/reserve
      console.log(`[qamf-bowling] reservation.created qamfId=${qamfId} — no action (web)`);
      return { kind: "skipped", reason: "created-web" };
    }
    // K/C reservation — create Neon row + optionally send check-in SMS
    return await handleWalkinCreated(qamfId, centerId);
  }

  if (!qamfId) {
    console.warn(`[qamf-bowling] no Data.Id in event type=${eventType}`);
    return { kind: "unknown", reason: "no-qamf-id" };
  }

  // Look up the Neon reservation
  let reservation = await getBowlingReservationByQamfId(qamfId);

  // Backfill: if no Neon row for K/C, create one now (missed reservation.created)
  if (!reservation && (qamfId.startsWith("K") || qamfId.startsWith("C"))) {
    console.log(`[qamf-bowling] backfill: creating Neon row for ${qamfId} type=${eventType}`);
    const created = await handleWalkinCreated(qamfId, centerId);
    if (created.neonId) {
      reservation = await getBowlingReservationByQamfId(qamfId);
    }
  }

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

      // For walkin reservations without a day-of order, create a $0 one now
      // so processLaneOpen can add SHIPMENT fulfillment for KDS shoe routing.
      if (!reservation.squareDayofOrderId && reservation.bookingSource !== "web") {
        try {
          const { dayofOrderId } = await createWalkinDayofOrder({
            locationId: reservation.centerCode,
            guestName: reservation.guestName ?? "Walk-in",
            playerCount: reservation.playerCount ?? 1,
            neonId: reservation.id,
            qamfReservationId: qamfId,
          });
          await updateSquareDayofOrderId(reservation.id, dayofOrderId);
          reservation = { ...reservation, squareDayofOrderId: dayofOrderId };
        } catch (err) {
          console.error(
            `[qamf-bowling] createWalkinDayofOrder failed neonId=${reservation.id}:`,
            err instanceof Error ? err.message : err,
          );
          // Continue — processLaneOpen will skip Square steps
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

      // Send lane-ready SMS/email if not already sent (web reservations only).
      // K/C SMS disabled until we confirm self-service lane open works for kiosk/conqueror.
      // Gate: only notify when physical lanes are Closed (ready to start,
      // not Error or Open for someone else) AND within 30 min of booked time.
      if (!reservation.laneReadySentAt && laneNumbers.length > 0 && reservation.bookingSource === "web") {
        const bookedAt = new Date(reservation.bookedAt).getTime();
        const minsUntilBooked = (bookedAt - Date.now()) / 60_000;

        if (minsUntilBooked <= 30) {
          try {
            const qamfCenterId = centerId ?? CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
            if (qamfCenterId) {
              const physicalLanes = await listLanes(qamfCenterId);
              const assignedPhysical = physicalLanes.filter((pl) =>
                laneNumbers.includes(pl.LaneNumber),
              );
              const allClosed =
                assignedPhysical.length > 0 &&
                assignedPhysical.every((pl) => pl.Status === "Closed");

              if (allClosed) {
                const ll = laneNumbers.length === 1
                  ? `Lane ${laneNumbers[0]}`
                  : `Lanes ${laneNumbers.join(", ")}`;
                await sendLaneReadyNotification(reservation, ll);
                console.log(
                  `[qamf-bowling] lane-ready SMS sent neonId=${reservation.id}` +
                  ` lanes=${laneNumbers.join(",")} allClosed=true`,
                );
              } else {
                console.log(
                  `[qamf-bowling] lane-ready SMS skipped neonId=${reservation.id}` +
                  ` — physical lanes not all Closed: ${assignedPhysical.map((pl) => `${pl.LaneNumber}=${pl.Status}`).join(",")}`,
                );
              }
            }
          } catch (err) {
            console.warn(
              `[qamf-bowling] lane-ready SMS check failed neonId=${reservation.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
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
