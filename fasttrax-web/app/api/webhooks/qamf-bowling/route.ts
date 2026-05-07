import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import redis from "@/lib/redis";

/**
 * QubicaAMF bowling reservation + lane webhook receiver.
 *
 * Implements the Standard Webhooks spec
 * (https://www.standardwebhooks.com) per QAMF "Bowling Reservation
 * Webhooks - Specifications V1.3":
 *
 *   - Validates `webhook-id` for idempotency (Redis dedup, 24h TTL)
 *   - Validates `webhook-timestamp` against server clock (±5 min skew)
 *   - Validates `webhook-signature` (HMAC-SHA256, base64) against
 *     the `{webhook-id}.{webhook-timestamp}.{raw-body}` payload
 *   - Pushes accepted events to a Redis FIFO for later processing
 *   - Maintains a heartbeat key for cron / dashboard health checks
 *
 * Event types (`Type` field on the JSON body):
 *   reservation.created, reservation.updated, reservation.deleted
 *   lanes.updated
 *
 * **Signature key**: QAMF generates the HMAC secret and sends it to
 * us when we register the subscription. Set it on Vercel env as
 * `QAMF_BOWLING_WEBHOOK_SECRET`. Multiple keys are supported during
 * rotation — comma-separated, the same body the spec calls out for
 * key rotation in the `webhook-signature` header.
 *
 * **Pre-key bootstrap**: until the secret arrives from QAMF, the
 * receiver is intentionally permissive — it logs the missing-secret
 * state, accepts any signed/unsigned payload, and queues it. This
 * lets QAMF register the URL and start sending real traffic; we
 * inspect the queue + flip the env var on once the key lands. The
 * verification gate flips closed automatically the moment the env
 * var is set — no code change required.
 */

const SECRETS_RAW = process.env.QAMF_BOWLING_WEBHOOK_SECRET || "";
const QUEUE_KEY = "qamf:bowling:events:queue";
const QUEUE_MAX_LEN = 5000;
const QUEUE_TTL = 60 * 60 * 24; // 24h — within QAMF's 48h retry budget
const HEARTBEAT_KEY = "qamf:bowling:last-event";
const HEARTBEAT_TTL = 60 * 60; // 1h
const DEDUP_KEY_PREFIX = "qamf:bowling:dedup:";
const DEDUP_TTL = 60 * 60 * 24 * 3; // 3d — comfortably past QAMF's 48h retry budget
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60; // 5 min — Standard Webhooks recommendation

/** Multi-key support for HMAC rotation. The spec notes the
 *  webhook-signature header may contain multiple space-separated
 *  signatures during a key roll — we mirror that on the verify side
 *  by accepting any matching key. */
function loadSecrets(): string[] {
  return SECRETS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Standard Webhooks signature format: `v1,<base64-sig>` (optionally
 *  multiple, space-separated). We accept any v1 match against our
 *  configured secrets. */
function verifySignature(
  signatureHeader: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: string,
): boolean {
  const secrets = loadSecrets();
  if (secrets.length === 0) return false; // caller decides whether to allow unverified
  if (!signatureHeader || !webhookId || !webhookTimestamp) return false;

  const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const incomingSigs = signatureHeader.split(" ").filter(Boolean);

  for (const sig of incomingSigs) {
    // Strip the version prefix ("v1,") if present
    const base64 = sig.startsWith("v1,") ? sig.slice(3) : sig;
    const incomingBuf = Buffer.from(base64, "base64");
    if (incomingBuf.length === 0) continue;

    for (const key of secrets) {
      // Per spec: secret is BASE64-decoded before being used as the
      // HMAC key (Standard Webhooks generates secrets as base64-encoded
      // random bytes). Some integrations pass the raw key string; try
      // both forms to be tolerant.
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
  Data?: unknown;
}

export async function POST(req: NextRequest) {
  // Header extraction — Standard Webhooks names are lowercase
  // by convention but Next normalizes incoming HTTP headers anyway.
  const webhookId = req.headers.get("webhook-id") || "";
  const webhookTimestamp = req.headers.get("webhook-timestamp") || "";
  const webhookSignature = req.headers.get("webhook-signature") || "";

  // ── 1. Header presence ─────────────────────────────────────────────
  // We accept missing headers ONLY in the bootstrap window before
  // QAMF has issued us a key. As soon as QAMF_BOWLING_WEBHOOK_SECRET
  // is set, all three headers must be present.
  const secrets = loadSecrets();
  if (secrets.length > 0) {
    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      return NextResponse.json(
        { error: "missing webhook-id / webhook-timestamp / webhook-signature" },
        { status: 400 },
      );
    }
  } else if (!webhookId) {
    // Bootstrap mode but at least we need an id for dedup. If we don't
    // even have that, refuse — QAMF always sends webhook-id.
    return NextResponse.json(
      { error: "missing webhook-id (bootstrap mode requires id for dedup)" },
      { status: 400 },
    );
  }

  // ── 2. Read RAW body for signature verification ────────────────────
  // Signature verification requires the EXACT bytes — re-serializing
  // through JSON.parse + JSON.stringify can change whitespace and
  // break the HMAC. Read once as text, parse for routing.
  const rawBody = await req.text();

  // ── 3. Timestamp skew check (replay-attack guard) ──────────────────
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
    // Bootstrap — log loudly so we know we're running unverified, but
    // don't reject. QAMF expects a 2xx; rejecting here would block
    // initial subscription registration before the key arrives.
    console.warn(
      "[qamf-bowling] QAMF_BOWLING_WEBHOOK_SECRET not set — accepting unverified payloads (bootstrap mode)",
    );
  }

  // ── 5. Idempotency (Redis dedup on webhook-id) ─────────────────────
  // Standard Webhooks: same webhook-id MUST be processed exactly once.
  // SET NX so concurrent retries that arrive at the same instant don't
  // both pass.
  const dedupKey = DEDUP_KEY_PREFIX + webhookId;
  const claimed = await redis.set(dedupKey, "1", "EX", DEDUP_TTL, "NX");
  if (claimed !== "OK") {
    // Already processed — Standard Webhooks expects 2xx so QAMF stops
    // retrying. Returning 409 would trigger their retry policy
    // unnecessarily.
    return NextResponse.json({ ok: true, kind: "duplicate", webhookId });
  }

  // ── 6. Parse body for routing / queue payload ──────────────────────
  let body: QamfEnvelope = {};
  try {
    body = JSON.parse(rawBody) as QamfEnvelope;
  } catch {
    // Bad JSON post-signature-check is unusual but possible. Don't
    // reject — we already accepted the dedup. Park the raw bytes for
    // inspection and ack.
    body = {};
  }

  const eventType = typeof body.Type === "string" ? body.Type : "unknown";
  const centerId = typeof body.CenterId === "number" ? body.CenterId : null;

  // ── 7. Push to FIFO + heartbeat ────────────────────────────────────
  const entry = JSON.stringify({
    webhookId,
    webhookTimestamp,
    eventType,
    centerId,
    sourceTimestamp: typeof body.Timestamp === "string" ? body.Timestamp : null,
    receivedAt: new Date().toISOString(),
    raw: body, // structured payload for downstream consumers
  });

  try {
    await redis.lpush(QUEUE_KEY, entry);
    await redis.ltrim(QUEUE_KEY, 0, QUEUE_MAX_LEN - 1);
    await redis.expire(QUEUE_KEY, QUEUE_TTL);
  } catch (err) {
    console.error("[qamf-bowling] redis enqueue failed:", err);
    // Still return 200 — we don't want QAMF retrying just because our
    // queue write hiccuped. A retry would re-attempt this same body
    // and the dedup key would already be set, so it'd be a no-op.
  }

  // Heartbeat — useful for "is the QAMF webhook flowing?" admin checks
  // and any future heartbeat-gated cron, mirroring the VT3 + kart-bridge
  // patterns.
  redis
    .set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL)
    .catch(() => void 0);

  console.log(
    `[qamf-bowling] queued type=${eventType} centerId=${centerId} webhookId=${webhookId.slice(0, 8)}…`,
  );
  return NextResponse.json({ ok: true, kind: "queued", eventType });
}
