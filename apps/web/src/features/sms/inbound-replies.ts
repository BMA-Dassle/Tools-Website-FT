import { assertGsm7Safe } from "~/features/marketing/templates";

/**
 * The three replies this program is allowed to send inbound.
 *
 * ── Exactly one confirmation, and it must CONFIRM ───────────────────
 *
 * `64.1200(a)(12)` permits a single confirmation of an opt-out and no
 * more. It must not contain marketing, and it must not ask the guest to
 * take further action to complete the revocation — asking "are you sure?"
 * implies the revocation has not taken effect, when in fact it is
 * effective on receipt. TCR reject 30887 additionally wants the ack to
 * name the brand and state that no further messages will be sent.
 *
 * So these confirm, state the consequence, and offer the way back. They
 * never negotiate.
 *
 * ── What the opt-out reply must NOT say ─────────────────────────────
 *
 * Not "you won't be able to enter the race." That is false — a guest can
 * always check in at Guest Services — and framing entry as contingent on
 * keeping texts on conditions service on consent, which we cannot do
 * because we cannot decline to honor a revocation. Stating a consequence
 * AND an alternative is disclosure; stating a consequence alone is a
 * threat.
 *
 * The copy says Guest Services rather than "we'll email it instead"
 * deliberately: no email failover exists yet, and a reply that promises
 * one would be a lie in the one message we are allowed to send. When the
 * failover ships, this copy changes with it.
 *
 * Every string is GSM-7 asserted and pinned to one segment by tests. A
 * two-segment compliance reply is not a violation, but it is careless in
 * the one message where the wording has been thought about hardest.
 */

/** Brand prefix. Both brands, because one A2P sender carries both and we
 *  cannot know from a phone number alone which one the guest booked. */
const BRAND = "FastTrax/HeadPinz";

/**
 * Human-reachable support number shown in replies.
 *
 * `+12394819666` is the published contact in the cancellation policy that
 * guests accept at checkout, so it is the number they have already been
 * told to use. Overridable without a deploy.
 *
 * NOTE: this is intentionally NOT the A2P sender. The A2P number's voice
 * path goes to 3CX, which is fine, but the number a compliance reply
 * points at should be the one we have contractually published.
 */
function supportNumber(): string {
  return process.env.SMS_SUPPORT_NUMBER || "239-481-9666";
}

/**
 * Opt-out confirmation. The one message `(a)(12)` allows.
 *
 * Names the brand (TCR 30887), states plainly that the texts stop, gives
 * the alternative that keeps the guest admitted, and shows the way back.
 */
export function optOutConfirmation(): string {
  const body =
    `${BRAND}: You're opted out. No more e-tickets or check-in texts. ` +
    `Check in at Guest Services with photo ID. ` +
    `Reply START to resume. Help: ${supportNumber()}`;
  assertGsm7Safe(body, "sms_opt_out_confirmation");
  return body;
}

/**
 * Opt-in confirmation, for START / UNSTOP / RESUME.
 *
 * Carries its own STOP instruction so the guest is never in a state where
 * they have re-subscribed and been given no way back out.
 */
export function optInConfirmation(): string {
  const body =
    `${BRAND}: You're back on. We'll text your e-tickets and check-in ` +
    `updates again. Reply STOP to opt out anytime.`;
  assertGsm7Safe(body, "sms_opt_in_confirmation");
  return body;
}

/**
 * HELP reply.
 *
 * TCR reject 30890 requires brand name plus a phone or email. Also names
 * what the program actually sends, and repeats STOP — a guest texting
 * HELP is frequently a guest trying to work out how to make it stop.
 */
export function helpReply(): string {
  const body =
    `${BRAND}: We text race e-tickets & check-in alerts. ` +
    `Help: ${supportNumber()}. Reply STOP to opt out. ` +
    `Msg & data rates may apply.`;
  assertGsm7Safe(body, "sms_help_reply");
  return body;
}
