/**
 * WHEN SHOULD A SESSION BE CALLED, AND MAY A GUEST WALL NAME ITS TIME?
 *
 * Pure. Two questions, both answered from the same three facts: the printed
 * slot, how far behind the track is running, and who is booked.
 *
 * ── 1. THE CALL TIME ────────────────────────────────────────────────────────
 *
 * The desk's rule, confirmed by the owner 2026-08-17: "we like to call about 5
 * minutes before a session check in time and allow up to two minutes after."
 * That is the window `[slot − 5, slot + 2]`, and it was measured against six
 * nights (8/12–8/17, 376 heats) before being encoded here.
 *
 * BUT slot − 5 IS NOT THE UNDERLYING RULE — it is what the underlying rule
 * happens to equal on a night running ~18 minutes late. The real constraint is
 * the pipeline: from the call, the median group takes 13.6 min to be released
 * from the briefing room (p90 20.3), and needs ~2 more to walk and belt in. So a
 * group must be called ~22 minutes before its own GREEN FLAG, and the flag lands
 * at `slot + offset`:
 *
 *     call = slot + offset − PIPELINE_LEAD_MIN
 *
 * With the measured median offset of +17.6 that is slot − 4.4, which is why the
 * desk's five minutes is right. Anchoring on the flag rather than the slot is
 * what makes the window slide correctly as a night falls behind — which is what
 * staff already do by eye (their call times track the drift at r = 0.81).
 *
 * ⚠️ THE CLAMP IS THE WHOLE SAFETY STORY. If the offset is 0 — a track genuinely
 * on time, OR, far more likely, a dead feed reading as zero — the formula above
 * says "call 22 minutes before the guest's own check-in time", before they are
 * even due to arrive. There is nobody to call. So the call time is never earlier
 * than `slot − CALL_LEAD_MIN`: the desk's flat rule is the floor, and a missing
 * offset degrades to exactly what the desk does today rather than to nonsense.
 * (The venue feed has been dead since 2026-08-17, so that floor is the live path,
 * not a corner case.)
 *
 * ── 2. MAY THE WALL NAME IT? ────────────────────────────────────────────────
 *
 * A guest wall that names 7:45 and then takes it back is worse than one that
 * names nothing, and the next session is NOT stable: fill an earlier empty heat
 * and it changes (owner 2026-08-17: "that could change if something gets on a
 * sooner session"). So the wall may only speak when nothing can get in front —
 * when every empty slot ahead of the session is already too soon to book.
 *
 * The booking lead times decide "too soon", and they already exist in the heat
 * picker: 40 min for a new racer on web, 15 on the kiosk, 10 for a returning
 * racer on the kiosk. We use the TIGHTEST, so the gate is conservative.
 *
 * Measured over the same six nights: the strict form (no empty slot in front at
 * all) showed 97% of sessions, and with the 10-minute lead applied it suppressed
 * nothing at all — 432 of 432. The gate is close to free.
 *
 * ⚠️ NOT AN IMPOSSIBILITY. Staff booking directly in BMI Office bypasses every
 * lead time above, so this is "no guest can get in front". The exposure is at
 * most the last ten minutes before the slot, and the wall repaints on its 2s
 * pulse, so it corrects itself.
 */
import { CALL_LEAD_MIN } from "./on-time";

/**
 * How long after the call time the desk still counts as on-policy.
 *
 * The owner's "allow up to two minutes after" is two minutes past the CHECK-IN
 * TIME, not past the call time — so the window a call may land in runs from
 * `slot − 5` to `slot + 2`, which is `CALL_LEAD_MIN + CALL_TOLERANCE_MIN` wide.
 * Expressing the width that way is what lets the whole window slide with the
 * track offset while keeping the owner's two numbers intact.
 */
export const CALL_TOLERANCE_MIN = 2;

/** The width of the window, from the call time. 5 + 2 = the owner's `[−5, +2]`. */
export const CALL_WINDOW_MIN = CALL_LEAD_MIN + CALL_TOLERANCE_MIN;

/**
 * Call → on the grid, ready for the flag. `p90` of call → room-released (20.3
 * min over 6 nights) plus the ~2 min to walk and belt in, which is also the
 * measured p50 track turnaround.
 *
 * p90 not median on purpose: a rule built on the median makes half the groups
 * late.
 */
export const PIPELINE_LEAD_MIN = 22;

/**
 * The tightest lead any GUEST booking channel allows, so a slot inside it can no
 * longer be sold. Mirrors KIOSK_RETURNING_LEAD_MINUTES in
 * components/features/booking/steps/race/RaceHeatPickerStep.tsx — if that
 * shrinks, this must shrink with it or the wall can be overtaken.
 */
export const GUEST_BOOKING_LEAD_MIN = 10;

/**
 * How far past its slot a session stays interesting.
 *
 * A heat whose slot went by half an hour ago and was never called is not a call
 * we are about to make — it is a scheduling artefact, or a heat nobody booked
 * that we have no count for. Nagging about it forever is how staff learn to
 * ignore amber.
 */
export const CALL_ABANDON_MIN = 30;

/** Where a session is against its call window. */
export type CallState = "quiet" | "due" | "overdue";

/** One slot on a track's printed grid, with what we know about who is in it. */
export interface CallGridSlot {
  sessionId: string;
  heatNumber: number | null;
  /** The printed check-in time — the slot Pandora sold. */
  slotMs: number;
  /**
   * Racers booked in. NULL means WE DO NOT KNOW (no warm participants record),
   * which is deliberately different from 0 — see `nextCheckIn`.
   */
  booked: number | null;
  /** Set once the session has been called in BMI. We only ever read this. */
  calledAtMs?: number | null;
  /** The level Pandora sold, for the Pro call delay. Absent ⇒ house lead. */
  type?: string | null;
}

/** The answer both surfaces render. */
export interface NextCheckIn {
  sessionId: string;
  heatNumber: number | null;
  /** The printed check-in time. What a guest was told, and what a wall may name. */
  slotMs: number;
  /** Racers booked. Always > 0 — a session with nobody in it never gets here. */
  booked: number;
  /** When this session should be called. */
  callAtMs: number;
  /** Where we are against the window right now. */
  state: CallState;
  /** Whole minutes past the end of the window. 0 unless `state` is "overdue". */
  overdueMin: number;
  /**
   * Is this a Pro grid, and therefore called `PRO_CALL_DELAY_MIN` later than
   * the rest? Carried so a surface can SAY so — a call time two minutes off the
   * house rule with no explanation reads as a bug to the desk.
   */
  proDelayed: boolean;
  /**
   * May a GUEST WALL name `slotMs`? False when an empty slot ahead of this one is
   * still bookable, so a later-booked group could take this session's place.
   * The staff warning does not consult this — the desk wants to know regardless.
   */
  wallSafe: boolean;
}

/**
 * HOW MUCH LATER A PRO SESSION IS CALLED (owner 2026-08-23: "the call time can
 * be reduced for pro right?").
 *
 * It can, and the reason is the one leg pro groups skip: there is no 4:30
 * briefing film between their check-in and the grid. Measured call → standing in
 * holding, over 8/18–8/22:
 *
 *     starter        p50 12:30   p80 16:20
 *     intermediate   p50 10:52   p80 13:56
 *     pro            p50  6:18   p80  8:05
 *
 * Pro is ready roughly EIGHT minutes sooner and pays for it by standing in the
 * pit seats longest of any tier (p50 ~8 min — the worst hold on the board).
 *
 * ⚠️ BUT THE FULL EIGHT MINUTES IS NOT SAFE, and the simulation is why. Replayed
 * against Thursday 8/20, delaying pro calls by 4 minutes saved 62 pit-seat
 * minutes and took LATE groups from 1 to 6 — because the pro chain has a fat
 * tail (p50 6:18, max 31:59: a pro group occasionally takes half an hour to
 * reach the desk). At 2 minutes the same replay held lateness flat. So this is
 * two minutes, not eight: the median says more, the tail says no.
 *
 * Junior Starter, Intermediate and anything unrecognised keep the house lead —
 * they all watch a film.
 */
export const PRO_CALL_DELAY_MIN = 2;

/** Does this session skip the briefing film? Name-based, the same reading
 *  `tierForRaceType` uses, so the call rule and the film cannot disagree about
 *  what a session is. "Pro" only — never Junior Pro, which is still a film. */
export function isProCall(type: string | null | undefined): boolean {
  const name = (type || "").toLowerCase();
  if (!name.includes("pro")) return false;
  // A junior grid gets the junior briefing whatever else its name says.
  return !name.includes("junior");
}

/**
 * When to call a session.
 *
 * `offsetMin` is how many minutes behind its slot this track's flags are
 * currently dropping (null when we have no live picture). See the header for why
 * the result is clamped.
 *
 * `type` is the level Pandora sold, used only to give a Pro grid its later call
 * (see `PRO_CALL_DELAY_MIN`). Absent ⇒ the house lead, which is the safe
 * direction: an unknown tier is called as if it had a film to watch.
 */
export function callAtMs(slotMs: number, offsetMin: number | null, type?: string | null): number {
  const delayMs = isProCall(type) ? PRO_CALL_DELAY_MIN * 60_000 : 0;
  const floor = slotMs - CALL_LEAD_MIN * 60_000 + delayMs;
  if (offsetMin == null || !Number.isFinite(offsetMin)) return floor;
  // The pipeline lead is the OTHER place the missing film shows up: a pro group
  // needs less warning before its own green flag, so the same delay applies to
  // the flag-anchored form too. Both terms move together, which keeps the clamp
  // below meaningful instead of cancelling the delay out.
  const fromFlag = slotMs + (offsetMin - PIPELINE_LEAD_MIN) * 60_000 + delayMs;
  // Never earlier than the desk's flat rule — there would be nobody to call.
  return Math.max(floor, fromFlag);
}

/** Where `nowMs` sits against a call time. */
export function callStateAt(callAt: number, nowMs: number): CallState {
  if (nowMs < callAt) return "quiet";
  return nowMs <= callAt + CALL_WINDOW_MIN * 60_000 ? "due" : "overdue";
}

/**
 * The next session on one track that still needs calling — or null.
 *
 * Returns null (say nothing) when:
 *   - every slot is already called, or too far past its slot to matter
 *   - the session has NOBODY BOOKED (owner 2026-08-17: only warn about sessions
 *     with people in them)
 *   - we do not KNOW who is booked. An unknown count is not a reason to nag; the
 *     warm participants record is missing precisely when Pandora is unhappy, and
 *     a board that invents a warning then is worse than a quiet one.
 *
 * `slots` may arrive in any order and may contain called sessions; both are
 * handled here so callers can hand over the whole grid.
 */
export function nextCheckIn(
  slots: CallGridSlot[],
  nowMs: number,
  offsetMin: number | null,
): NextCheckIn | null {
  const ordered = [...slots].sort((a, b) => a.slotMs - b.slotMs);

  const candidate = ordered.find(
    (s) =>
      s.calledAtMs == null &&
      s.slotMs >= nowMs - CALL_ABANDON_MIN * 60_000 &&
      s.booked != null &&
      s.booked > 0,
  );
  if (!candidate) return null;

  const callAt = callAtMs(candidate.slotMs, offsetMin, candidate.type);
  const state = callStateAt(callAt, nowMs);
  const overdueMs = nowMs - (callAt + CALL_WINDOW_MIN * 60_000);
  const overdueMin = state === "overdue" ? Math.max(1, Math.floor(overdueMs / 60_000)) : 0;

  return {
    sessionId: candidate.sessionId,
    heatNumber: candidate.heatNumber,
    slotMs: candidate.slotMs,
    booked: candidate.booked as number,
    callAtMs: callAt,
    state,
    overdueMin,
    proDelayed: isProCall(candidate.type),
    wallSafe: isWallSafe(ordered, candidate, nowMs),
  };
}

/**
 * Can anything still get in front of `target`?
 *
 * An earlier slot is a threat only if it is EMPTY (something could be booked
 * into it) and still bookable (more than the guest booking lead away). An
 * earlier slot we have no count for is treated as a threat: unknown is not
 * safe when the cost of being wrong is a wall naming the wrong time.
 */
function isWallSafe(ordered: CallGridSlot[], target: CallGridSlot, nowMs: number): boolean {
  for (const s of ordered) {
    if (s.slotMs >= target.slotMs) break;
    if (s.calledAtMs != null) continue; // already called — it cannot be "got into"
    const empty = s.booked == null || s.booked === 0;
    if (!empty) continue;
    const stillBookable = s.slotMs - nowMs > GUEST_BOOKING_LEAD_MIN * 60_000;
    if (stillBookable) return false;
  }
  return true;
}
