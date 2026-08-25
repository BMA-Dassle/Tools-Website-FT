/**
 * Lane arrangement — creating a reservation on a chosen lane, safely.
 *
 * THE CONTRACT: a lane preference must never cost a booking. This walks the engine's
 * ranked candidates, treats the vendor's recoverable refusals as "try the next lane", and
 * when the candidates run out it creates the reservation with NO lane pin at all — exactly
 * what every booking we have ever made did. The guest always ends up with a reservation.
 *
 * It lives here rather than inline in a caller because getting it wrong is silent and
 * expensive. The first version of this loop only recognised `LanesNotCompatible` and
 * aborted on everything else, so a lane that was merely OCCUPIED — the single most likely
 * refusal on a busy Saturday — killed the whole attempt instead of moving to the next
 * candidate. That bug is exactly what a second hand-rolled copy would reintroduce.
 *
 * The vendor call is injected, so the walk is unit-testable without touching QAMF.
 */
import { classifyPinFailure, type PinFailure } from "./pin-errors";

export interface PinAttempt {
  lanes: number[] | null;
  ok: boolean;
  failure?: PinFailure;
}

export interface PinOutcome<T> {
  reservation: T;
  /** Lanes we asked for, or `null` when we fell open and let QAMF choose. */
  pinnedTo: number[] | null;
  /** Every attempt in order — persist this to `lane_plan_decisions` for tuning. */
  attempts: PinAttempt[];
  /** True when no candidate was accepted and QAMF assigned the lane. */
  failedOpen: boolean;
}

export interface PinOptions<T> {
  /** Ranked lane sets, best first. Empty means "don't pin at all". */
  candidates: readonly (readonly number[])[];
  /** Create the reservation. `lanes === null` means send no `Lanes` field. */
  create: (lanes: readonly number[] | null) => Promise<T>;
  /** How many candidates to try before falling open. Each one is a live vendor round-trip,
   *  and a guest is waiting, so this is deliberately small. */
  maxAttempts?: number;
  /** Called before each attempt — logging hook, must not throw. */
  onAttempt?: (lanes: readonly number[] | null, index: number) => void;
}

export const DEFAULT_MAX_PIN_ATTEMPTS = 3;

/**
 * Create a reservation on the best lane the vendor will accept.
 *
 * Never throws for a lane reason. The only error that escapes is one from the final
 * unpinned create — at which point the booking genuinely cannot be made and the caller's
 * existing error handling is correct.
 */
export async function createWithLanePlan<T>(opts: PinOptions<T>): Promise<PinOutcome<T>> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_PIN_ATTEMPTS;
  const attempts: PinAttempt[] = [];

  for (const candidate of opts.candidates.slice(0, max)) {
    const lanes = [...candidate];
    opts.onAttempt?.(lanes, attempts.length);
    try {
      const reservation = await opts.create(lanes);
      attempts.push({ lanes, ok: true });
      return { reservation, pinnedTo: lanes, attempts, failedOpen: false };
    } catch (err) {
      const failure = classifyPinFailure(err instanceof Error ? err.message : String(err));
      attempts.push({ lanes, ok: false, failure });
      // An unrecognised error is not something another lane fixes. Stop burning
      // round-trips on a guest's booking and go straight to the unpinned create.
      if (!failure.tryNextLane) break;
    }
  }

  // FAIL OPEN. Whatever happened above, the guest still gets their reservation on
  // whatever lane QAMF picks — which is the behaviour that predates this feature.
  opts.onAttempt?.(null, attempts.length);
  const reservation = await opts.create(null);
  attempts.push({ lanes: null, ok: true });
  return { reservation, pinnedTo: null, attempts, failedOpen: true };
}

/** One-line summary of a walk, for logs and the staff-facing decision record. */
export function describePinOutcome(outcome: PinOutcome<unknown>): string {
  const refused = outcome.attempts
    .filter((a) => !a.ok && a.lanes)
    .map((a) => `${a.lanes!.join("+")} (${a.failure?.code ?? "?"})`);
  if (!outcome.failedOpen) {
    const head = `pinned to ${outcome.pinnedTo?.join("+")}`;
    return refused.length ? `${head} after ${refused.join(", ")} refused` : head;
  }
  return refused.length
    ? `failed open — QAMF chose; refused ${refused.join(", ")}`
    : "no candidate offered — QAMF chose";
}
