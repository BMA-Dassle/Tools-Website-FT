/**
 * Card consolidation — CLOUD ONLY. Move ALL value from one source card onto a
 * target card, then clear the source, entirely server-side via the cloud SOAP
 * TPI service. There is no bridge path: consolidation is only offered on kiosks
 * running against the cloud (KioskGameZone gates the mode on `bridgeUp===false`).
 *
 * The kiosk holds only ONE card at a time, so it calls this once per source:
 *   read target (kiosk) → for each source: accept → POST here → bin on ok.
 *
 * MONEY-SAFETY (the whole reason this is a service, not two client calls):
 *  1. Read the source balance (verifyAccount).
 *  2. Credit the target with those exact values (creditAccountValues). This is
 *     idempotent on a stable tpiTransactionID — a retry with the same id returns
 *     0 without re-applying, so an ambiguous credit is safe to re-attempt.
 *  3. ONLY after the credit is confirmed (code 0) do we clear the source
 *     (clearAccount). Value therefore never lands nowhere.
 *  - Credit fails/declined  → nothing cleared, source keeps its value → the
 *    kiosk returns the card (outcome "declined").
 *  - Credit ambiguous       → we re-attempt once (id-dedup makes it safe); if
 *    still ambiguous, outcome "unknown" → the kiosk HOLDS and does NOT bin (the
 *    value is still on the source; staff re-query).
 *  - Clear fails after a good credit → the value is safely on the target and the
 *    source card is captured (binned) by the kiosk, so it can't be re-spent;
 *    we return ok:true with a clearWarning and log it for staff. (Part B's
 *    clear-on-encode is the backstop before any such card is re-issued.)
 *
 * Account numbers are bigint strings end-to-end — never Number() them.
 */
import { randomUUID } from "node:crypto";
import { getCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { ConsolidateInput } from "../schemas";
import type { CardBalance } from "../types";
import {
  verifyAccount,
  creditAccountValues,
  clearAccount,
  IntercardError,
} from "../data/intercard";
import { logConsolidation } from "../data/consolidations-log";

export interface ConsolidateResult {
  /** true = value is on the target and the source may be binned. */
  ok: boolean;
  outcome: "done" | "declined" | "unknown";
  moved: { tokens: number; bonusTokens: number; points: number; minutes: number };
  /** Target balance re-read after the move (display). */
  targetBalance?: CardBalance;
  /** Set when the credit landed but the source clear did not (source is binned,
   *  so contained; flagged for staff / Part-B reuse guard). */
  clearWarning?: string;
  message?: string;
}

const ZERO: CardBalance = { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 };

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  if (input.sourceAccount === input.targetAccount) {
    throw new GameCardHttpError(400, "SAME_CARD", "A card can't be combined onto itself.");
  }

  // Both cards must exist. Read the source's movable value + confirm the target.
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
  const hasValue =
    moved.tokens > 0 || moved.bonusTokens > 0 || moved.points > 0 || moved.minutes > 0;
  // Stable id: the credit dedups on it, so a retry after an ambiguous credit
  // never double-applies. Reused for the whole per-source move.
  const tpiTransactionID = randomUUID();

  // 1) Credit the target with the source's value (skip when there's nothing to move).
  if (hasValue) {
    const credit = await creditWithRetry({
      locationCode: input.locationCode,
      accountNumber: input.targetAccount,
      tokens: moved.tokens,
      tokenBonus: moved.bonusTokens,
      points: moved.points,
      durationMinutes: moved.minutes,
      tpiTransactionID,
    });
    if (credit === "unknown") {
      await logConsolidation({
        id: tpiTransactionID,
        locationCode: input.locationCode,
        sourceAccount: input.sourceAccount,
        targetAccount: input.targetAccount,
        preTokens: b.tokens,
        preBonusTokens: b.bonusTokens,
        outcome: "unknown",
        description: "credit ambiguous — source NOT cleared",
      });
      return {
        ok: false,
        outcome: "unknown",
        moved,
        message: "We couldn't confirm the combine — please have staff check both cards.",
      };
    }
    if (credit !== 0) {
      await logConsolidation({
        id: tpiTransactionID,
        locationCode: input.locationCode,
        sourceAccount: input.sourceAccount,
        targetAccount: input.targetAccount,
        preTokens: b.tokens,
        preBonusTokens: b.bonusTokens,
        outcome: "declined",
        code: String(credit),
      });
      return {
        ok: false,
        outcome: "declined",
        moved,
        message: "That card couldn't be combined — please try again or see an attendant.",
      };
    }
  }

  // 2) Value is safely on the target (or there was none) → clear the source.
  //    A clear failure here does NOT lose value (it's on the target) and the
  //    kiosk still bins the source, so it can't be re-spent.
  let clearWarning: string | undefined;
  try {
    const { code } = await clearAccount({
      locationCode: input.locationCode,
      accountNumbers: [input.sourceAccount],
    });
    if (code !== 0) clearWarning = `clear returned ${code}`;
  } catch (err) {
    clearWarning = err instanceof Error ? err.message : "clear failed";
  }

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
    outcome: clearWarning ? "unknown" : "done",
    description: clearWarning,
  });

  return {
    ok: true,
    outcome: clearWarning ? "unknown" : "done",
    moved,
    targetBalance,
    clearWarning,
  };
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
 * Credit, retrying ONCE on an ambiguous (thrown) call with the SAME id. The id
 * dedups server-side, so the retry either applies it (first attempt didn't land)
 * or returns 0 without re-applying (first attempt did land) — no double credit.
 * Returns the result code, or "unknown" if both attempts were ambiguous.
 */
async function creditWithRetry(
  params: Parameters<typeof creditAccountValues>[0],
): Promise<number | "unknown"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { code } = await creditAccountValues(params);
      return code;
    } catch {
      if (attempt === 1) return "unknown";
      // brief pause before the id-safe retry
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return "unknown";
}
