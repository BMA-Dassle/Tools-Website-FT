/**
 * Voxtelesys inbound (MO) payload.
 *
 * Shape VERIFIED from a live capture on 2026-08-19, not inferred:
 *
 *   {
 *     "channel": "messaging",
 *     "type": "mo",
 *     "api_version": "2025-02-01",
 *     "id": "6a8654c7ff2145b4ffe2f2c6",
 *     "to": "+12394412867",
 *     "from": "+12397762044",
 *     "body": "Start ",
 *     "received_at": "2026-08-20T01:13:42.000Z"
 *   }
 *
 * Notes that shape the code below:
 *
 *  - There is NO `status` field. That is what makes an MO die harmlessly
 *    at the DR route's first guard (`../../../app/api/sms-webhook/vox/route.ts`),
 *    and it is the cheapest way to tell the two apart: `type === "mo"`.
 *  - `from` and `to` arrive already E.164, so no reformatting is needed —
 *    but we still canonicalize, because trusting a vendor's formatting
 *    forever is how the DR route ended up accepting both `id` and
 *    `message_id`.
 *  - `id` is a 24-char hex string. It is the idempotency key: Vox retries
 *    a non-2xx up to ~5 times, and `64.1200(a)(12)` allows EXACTLY ONE
 *    opt-out confirmation, so the same `id` must never be actioned twice.
 *  - Field names are read defensively (`body` OR `text`, `from` OR
 *    `source`). One capture proves what Vox sends today, not what it will
 *    send after their next version bump.
 */

import { canonicalizePhone } from "@/lib/participant-contact";

export interface MoPayload {
  /** Vox message id — the idempotency key. */
  id: string;
  /** Guest's number, E.164. The ONLY trustworthy subject of an opt-out:
   *  never take the subject from a request body field, or a forged `from`
   *  could unsubscribe a third party. */
  from: string;
  /** Our DID that received it, E.164. Must be one of ours. */
  to: string;
  /** Raw message text, EXACTLY as sent — no trimming here. Normalization
   *  belongs to the classifier, which has to reason about the difference
   *  between "STOP" and "STOP " to apply T-Mobile CoC § 2.11. */
  body: string;
  /** Vox's receive timestamp when present, else null. */
  receivedAt: string | null;
  apiVersion: string | null;
}

export type MoParseResult = { ok: true; payload: MoPayload } | { ok: false; reason: string };

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * Parse a raw request body into a validated MO payload.
 *
 * Rejects rather than guesses. A rejection is not an error to retry — the
 * caller should still answer 200 and record the rejection, because a
 * shape we do not understand will not start being understood on attempt
 * four.
 *
 * `allowedRecipients` is the set of DIDs we accept traffic for. Passing an
 * empty set disables the check (bring-up), which is why the caller, not
 * this function, decides the default.
 */
export function parseMoPayload(raw: unknown, allowedRecipients: string[] = []): MoParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "body is not an object" };
  }
  const o = raw as Record<string, unknown>;

  // Delivery receipts carry `status` and no `type: "mo"`. If one reaches
  // this route the portal config crossed the two webhook URLs, which is a
  // config bug worth naming rather than silently ignoring.
  const type = firstString(o.type);
  if (type !== null && type.toLowerCase() !== "mo") {
    return { ok: false, reason: `not an inbound message (type=${type})` };
  }
  if (type === null && typeof o.status === "string") {
    return { ok: false, reason: "looks like a delivery receipt, not an MO" };
  }

  const id = firstString(o.id, o.message_id, o.messageId);
  if (!id) return { ok: false, reason: "missing message id" };

  const fromRaw = firstString(o.from, o.source, o.sender);
  if (!fromRaw) return { ok: false, reason: "missing sender" };
  const from = canonicalizePhone(fromRaw);
  if (!from) return { ok: false, reason: `unparseable sender (${fromRaw})` };

  const toRaw = firstString(o.to, o.destination, o.recipient);
  if (!toRaw) return { ok: false, reason: "missing recipient" };
  const to = canonicalizePhone(toRaw);
  if (!to) return { ok: false, reason: `unparseable recipient (${toRaw})` };

  if (allowedRecipients.length > 0) {
    const allowed = allowedRecipients
      .map((d) => canonicalizePhone(d))
      .filter((d): d is string => !!d);
    if (!allowed.includes(to)) {
      return { ok: false, reason: `recipient ${to} is not one of our DIDs` };
    }
  }

  // An empty body is legitimate — a guest can send whitespace, or an MMS
  // with no text. It classifies as unhandled rather than being rejected.
  const body = firstString(o.body, o.text, o.message) ?? "";

  return {
    ok: true,
    payload: {
      id,
      from,
      to,
      body,
      receivedAt: firstString(o.received_at, o.receivedAt, o.time),
      apiVersion: firstString(o.api_version, o.apiVersion),
    },
  };
}
