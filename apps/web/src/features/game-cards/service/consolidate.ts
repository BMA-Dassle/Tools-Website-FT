/**
 * Card consolidation — CLOUD ONLY, via the documented ConsolidateCards request
 * (Intercard Enhanced 3rd Party Interface v7, docs/…-v7.pdf p.27-28): one atomic
 * Transaction Server op moves ALL values of the source card onto the
 * "primary/single" target card. Sent server-side over raw TCP to the
 * cloud-hosted Transaction Server (data/intercard-eis.ts; host via
 * INTERCARD_EIS_HOST). There is no bridge path: consolidation is only offered on
 * kiosks running against the cloud (KioskGameZone gates on `bridgeUp===false`).
 *
 * The kiosk holds only ONE card at a time, so it calls this once per source:
 *   read target (kiosk) → for each source: accept → POST here → bin on ok.
 *
 * MONEY-SAFETY:
 *  - The move is atomic and server-computed — every value field (cash, bonus
 *    cash, tokens, bonus tokens, points, time) moves in one op; we never
 *    enumerate amounts, so nothing can be dropped, and there is NO separate
 *    unguarded clear step (the op drains the source).
 *  - Retry: the Enhanced 3PI dedups on MacAddress+UTCDateTime (no id-based
 *    idempotency), so each attempt carries a fresh timestamp. Retrying
 *    ConsolidateCards is still safe: it moves ALL value, so a re-run after a
 *    landed attempt moves nothing (source already empty).
 *  - done (code 0)    → value is on the target, source drained → kiosk bins it.
 *  - declined (non-0) → nothing moved (atomic) → kiosk returns the card.
 *  - unknown (both attempts failed to exchange) → all-or-nothing means the value
 *    is EITHER fully on the target (source empty) OR fully on the source —
 *    returning the source to the guest loses nothing and duplicates nothing, so
 *    the kiosk returns it and flags staff; we NEVER bin an unconfirmed source.
 *
 * Account numbers are bigint strings end-to-end — never Number() them.
 */
import { randomUUID } from "node:crypto";
import { getCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { ConsolidateInput } from "../schemas";
import type { CardBalance } from "../types";
import { verifyAccount, IntercardError } from "../data/intercard";
import { consolidateCards, eisConfigured } from "../data/intercard-eis";
import { logConsolidation } from "../data/consolidations-log";

export interface ConsolidateResult {
  /** true = value is on the target and the source may be binned. */
  ok: boolean;
  outcome: "done" | "declined" | "unknown";
  /** The source's pre-move balance (display/audit; token-family only — the move
   *  itself is server-computed and covers every field). */
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
  // Fail closed with a clear message when the cloud EIS isn't configured —
  // never let a misconfig read as "card declined."
  if (!eisConfigured(input.locationCode)) {
    throw new GameCardHttpError(
      503,
      "EIS_NOT_CONFIGURED",
      "Combining cards isn't available right now — please see an attendant.",
    );
  }

  // Both cards must exist. Read the source balance for display/audit (the MOVE
  // is server-authoritative and covers every field, incl. ones this read omits).
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
  // Per-move id: echoed as <TransactionID> on the EIS request and the primary
  // key of our audit row (NOT a dedup key — see the retry note above).
  const transactionId = randomUUID();

  // Atomic move: ALL value from the source onto the target in one documented op.
  // No "has value" gate — the balance read is display-only and cash-blind; the
  // server moves whatever is actually there.
  const outcome = await consolidateWithRetry({
    locationCode: input.locationCode,
    targetAccount: input.targetAccount,
    sourceAccounts: [input.sourceAccount],
    transactionId,
  });

  if (outcome === "unknown") {
    await logConsolidation({
      id: transactionId,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "unknown",
      description: "ConsolidateCards exchange failed — source returned to guest, not binned",
    });
    return {
      ok: false,
      outcome: "unknown",
      moved,
      message: "We couldn't confirm the combine — your card is back. Please see an attendant.",
    };
  }
  if (outcome.code !== 0) {
    await logConsolidation({
      id: transactionId,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "declined",
      code: String(outcome.code),
      description: outcome.description || undefined,
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
    id: transactionId,
    locationCode: input.locationCode,
    sourceAccount: input.sourceAccount,
    targetAccount: input.targetAccount,
    preTokens: b.tokens,
    preBonusTokens: b.bonusTokens,
    outcome: "done",
    description: outcome.description || undefined,
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
 * ConsolidateCards, retrying ONCE on a failed exchange. Safe for THIS op only:
 * it moves ALL value, so a retry after a landed-but-unconfirmed attempt moves
 * nothing (the source is already empty) — never a double-apply. Returns the
 * CommandStatus, or "unknown" when both attempts failed to exchange.
 */
async function consolidateWithRetry(
  params: Parameters<typeof consolidateCards>[0],
): Promise<{ code: number; description: string } | "unknown"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await consolidateCards(params);
    } catch {
      if (attempt === 1) return "unknown";
      // brief pause; the retry carries a fresh UTC_DateTime (dedup key)
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return "unknown";
}
