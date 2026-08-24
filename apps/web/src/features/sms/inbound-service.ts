import { classifyInbound } from "./inbound-keywords";
import { optOutConfirmation, optInConfirmation, helpReply } from "./inbound-replies";
import type { MoPayload } from "./mo-payload";
import type { ReviewItem } from "./review-queue";

/**
 * What to do about one inbound message.
 *
 * Effects are injected rather than imported so the compliance rules —
 * "exactly one confirmation", "a repeat STOP does not re-reply", "a
 * retried callback does nothing twice" — are provable by unit test
 * instead of only observable in production against a live carrier.
 *
 * ── The ordering that matters ───────────────────────────────────────
 *
 * The consent write happens BEFORE the reply, always. If the write
 * succeeds and the send fails, the guest is suppressed and did not get a
 * courtesy message: annoying, compliant. If the send went first and the
 * write failed, the guest holds a text saying "you're opted out" while we
 * carry on texting them — a written admission attached to a live
 * violation. The failure modes are not symmetric, so the order is not
 * arbitrary.
 *
 * ── Why the reply is gated on `firstTime` ───────────────────────────
 *
 * `64.1200(a)(12)` allows exactly ONE confirmation. A guest who texts
 * STOP three times, or a Vox callback retried five times, must not
 * produce five confirmations. `recordConsentEvent` reports whether the
 * state actually changed; only a genuine transition earns a reply.
 */

export interface InboundEffects {
  /** Append to the consent ledger. Returns `firstTime: false` when this
   *  did not change state (repeat STOP), and `recorded: false` when the
   *  provider message id was already written (retried callback). */
  recordConsent: (input: {
    phoneE164: string;
    action: "opt_in" | "opt_out";
    channel: "sms";
    source: string;
    reason?: string | null;
    providerMessageId?: string | null;
  }) => Promise<{ recorded: boolean; firstTime: boolean }>;
  /** Send a reply. Must bypass suppression — by definition we are texting
   *  a number we may have just suppressed, which is the one message
   *  `(a)(12)` permits. */
  sendReply: (phoneE164: string, body: string) => Promise<{ ok: boolean }>;
  /** Park a message for a human. */
  enqueueReview: (item: ReviewItem) => Promise<{ added: boolean }>;
}

export type InboundOutcome =
  | "opted_out"
  | "opted_out_repeat"
  | "opted_in"
  | "opted_in_repeat"
  | "helped"
  | "queued_for_review"
  | "duplicate_callback";

export interface InboundResult {
  outcome: InboundOutcome;
  /** True when a reply actually went out. */
  replied: boolean;
  /** Set when the reply was attempted and failed — the consent write
   *  still stands, which is the safe half. */
  replyFailed?: boolean;
  detail: string;
}

export async function handleInbound(
  payload: MoPayload,
  effects: InboundEffects,
): Promise<InboundResult> {
  const classification = classifyInbound(payload.body);
  const phone = payload.from;

  if (classification.action === "opt_out") {
    // Ledger FIRST. See the ordering note above.
    const rec = await effects.recordConsent({
      phoneE164: phone,
      action: "opt_out",
      channel: "sms",
      source: "inbound_sms_stop",
      reason: `keyword: ${classification.matched ?? "stop"}`,
      providerMessageId: payload.id,
    });

    if (!rec.recorded) {
      // Same Vox message id already processed — a retried callback.
      // Silence is the correct response; replying again would be a
      // second confirmation.
      return {
        outcome: "duplicate_callback",
        replied: false,
        detail: `already processed message ${payload.id}`,
      };
    }

    if (!rec.firstTime) {
      // Already suppressed. Honor it again silently: (a)(12) is one
      // confirmation per revocation, not one per message received.
      return {
        outcome: "opted_out_repeat",
        replied: false,
        detail: "already suppressed; no second confirmation",
      };
    }

    const sent = await effects.sendReply(phone, optOutConfirmation());
    return {
      outcome: "opted_out",
      replied: sent.ok,
      ...(sent.ok ? {} : { replyFailed: true }),
      detail: sent.ok
        ? "suppressed and confirmed"
        : "suppressed; confirmation failed to send (suppression stands)",
    };
  }

  if (classification.action === "opt_in") {
    const rec = await effects.recordConsent({
      phoneE164: phone,
      action: "opt_in",
      channel: "sms",
      source: "inbound_sms_start",
      reason: `keyword: ${classification.matched ?? "start"}`,
      providerMessageId: payload.id,
    });

    if (!rec.recorded) {
      return {
        outcome: "duplicate_callback",
        replied: false,
        detail: `already processed message ${payload.id}`,
      };
    }
    if (!rec.firstTime) {
      // Never suppressed in the first place. Still reply — a guest who
      // texts START and hears nothing reasonably concludes it failed,
      // and confirming a no-op costs one message with no legal weight.
      const sent = await effects.sendReply(phone, optInConfirmation());
      return {
        outcome: "opted_in_repeat",
        replied: sent.ok,
        detail: "was not suppressed; confirmed anyway",
      };
    }
    const sent = await effects.sendReply(phone, optInConfirmation());
    return {
      outcome: "opted_in",
      replied: sent.ok,
      ...(sent.ok ? {} : { replyFailed: true }),
      detail: "un-suppressed and confirmed",
    };
  }

  if (classification.action === "help") {
    const sent = await effects.sendReply(phone, helpReply());
    return {
      outcome: "helped",
      replied: sent.ok,
      ...(sent.ok ? {} : { replyFailed: true }),
      detail: "sent HELP reply",
    };
  }

  // Everything the matcher would not decide. NOT auto-actioned, NOT
  // dropped — parked where a human closes the loop.
  await effects.enqueueReview({
    id: payload.id,
    receivedAt: payload.receivedAt ?? new Date().toISOString(),
    phoneE164: phone,
    body: payload.body,
    action: classification.action,
    reviewReason: classification.reviewReason,
    priority: classification.priority,
    matched: classification.matched,
  });
  return {
    outcome: "queued_for_review",
    replied: false,
    detail: `${classification.reviewReason ?? "review"} (${classification.priority})`,
  };
}
