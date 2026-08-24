/**
 * Booking-blocks service — the gate every deposit-taking path calls.
 *
 * Owner decision 2026-08-24: block at EVERY deposit-taking path (web booking,
 * kiosk booking, and return-racer sign-in on both), not just return-racer, so a
 * banned party cannot simply re-book as a brand-new guest.
 *
 * FAIL-OPEN, deliberately. If the block lookup itself errors, the sale proceeds
 * and we log loudly. A block list exists to stop repeat chargeback abusers; it is
 * not a security control, and taking all of checkout down because one SELECT
 * failed would cost far more than the abuse it prevents. The BMI person notes and
 * the manager conversation are the backstop.
 */
import { findActiveBlocks } from "./data";
import type { BlockCandidate, BlockDecision, BookingBlockRow } from "./types";

/** Guest-facing copy. Deliberately says nothing about disputes or chargebacks —
 *  the reason belongs in a manager conversation, not on a public screen. The
 *  number is the one on our accepted cancellation/payment policy. */
export const BLOCK_CALL_CENTER = "(239) 481-9666";
export const BLOCK_GUEST_MESSAGE_EN = `Account Disabled. Please contact our call center at ${BLOCK_CALL_CENTER} to continue.`;
export const BLOCK_GUEST_MESSAGE_ES = `Cuenta desactivada. Comunícate con nuestro centro de atención al ${BLOCK_CALL_CENTER} para continuar.`;

/** Stable error code so routes and clients can branch without string matching. */
export const BLOCK_ERROR_CODE = "ACCOUNT_DISABLED";

/**
 * Is this identity blocked? Never throws.
 *
 * @param candidate every identity the surface knows — pass all of it; matching is
 *   per-field, so a party that changes email is still caught on phone or card.
 */
export async function checkBookingBlock(candidate: BlockCandidate): Promise<BlockDecision> {
  let matches: BookingBlockRow[];
  try {
    matches = await findActiveBlocks(candidate);
  } catch (err) {
    // Fail open — but make it impossible to miss in logs.
    console.error("[booking-blocks] lookup FAILED, allowing the sale:", err);
    return { blocked: false };
  }
  if (matches.length === 0) return { blocked: false };

  const kinds = [...new Set(matches.map((m) => m.kind))];
  // No PII in the log line — kinds and row ids only.
  console.warn(
    `[booking-blocks] BLOCKED: matched ${matches.length} row(s) on ${kinds.join(", ")} ` +
      `(rows ${matches.map((m) => m.id).join(",")})`,
  );
  return { blocked: true, matches, kinds };
}

/** The staff-facing detail for a blocked attempt — safe for admin logs and the
 *  manager screen, never for the guest response body. */
export function blockStaffSummary(decision: BlockDecision): string | null {
  if (!decision.blocked) return null;
  return decision.matches
    .map(
      (m) =>
        `#${m.id} ${m.kind}${m.center ? `@${m.center}` : ""} — ${m.reason}` +
        `${m.caseRef ? ` [${m.caseRef}]` : ""} (by ${m.submittedBy} ${m.createdAt.slice(0, 10)})`,
    )
    .join(" | ");
}

/**
 * The JSON body every blocked route returns. HTTP 403.
 *
 * `error` carries the HUMAN message, not the code: the booking client renders
 * `data.error` straight to the guest (`throw new Error(data.error)` in
 * features/booking/service/checkout.ts), so putting the code there would show a
 * guest the literal string "ACCOUNT_DISABLED". The code lives in `code`, which
 * is what callers should branch on.
 */
export function blockResponseBody(locale: "en" | "es" = "en") {
  const message = locale === "es" ? BLOCK_GUEST_MESSAGE_ES : BLOCK_GUEST_MESSAGE_EN;
  return {
    error: message,
    message,
    code: BLOCK_ERROR_CODE,
    phone: BLOCK_CALL_CENTER,
  };
}
