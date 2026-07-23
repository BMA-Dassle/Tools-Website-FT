/**
 * Card consolidation — CLOUD ONLY. Move the ENTIRE balance of a source card onto
 * a target card in ONE atomic server-side call (TPI_ConsolidateAccounts) via the
 * cloud SOAP TPI service. There is no bridge path: consolidation is only offered
 * on kiosks running against the cloud (KioskGameZone gates the mode on
 * `bridgeUp===false`).
 *
 * The kiosk holds only ONE card at a time, so it calls this once per source:
 *   read target (kiosk) → for each source: accept → POST here → bin on ok.
 *
 * WHY ATOMIC (not credit-then-clear): the server moves EVERY value field (cash,
 * bonus cash, tokens, bonus tokens, points, time) in one transaction, so no
 * field is ever dropped and there is no window where value sits nowhere. We do
 * NOT enumerate the amounts, and there is NO separate, unguarded clear step (the
 * source is drained by the same call).
 *
 * MONEY-SAFETY:
 *  - Idempotent on a stable tpiTransactionID — a retry with the SAME id returns 0
 *    without re-applying, so an ambiguous call is safe to re-attempt once.
 *  - done (code 0)    → value is on the target, source drained → the kiosk bins it.
 *  - declined (non-0) → nothing moved, source keeps its value → the kiosk returns it.
 *  - unknown (both attempts threw) → the move is all-or-nothing (atomic), so the
 *    value is EITHER fully on the target (source now empty) OR fully on the source
 *    (nothing moved). Either way, returning the source to the guest loses nothing
 *    and duplicates nothing — so the kiosk returns it and flags staff, and we
 *    NEVER bin an unconfirmed source.
 *
 * Account numbers are bigint strings end-to-end — never Number() them.
 */
import { randomUUID } from "node:crypto";
import { getCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { ConsolidateInput } from "../schemas";
import type { CardBalance } from "../types";
import { verifyAccount, consolidateAccounts, IntercardError } from "../data/intercard";
import { logConsolidation } from "../data/consolidations-log";

export interface ConsolidateResult {
  /** true = value is on the target and the source may be binned. */
  ok: boolean;
  outcome: "done" | "declined" | "unknown";
  /** The source's pre-move balance (display/audit; token-family only, the read
   *  is cash-blind — the actual move covers every field server-side). */
  moved: { tokens: number; bonusTokens: number; points: number; minutes: number };
  /** Target balance re-read after the move (display). */
  targetBalance?: CardBalance;
  message?: string;
}

const ZERO: CardBalance = { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 };

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  if (input.sourceAccount === input.targetAccount) {
    throw new GameCardHttpError(400, "SAME_CARD", "A card can't be combined onto itself.");
  }

  // Both cards must exist. Read the source balance for display/audit (the MOVE is
  // server-authoritative and covers every field, incl. ones the read can't see).
  const [src, tgt] = await Promise.all([
    verifyAccount(input.sourceAccount, input.locationCode).catch(mapVerifyError),
    verifyAccount(input.targetAccount, input.locationCode).catch(mapVerifyError),
  ]);
  if (!tgt.exists)
    throw new GameCardHttpError(404, "TARGET_NOT_FOUND", "That target card isn't in the system.");
  if (!src.exists)
    throw new GameCardHttpError(404, "SOURCE_NOT_FOUND", "That card isn't in the system.");

  const b = src.balance ?? ZERO;
  const moved = {
    tokens: b.tokens,
    bonusTokens: b.bonusTokens,
    points: b.eTickets,
    minutes: b.timeMinutes,
  };
  // Stable id: dedups server-side, so a retry after an ambiguous call never
  // double-applies. One id per source move.
  const tpiTransactionID = randomUUID();

  // Atomic move: ALL value from the source onto the target in one call. We do
  // NOT gate on a computed "has value" — the balance read is cash-blind, so a
  // cash-only card would look empty; letting the server move whatever's there is
  // what keeps every field (the fix for the old credit-then-clear cash drop).
  const outcome = await consolidateWithRetry({
    locationCode: input.locationCode,
    targetAccount: input.targetAccount,
    sourceAccounts: [input.sourceAccount],
    tpiTransactionID,
  });

  if (outcome === "unknown") {
    await logConsolidation({
      id: tpiTransactionID,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "unknown",
      description: "consolidate ambiguous — source returned to guest, not binned",
    });
    return {
      ok: false,
      outcome: "unknown",
      moved,
      message: "We couldn't confirm the combine — your card is back. Please see an attendant.",
    };
  }
  if (outcome !== 0) {
    await logConsolidation({
      id: tpiTransactionID,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "declined",
      code: String(outcome),
    });
    return {
      ok: false,
      outcome: "declined",
      moved,
      message: "That card couldn't be combined — please try again or see an attendant.",
    };
  }

  // Success — value is on the target, source drained. Re-read the target for
  // the combined balance to show the guest.
  const targetBalance = (
    await verifyAccount(input.targetAccount, input.locationCode).catch(() => null)
  )?.balance;

  await logConsolidation({
    id: tpiTransactionID,
    locationCode: input.locationCode,
    sourceAccount: input.sourceAccount,
    targetAccount: input.targetAccount,
    preTokens: b.tokens,
    preBonusTokens: b.bonusTokens,
    outcome: "done",
  });

  return { ok: true, outcome: "done", moved, targetBalance };
}

/** verifyAccount throws IntercardError on infra trouble; surface as a 503 so the
 *  kiosk shows "try again," never as a silent "card not found" (which could bin
 *  a card whose value we failed to read). */
function mapVerifyError(err: unknown): never {
  if (err instanceof IntercardError) {
    throw new GameCardHttpError(
      503,
      "VERIFY_UNAVAILABLE",
      "We couldn't read that card right now. Please try again.",
    );
  }
  throw err;
}

/**
 * Consolidate, retrying ONCE on an ambiguous (thrown) call with the SAME id. The
 * id dedups server-side, so the retry either applies it (first attempt didn't
 * land) or returns 0 without re-applying (first attempt did land) — no double
 * move. Returns the result code, or "unknown" if both attempts were ambiguous.
 */
async function consolidateWithRetry(
  params: Parameters<typeof consolidateAccounts>[0],
): Promise<number | "unknown"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { code } = await consolidateAccounts(params);
      return code;
    } catch {
      if (attempt === 1) return "unknown";
      // brief pause before the id-safe retry
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return "unknown";
}
