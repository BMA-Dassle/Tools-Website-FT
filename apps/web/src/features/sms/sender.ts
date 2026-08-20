/**
 * The one A2P sender.
 *
 * Every AUTOMATED outbound message goes from this number. Before this,
 * three DIDs carried automated traffic — `+12394819666` (FastTrax),
 * `+12393022155` (HeadPinz FM) and `+12394553755` (Naples) — hardcoded
 * across a dozen files, which caused two distinct problems:
 *
 *  1. Two of those three are CONTRACTUALLY PUBLISHED as the human SMS
 *     contact for cancellations, in the policy guests tick at checkout
 *     (`components/booking/ClickwrapCheckbox.tsx`). So a guest texting
 *     "cancel my 4pm" to a number that also blasts e-tickets is talking
 *     to a human and a keyword matcher at the same time — and CANCEL is a
 *     mandatory CTIA opt-out keyword. Automated keyword handling could
 *     never run there.
 *  2. Nobody could see the mapping, so it drifted. FastTrax bowling
 *     confirmations were going out from the HeadPinz DID.
 *
 * Moving automated traffic here makes the A2P/P2P split structural: the
 * call-center DIDs stay on their own Voxtelesys Messaging Application
 * pointed at 3CX, and our inbound handler is attached only to this
 * number. The collision becomes impossible rather than merely avoided.
 *
 * ── A shared sender across brands is fine ───────────────────────────
 *
 * Every template already opens with the brand ("FastTrax: …",
 * "HeadPinz: …"), which is also what TCR requires in HELP and opt-out
 * replies. So one sender stays unambiguous to the guest, and a large
 * amount of brand-to-DID mapping code goes away.
 *
 * ── What must NOT move here ─────────────────────────────────────────
 *
 *  - The three planner personal DIDs (`lib/sales-lead-config.ts`) and
 *    `guestServicesPhone`. Human P2P outreach, expressly requested by the
 *    guest, and out of scope by owner decision.
 *  - Every `tel:` link and displayed phone number. Those are what guests
 *    CALL, two of them are in the cancellation policy, and changing them
 *    would break a contractual commitment.
 *  - `phone` fields that sit next to a `smsFrom` in the same config
 *    object. They are display strings; only the sender moves.
 */

/** Voxtelesys DID on the FastTraxEnt.com Messaging Application, whose MO
 *  webhook points at `/api/sms-webhook/vox/inbound`. Voice routes to 3CX,
 *  which Fla. Stat. § 501.059(8)(b) effectively wants — a number shown on
 *  caller ID has to accept calls and reach a human. */
const DEFAULT_A2P_DID = "+12394412867";

/**
 * The sender for all automated SMS.
 *
 * `SMS_A2P_DID` overrides at runtime, so re-pointing the program at a
 * different DID is an env change rather than a deploy. Read per call
 * rather than captured at module load: a module-level constant would bake
 * the value into the serverless bundle and make the override a
 * did-you-redeploy exercise.
 */
export function a2pSender(): string {
  const raw = (process.env.SMS_A2P_DID || "").split(",")[0]?.trim();
  return raw || DEFAULT_A2P_DID;
}

/** Every DID we accept INBOUND traffic for. Comma-separated env, so the
 *  number can be rotated with an overlap window where replies to both the
 *  old and new sender are still honored. */
export function inboundDids(): string[] {
  const fromEnv = (process.env.SMS_A2P_DID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [DEFAULT_A2P_DID];
}
