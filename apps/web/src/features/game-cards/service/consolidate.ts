/**
 * Card consolidation — CLOUD ONLY, via TPI_ConsolidateAccounts on the SAME
 * Intercard cloud SOAP host every other call uses (intercard.swflpassport.com —
 * the live-verified TPICreditAccounts host). One atomic server-side op moves
 * ALL values of the source card onto the target. Envelope is WSDL-exact (pulled
 * live 2026-07-23) — see consolidateAccounts in data/intercard.ts. No bridge,
 * no raw sockets, no per-site hosts: consolidation is only offered on kiosks
 * running against the cloud (KioskGameZone gates on `bridgeUp===false`).
 *
 * The kiosk holds only ONE card at a time, so it calls this once per source:
 *   read target (kiosk) → for each source: accept → POST here → bin on ok.
 *
 * MONEY-SAFETY:
 *  - The move is atomic and server-computed — every value field (cash, bonus
 *    cash, tokens, bonus tokens, points, time) moves in one op; we never
 *    enumerate amounts, so nothing can be dropped, and there is NO separate
 *    unguarded clear step (the op drains the source).
 *  - Retry: idempotent on tpiTransactionID (duplicate id returns 0 without
 *    re-applying) — the ONE retry reuses the SAME id, so it either lands the
 *    move or no-ops. Doubly safe: consolidate moves ALL value, so a re-run
 *    after a landed attempt moves nothing (source already empty).
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
import { getCenter, macForCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { ConsolidateInput } from "../schemas";
import type { CardBalance } from "../types";
import { verifyAccount, consolidateAccounts, IntercardError } from "../data/intercard";
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
  /** WHAT actually failed (staff-safe diagnostic — Intercard response code +
   *  description, or the transport error). The kiosk shows this under the
   *  guest message so a failure is debuggable AT the kiosk instead of a bare
   *  "see an attendant" (owner 2026-07-23). */
  detail?: string;
}

const ZERO: CardBalance = { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 };

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  if (input.sourceAccount === input.targetAccount) {
    throw new GameCardHttpError(400, "SAME_CARD", "A card can't be combined onto itself.");
  }
  // Fail closed with a clear message when the Intercard MAC isn't configured —
  // never let a misconfig read as "card declined." (Same MAC the token loads
  // use, so a working Game Zone means this passes.)
  if (!macForCenter(input.locationCode)) {
    throw new GameCardHttpError(
      503,
      "INTERCARD_NOT_CONFIGURED",
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
    tpiTransactionID: transactionId,
  });

  if ("failed" in outcome) {
    console.error(
      `[consolidate] exchange FAILED src=${input.sourceAccount} tgt=${input.targetAccount} loc=${input.locationCode}: ${outcome.failed}`,
    );
    await logConsolidation({
      id: transactionId,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "unknown",
      description: outcome.failed.slice(0, 300),
    });
    return {
      ok: false,
      outcome: "unknown",
      moved,
      message: "We couldn't reach the card system — your card is back.",
      detail: outcome.failed,
    };
  }
  if (outcome.code !== 0) {
    const detail =
      outcome.code === -2
        ? "Intercard -2: MAC not registered for this location"
        : outcome.code === -1
          ? "Intercard -1: server exception"
          : `Intercard result ${outcome.code}`;
    console.error(
      `[consolidate] DECLINED src=${input.sourceAccount} tgt=${input.targetAccount} loc=${input.locationCode}: ${detail}`,
    );
    await logConsolidation({
      id: transactionId,
      locationCode: input.locationCode,
      sourceAccount: input.sourceAccount,
      targetAccount: input.targetAccount,
      preTokens: b.tokens,
      preBonusTokens: b.bonusTokens,
      outcome: "declined",
      code: String(outcome.code),
      description: detail,
    });
    return {
      ok: false,
      outcome: "declined",
      moved,
      message: "That card couldn't be combined — your card is back.",
      detail,
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
 * TPI_ConsolidateAccounts, retrying ONCE on a failed exchange with the SAME
 * tpiTransactionID (server-side dedup: the retry either lands the move or
 * returns 0 without re-applying — never a double-apply). Returns the result
 * code, or `{failed}` carrying WHAT went wrong (transport/timeout error text)
 * when both attempts failed to exchange — the caller surfaces it on-screen.
 */
async function consolidateWithRetry(
  params: Parameters<typeof consolidateAccounts>[0],
): Promise<{ code: number } | { failed: string }> {
  let lastFail = "no response";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await consolidateAccounts(params);
    } catch (err) {
      lastFail =
        err instanceof IntercardError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      if (attempt === 0) {
        // brief pause; the retry reuses the SAME tpiTransactionID (id-dedup safe)
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  return { failed: lastFail };
}
