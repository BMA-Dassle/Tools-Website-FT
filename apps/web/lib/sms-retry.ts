import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import { bmiKeyScope } from "@/lib/bmi-key-scope";
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { isQuotaError, isQuotaExhausted, markQuotaExhausted } from "@/lib/sms-quota";
import { twilioSend, isTwilioQuotaError } from "@/lib/twilio-send";
import { decideSend, type SendCategory } from "~/features/sms/suppression-policy";
import { lookupSuppression } from "~/features/sms/suppression-db";
import { withOptOutFooter } from "~/features/sms/footer";

/**
 * SMS retry queue — failed sends get re-attempted on subsequent cron ticks
 * with exponential backoff, up to MAX_ATTEMPTS. Entries that exhaust retries
 * are moved to a dead-letter list for manual review.
 *
 * Redis layout:
 *   sms:retry:pending   SORTED SET  (score = unix-ms retry-after)
 *     member = JSON blob (see RetryEntry)
 *   sms:retry:dead      LIST (LPUSH newest-first), 90-day TTL
 *
 * Flow:
 *   queueRetry(entry)   — called from sendSms on failure
 *   drainRetryQueue(cron, send) — called at the top of each cron fire;
 *     pulls due entries, attempts via `send(phone, body, audit)`, on success
 *     the caller's retry wrapper sets dedup keys; on failure re-queues with
 *     longer backoff or moves to dead.
 */

export type SmsRetryCron =
  | "pre-race-cron"
  | "checkin-cron"
  | "arena-pre-cron"
  | "arena-checkin-cron";

export interface SmsRetryAudit {
  sessionIds: (string | number)[];
  personIds: (string | number)[];
  memberCount: number;
  shortCode?: string;
}

export interface RetryEntry {
  id: string;
  cron: SmsRetryCron;
  phone: string; // canonical +1...
  body: string;
  audit: SmsRetryAudit;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  lastStatus: number | null;
  lastError: string;
  /** Sender DID override (E.164) carried through retries so a
   *  HeadPinz-branded send isn't retried from the FastTrax number.
   *  Absent = default VOX_FROM (back-compat for queued entries). */
  from?: string;
  /** Square/Pandora location the audit ids belong to, carried so a
   *  successful retry rebuilds the SAME location-scoped dedup keys the
   *  main cron scan checks (see bmiKeyScope). Absent = legacy shared-FM
   *  shape (back-compat for queued entries + all FM sends). */
  locationId?: string;
}

const PENDING = "sms:retry:pending";
const DEAD = "sms:retry:dead";
const DEAD_TTL = 60 * 60 * 24 * 90;
const MAX_ATTEMPTS = 3;

/** Exponential-ish backoff: 30s, 2m, 10m for attempts 1..3. */
function backoffMsFor(attempt: number): number {
  if (attempt <= 1) return 30_000;
  if (attempt === 2) return 120_000;
  return 600_000;
}

function newId(): string {
  return randomBytes(6).toString("base64url").slice(0, 10);
}

/**
 * Queue a failed send for retry. Called from sendSms when Voxtelesys
 * returns non-2xx or throws.
 */
export async function queueRetry(params: {
  cron: SmsRetryCron;
  phone: string;
  body: string;
  audit: SmsRetryAudit;
  status: number | null;
  error: string;
  from?: string;
  locationId?: string;
}): Promise<void> {
  try {
    const now = new Date().toISOString();
    const entry: RetryEntry = {
      id: newId(),
      cron: params.cron,
      phone: params.phone,
      body: params.body,
      audit: params.audit,
      attempts: 0,
      firstFailedAt: now,
      lastFailedAt: now,
      lastStatus: params.status,
      lastError: (params.error || "").slice(0, 500),
      ...(params.from ? { from: params.from } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
    };
    const retryAt = Date.now() + backoffMsFor(1);
    await redis.zadd(PENDING, retryAt, JSON.stringify(entry));
  } catch (err) {
    console.error("[sms-retry] queueRetry failed:", err);
  }
}

/**
 * Pull all entries whose retry-after has passed AND that target this cron.
 * Returns them with the raw Redis member string so the caller can remove
 * them on success.
 */
export async function dueRetries(
  cron: SmsRetryCron,
  now = Date.now(),
): Promise<{ raw: string; entry: RetryEntry }[]> {
  const raws = await redis.zrangebyscore(PENDING, 0, now);
  const out: { raw: string; entry: RetryEntry }[] = [];
  for (const r of raws) {
    try {
      const entry = JSON.parse(r) as RetryEntry;
      if (entry.cron === cron) out.push({ raw: r, entry });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/**
 * Remove a pending retry (on success).
 */
export async function removeRetry(raw: string): Promise<void> {
  await redis.zrem(PENDING, raw);
}

/**
 * Re-queue (on another failure) with longer backoff, or move to dead if
 * MAX_ATTEMPTS reached. Returns true if moved to dead.
 */
export async function reQueueOrDead(
  raw: string,
  entry: RetryEntry,
  status: number | null,
  error: string,
): Promise<boolean> {
  await redis.zrem(PENDING, raw);
  const nextAttempts = entry.attempts + 1;
  const updated: RetryEntry = {
    ...entry,
    attempts: nextAttempts,
    lastFailedAt: new Date().toISOString(),
    lastStatus: status,
    lastError: (error || "").slice(0, 500),
  };
  if (nextAttempts >= MAX_ATTEMPTS) {
    await redis.lpush(DEAD, JSON.stringify(updated));
    await redis.expire(DEAD, DEAD_TTL);
    return true;
  }
  const retryAt = Date.now() + backoffMsFor(nextAttempts + 1);
  await redis.zadd(PENDING, retryAt, JSON.stringify(updated));
  return false;
}

/**
 * Count of pending retries across all crons (for dashboards).
 */
export async function pendingCount(): Promise<number> {
  return await redis.zcard(PENDING);
}

export async function listPending(max = 200): Promise<RetryEntry[]> {
  const raws = await redis.zrange(PENDING, 0, max - 1);
  const out: RetryEntry[] = [];
  for (const r of raws) {
    try {
      out.push(JSON.parse(r) as RetryEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function listDead(max = 200): Promise<RetryEntry[]> {
  const raws = await redis.lrange(DEAD, 0, max - 1);
  const out: RetryEntry[] = [];
  for (const r of raws) {
    try {
      out.push(JSON.parse(r) as RetryEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Voxtelesys send — shared by both crons + the sweep so retries don't
 * duplicate the HTTP call.
 *
 * Throttled to MIN_VOX_SPACING_MS between consecutive calls within the same
 * runtime instance, to stay under Voxtelesys's per-second burst cap. This
 * eliminates 429s at the source rather than relying on the retry queue to
 * absorb them. Module-scoped, so every call path (main send, retry drain,
 * sweep) naturally serializes against the same clock.
 */
const MIN_VOX_SPACING_MS = 150;
let lastVoxSendAt = 0;

async function voxThrottle(): Promise<void> {
  const sinceLast = Date.now() - lastVoxSendAt;
  if (sinceLast < MIN_VOX_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_VOX_SPACING_MS - sinceLast));
  }
  lastVoxSendAt = Date.now();
}

export interface VoxSendOpts {
  /**
   * Override the Voxtelesys From number for this message (E.164, e.g. "+12392148353").
   * Falls back to VOX_FROM when omitted. If Voxtelesys rejects the override with
   * 400/403 (DID not owned by our account), we retry once with VOX_FROM and
   * `fallbackPrefix` prepended to the body — so the customer still sees who it's from.
   */
  fromOverride?: string;
  /** Prefix prepended on fallback, e.g. "From Stephanie (direct: 239-214-8357): ". */
  fallbackPrefix?: string;
  /**
   * Why this message is being sent. Drives whether a revocation can be
   * overridden — see `~/features/sms/suppression-policy`.
   *
   * Defaults to `"transactional"`, which HONORS opt-outs. That default is
   * the point: ~40 send sites exist and 30-odd have no consent logic at
   * all, so the safe behavior has to be the one you get by not thinking
   * about it. Only `"otp"` and `"safety"` may reach a suppressed number.
   */
  category?: SendCategory;
  /**
   * Skip the suppression check entirely.
   *
   * Escape hatch for the opt-out CONFIRMATION itself, which by definition
   * texts a number we just suppressed — `64.1200(a)(12)` permits exactly
   * that one message. Not for general use: prefer `category`.
   */
  bypassSuppression?: boolean;
  /**
   * Label for the oversize-footer audit counter, e.g. "pre-race-cron" or
   * "bowling-confirmation". Only used when appending the footer pushes a
   * body into a second segment — it is how we learn WHICH template to
   * shorten. Optional: absent lands the count under "unknown", which is
   * still a signal, just a less useful one.
   */
  auditSource?: string;
  /**
   * Suppress the opt-out footer for this send.
   *
   * For the inbound replies, which carry their own tailored instructions:
   * appending "Reply STOP to opt out" to a message that already says
   * "You're opted out" is nonsense, and `64.1200(a)(12)` makes the
   * confirmation's wording something to keep exact rather than append to.
   */
  skipFooter?: boolean;
}

const VOX_FROM = "+12394819666";

/** Public-facing webhook URL Vox calls when a message changes
 *  delivery state. Built from env so non-prod deployments can point
 *  at a test receiver if needed. */
function voxStatusCallbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
  return `${base}/api/sms-webhook/vox`;
}

async function voxSendOnce(
  toFormatted: string,
  body: string,
  fromNumber: string,
): Promise<{ ok: boolean; status: number | null; error?: string; voxId?: string }> {
  const VOX_API_KEY = process.env.VOX_API_KEY || "";
  if (!VOX_API_KEY) return { ok: false, status: null, error: "VOX_API_KEY missing" };

  await voxThrottle();

  try {
    const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VOX_API_KEY}`,
      },
      // status_callback wires Vox's delivery-receipt webhook to our
      // /api/sms-webhook/vox endpoint. Vox POSTs there when the message
      // moves through `sent` → `delivered` / `undelivered` so the SMS
      // log can show actual handset state instead of the previous
      // "we accepted your request" 200. Schema discovered by probing —
      // Vox requires the callback as an OBJECT with `url` + `method`,
      // not a bare URL string.
      body: JSON.stringify({
        to: toFormatted,
        from: fromNumber,
        body,
        status_callback: { url: voxStatusCallbackUrl(), method: "POST" },
      }),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 500);
      return { ok: false, status: res.status, error: errText };
    }
    // Capture the Vox message id so the webhook can correlate the
    // delivery callback back to our SMS log entry. Best-effort —
    // Vox may shape the response differently across API versions.
    let voxId: string | undefined;
    try {
      const json = (await res.clone().json()) as { id?: string };
      if (typeof json?.id === "string") voxId = json.id;
    } catch {
      /* ignore — older API or non-JSON */
    }
    return { ok: true, status: res.status, voxId };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "network error" };
  }
}

/**
 * Result shape — adds flags so callers can route quota / failover
 * outcomes correctly:
 *
 *   skipped     — we never tried Vox; the cooldown flag is set AND
 *                 Twilio failover also unavailable (or also exhausted).
 *                 Caller should enqueue.
 *   quotaHit    — Vox AND Twilio both returned quota errors. Cooldown
 *                 flag is now set. Caller should enqueue.
 *   provider    — which provider actually delivered the message
 *                 ("vox" | "twilio"). Useful for log audits.
 *   failedOver  — true when Vox returned a quota error and Twilio
 *                 picked it up successfully. ok=true, but the audit
 *                 trail should note the failover.
 *
 * For all other failures the existing retry queue still applies.
 */
export interface VoxSendResult {
  ok: boolean;
  status: number | null;
  error?: string;
  skipped?: boolean;
  quotaHit?: boolean;
  provider?: "vox" | "twilio";
  failedOver?: boolean;
  /** Provider-specific message id. Captured so the SMS log entry
   *  can be correlated with the delivery-receipt webhook callback
   *  (Vox: 24-char hex; Twilio: SMxxxxx). Undefined when the
   *  provider's response didn't include one. */
  voxId?: string;
  twilioSid?: string;
  /** True when the send was blocked by the suppression gate. Distinct
   *  from a delivery failure: there is nothing to retry, and the retry
   *  queue must NOT re-attempt it. */
  suppressed?: boolean;
  /** Which suppression rule applied, for the SMS log. */
  suppressionOutcome?: string;
}

export async function voxSend(
  toFormatted: string,
  body: string,
  opts?: VoxSendOpts,
): Promise<VoxSendResult> {
  // ── Suppression gate ───────────────────────────────────────────────
  // Deliberately the FIRST thing that happens, ahead of the quota
  // cooldown and the Twilio failover. A revoked number must not be
  // reached by any path, and the failover is a path.
  //
  // This single check is why it lives here rather than at the call sites:
  // ~40 senders exist, 30-odd have no consent logic today, and per-site
  // fixes would be 40 edits that still miss the next new sender.
  if (!opts?.bypassSuppression) {
    const category: SendCategory = opts?.category ?? "transactional";
    const canonical = canonicalizePhone(toFormatted);
    if (canonical) {
      const state = await lookupSuppression(canonical);
      const decision = decideSend(category, state);
      if (decision.bypassUsed) {
        // Every bypass is logged. An unlogged bypass cannot be told
        // apart from simply ignoring the revocation.
        console.warn(
          `[voxSend] SUPPRESSION BYPASS (${category}) to ${canonical}: ${decision.reason}`,
        );
      }
      if (!decision.allow) {
        console.log(`[voxSend] blocked to ${canonical}: ${decision.reason}`);
        return {
          ok: false,
          status: null,
          error: `suppressed: ${decision.reason}`,
          suppressed: true,
          suppressionOutcome: decision.outcome,
        };
      }
    }
    // An unparseable recipient falls through to the existing send path,
    // which already rejects it. Suppression is keyed by E.164, so there
    // is nothing to look up and nothing to decide.
  }

  // ── Opt-out footer ─────────────────────────────────────────────────
  // Centralized for the same reason as the gate above: exactly ONE of 25
  // sending files carries a footer today, and per-template edits would be
  // 40 changes that miss the 41st sender.
  //
  // `body` is reassigned so every downstream path — Vox, the Twilio
  // failover, the fromOverride retry — sends the SAME text. An earlier
  // shape that footered only the Vox call would have produced a failover
  // message with no opt-out language, which is the exact case a carrier
  // audit would find.
  const footered = opts?.skipFooter
    ? null
    : withOptOutFooter(body, opts?.category ?? "transactional");
  if (footered) body = footered.body;
  if (footered?.crossedBoundary) {
    // THE AUDIT. Static extraction of ~40 inline template literals would
    // be guesswork; real traffic tells us exactly which bodies the footer
    // pushed into a second segment, and those are the ones to shorten.
    // Segments are money and, on an unvetted TCR brand, daily throughput.
    console.warn(
      `[voxSend] footer pushed body to ${footered.segments} segments ` +
        `(${footered.chars} chars, ${footered.encoding}) — template needs shortening`,
    );
    try {
      const day = new Date().toISOString().slice(0, 10);
      const key = `sms:footer:oversize:${day}`;
      await redis.hincrby(key, opts?.auditSource || "unknown", 1);
      await redis.expire(key, 60 * 60 * 24 * 30);
    } catch {
      /* audit counter is best-effort — never block a send on it */
    }
  }

  // Short-circuit during cooldown — saves a doomed Vox call. Try
  // Twilio directly: if Vox is throttled but Twilio is fine, the
  // customer still gets the SMS in real time.
  if (await isQuotaExhausted()) {
    const tw = await twilioSend(toFormatted, body);
    if (tw.ok) {
      console.log("[voxSend] cooldown active, delivered via Twilio failover");
      return { ok: true, status: tw.status, provider: "twilio", failedOver: true };
    }
    return {
      ok: false,
      status: tw.status ?? 429,
      error: `cooldown + twilio failed: ${tw.error || "unknown"}`,
      skipped: true,
      provider: "twilio",
    };
  }

  const from = opts?.fromOverride || VOX_FROM;
  let result = await voxSendOnce(toFormatted, body, from);

  // If we tried with an override and Voxtelesys rejected it (likely DID not owned),
  // degrade to default VOX_FROM and prepend a "From {planner}" prefix so the
  // customer still knows who's texting. Warn loudly — a permanently
  // misconfigured DID (e.g. the Naples number not provisioned on the SMS
  // trunk) would otherwise be invisible: sends log ok=true while guests
  // text back a number that never answers.
  if (!result.ok && opts?.fromOverride && (result.status === 400 || result.status === 403)) {
    console.warn(
      `[voxSend] Vox rejected fromOverride ${opts.fromOverride} (${result.status}) — falling back to ${VOX_FROM}. If this repeats, the DID is misconfigured.`,
    );
    const prefix = opts.fallbackPrefix || `(From ${opts.fromOverride}) `;
    const fallbackBody = prefix + body;
    result = await voxSendOnce(toFormatted, fallbackBody, VOX_FROM);
  }

  // Vox quota / daily-limit hit — try Twilio failover BEFORE marking
  // the cooldown. If Twilio succeeds we still mark cooldown (so future
  // voxSends skip Vox for the next hour and go straight to Twilio
  // first), but the current send goes through immediately.
  if (!result.ok && isQuotaError(result.status, result.error || "")) {
    console.warn(`[voxSend] Vox quota error (${result.status}); attempting Twilio failover`);
    const tw = await twilioSend(toFormatted, body);
    if (tw.ok) {
      // Mark cooldown so subsequent calls in the next hour go straight
      // to Twilio (one less doomed Vox call per send).
      await markQuotaExhausted(result.status, result.error || "");
      return { ok: true, status: tw.status, provider: "twilio", failedOver: true };
    }
    // Twilio also unavailable / quota'd — caller queues.
    await markQuotaExhausted(result.status, result.error || "");
    const twFailDetail = isTwilioQuotaError(tw.status, tw.error || "")
      ? `twilio also quota'd (${tw.status})`
      : `twilio failed (${tw.status}: ${tw.error || "unknown"})`;
    return {
      ...result,
      quotaHit: true,
      error: `${result.error || ""} | ${twFailDetail}`,
      provider: "vox",
    };
  }

  return { ...result, provider: "vox" };
}

/**
 * Drain pending retries for a given cron. On success sets the cron's dedup
 * keys for every (sessionId, personId) the SMS covered. Used by both the
 * main cron handlers and the dedicated retry-sweep cron — sweep runs every
 * minute so 5-minute pre-race gaps don't strand retries.
 */
export async function drainRetries(cron: SmsRetryCron): Promise<{
  attempted: number;
  ok: number;
  requeued: number;
  dead: number;
  quotaQueued: number;
  expired: number;
  /** Dropped because the recipient revoked consent. Terminal, never
   *  retried, and counted apart from `dead` so a suppression is not
   *  mistaken for a delivery fault in the cron's own reporting. */
  suppressed: number;
}> {
  const DEDUP: Record<SmsRetryCron, { prefix: string; ttl: number }> = {
    "pre-race-cron": { prefix: "alert:pre-race", ttl: 60 * 60 * 24 },
    "checkin-cron": { prefix: "alert:checkin", ttl: 60 * 60 * 6 },
    "arena-pre-cron": { prefix: "alert:arena-pre", ttl: 60 * 60 * 24 },
    "arena-checkin-cron": { prefix: "alert:arena-checkin", ttl: 60 * 60 * 6 },
  };
  const { prefix, ttl: dedupTtl } = DEDUP[cron];

  // Every retry-queue entry IS an e-ticket send (the cron union above is
  // the whole rail), so the quiet-hours guarantee gates the entire drain:
  // held entries stay queued for the overnight clear to purge/audit.
  const { inEticketQuietHours, maxQueueAgeMs, ETICKET_EXPIRED_ERROR } =
    await import("~/features/eticket/quiet-hours");
  if (inEticketQuietHours()) {
    return { attempted: 0, ok: 0, requeued: 0, dead: 0, quotaQueued: 0, expired: 0, suppressed: 0 };
  }

  const { quotaEnqueue } = await import("@/lib/sms-quota");
  const due = await dueRetries(cron);
  let ok = 0,
    requeued = 0,
    dead = 0,
    quotaQueued = 0,
    expired = 0,
    suppressedCount = 0;
  for (const { raw, entry } of due) {
    const toFormatted = canonicalizePhone(entry.phone);
    if (!toFormatted) {
      await removeRetry(raw);
      continue;
    }
    const ts = new Date().toISOString();
    // Stale guard — a queued e-ticket whose session has long since
    // started is wrong to deliver even in business hours (e.g. held
    // overnight because the clear cron missed it, or a long quota hold).
    const ageMs = Date.now() - new Date(entry.firstFailedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > maxQueueAgeMs(cron)) {
      await removeRetry(raw);
      await logSms({
        ts,
        phone: toFormatted,
        source: cron,
        status: null,
        ok: false,
        error: ETICKET_EXPIRED_ERROR,
        body: entry.body,
        sessionIds: entry.audit.sessionIds,
        personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount,
        shortCode: entry.audit.shortCode,
      });
      expired++;
      continue;
    }
    const result = await voxSend(
      toFormatted,
      entry.body,
      entry.from ? { fromOverride: entry.from } : undefined,
    );
    if (result.ok) {
      await removeRetry(raw);
      await logSms({
        ts,
        phone: toFormatted,
        source: cron,
        status: result.status,
        ok: true,
        body: entry.body,
        sessionIds: entry.audit.sessionIds,
        personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount,
        shortCode: entry.audit.shortCode,
        provider: result.provider,
        failedOver: result.failedOver,
      });
      // Location-scoped exactly like the main cron scans write them —
      // an unscoped rebuild here would leave a Naples send invisible to
      // the Naples scan (double-send on the next tick).
      const scope = bmiKeyScope(entry.locationId);
      for (const sid of entry.audit.sessionIds) {
        for (const pid of entry.audit.personIds) {
          await redis.set(`${prefix}:${scope}${sid}:${pid}`, "1", "EX", dedupTtl);
        }
      }
      ok++;
    } else if (result.skipped || result.quotaHit) {
      // Quota exhausted — move to the long-lived quota queue instead of
      // burning attempts on the standard retry queue. The standard queue's
      // 3-attempt × 10-min-max-backoff would dead-letter every entry well
      // before the daily cap reset.
      await removeRetry(raw);
      await quotaEnqueue({
        phone: toFormatted,
        body: entry.body,
        source: cron,
        // Preserve the ORIGINAL failure time, not the move time — the
        // quota drain's staleness triage measures age from queuedAt, and
        // the ~12.5 min the retry rail can hold an entry must not
        // silently widen a check-in alert's 30-minute budget.
        queuedAt: entry.firstFailedAt,
        shortCode: entry.audit.shortCode,
        ...(entry.from ? { from: entry.from } : {}),
        ...(entry.locationId ? { locationId: entry.locationId } : {}),
        audit: {
          sessionIds: entry.audit.sessionIds,
          personIds: entry.audit.personIds,
          memberCount: entry.audit.memberCount,
        },
      });
      await logSms({
        ts,
        phone: toFormatted,
        source: cron,
        status: result.status,
        ok: false,
        error: `[quota] queued for next reset window (${result.error || "429"})`,
        body: entry.body,
        sessionIds: entry.audit.sessionIds,
        personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount,
        shortCode: entry.audit.shortCode,
      });
      quotaQueued++;
    } else if (result.suppressed) {
      // Terminal, not a failure. The guest revoked consent — retrying
      // three times and then dead-lettering would burn attempts and
      // leave an entry that reads like a delivery fault. Drop it and
      // record why, so the e-ticket rail's own numbers stay honest.
      await removeRetry(raw);
      await logSms({
        ts,
        phone: toFormatted,
        source: cron,
        status: null,
        ok: false,
        error: `[suppressed] ${result.error}`,
        body: entry.body,
        sessionIds: entry.audit.sessionIds,
        personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount,
        shortCode: entry.audit.shortCode,
      });
      suppressedCount++;
    } else {
      await logSms({
        ts,
        phone: toFormatted,
        source: cron,
        status: result.status,
        ok: false,
        error: `[retry attempt ${entry.attempts + 1}] ${result.error}`,
        body: entry.body,
        sessionIds: entry.audit.sessionIds,
        personIds: entry.audit.personIds,
        memberCount: entry.audit.memberCount,
        shortCode: entry.audit.shortCode,
      });
      const movedToDead = await reQueueOrDead(raw, entry, result.status, result.error || "");
      if (movedToDead) dead++;
      else requeued++;
    }
  }
  return {
    attempted: due.length,
    ok,
    requeued,
    dead,
    quotaQueued,
    expired,
    suppressed: suppressedCount,
  };
}

/**
 * Remove every pending retry matching `predicate` (regardless of its
 * retry-after), returning the removed entries so the caller can audit
 * them. Used by the overnight clear — queued e-tickets must not survive
 * into the next business day.
 */
export async function purgeRetries(predicate: (e: RetryEntry) => boolean): Promise<RetryEntry[]> {
  const raws = await redis.zrange(PENDING, 0, -1);
  const removed: RetryEntry[] = [];
  for (const raw of raws) {
    let entry: RetryEntry;
    try {
      entry = JSON.parse(raw) as RetryEntry;
    } catch {
      continue; // corrupt entries are skipped by dueRetries already
    }
    if (!predicate(entry)) continue;
    const n = await redis.zrem(PENDING, raw);
    if (n > 0) removed.push(entry);
  }
  return removed;
}
