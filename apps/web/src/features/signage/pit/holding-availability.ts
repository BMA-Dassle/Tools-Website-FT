/**
 * MAY THIS GROUP TAKE THE HOLDING SEATS? PURE — a lane and a session in, a
 * verdict out.
 *
 * The rule itself is not new: it has guarded sendToHolding since 2026-08-15
 * (owner: "if holding is full we need to prevent them from hitting send to
 * holding"), written inline there. It is lifted out here because a SECOND
 * surface now needs the same answer — the in-room briefing screen, which has to
 * decide whether to offer the button at all, and has to say why when it does
 * not.
 *
 * A guard the server keeps to itself is a button that looks pressable and
 * refuses; a rule copied into the client is two rules that drift. So both call
 * this, and the sentence staff read on the disabled button is the sentence the
 * API would have returned.
 *
 * WHY THE TEST IS "WOULD THIS DISPLACE SOMEBODY WHO HAS NOT GONE OUT" rather
 * than the simpler "is holding full": `holding` is a single slot, and writing to
 * it PROMOTES whoever is staged there on the assumption they have just taken the
 * track. That assumption is right in the normal back-to-back flow, where the
 * stored lane is merely stale after a green flag. It is catastrophic when it is
 * wrong — Blue 27 was declared racing without ever leaving the seats and then
 * overwritten, leaving no key in Redis to say the group existed. Refusing on
 * "full" alone would break the normal flow; refusing on "would displace someone
 * still in the seats" breaks neither.
 */

/** The parts of a lane occupant this rule reads. Structurally compatible with
 *  PitLaneFeed's slots, so callers pass those straight in. */
export interface HoldingOccupant {
  sessionId: string;
  heatNumber?: number | null;
}

export type HoldingAvailability = { ok: true } | { ok: false; error: string };

/**
 * Can `sessionId` be sent to this track's holding seats?
 *
 * `racing` and `pitIn` must come from the RESOLVED lane — the stored one is
 * exactly what goes stale, and reading a stale racing slot here would refuse the
 * ordinary back-to-back send.
 *
 * Ids are compared as STRINGS and never coerced: Pandora session ids ride the
 * same rail as BMI's, which exceed Number.MAX_SAFE_INTEGER (house rule).
 */
export function holdingAvailability(args: {
  holding: HoldingOccupant | null | undefined;
  racing: { sessionId: string } | null | undefined;
  pitIn: { sessionId: string } | null | undefined;
  sessionId: string;
}): HoldingAvailability {
  const occupant = args.holding ?? null;

  // Empty seats, or a re-send of the group already in them — a refresh, not a
  // displacement.
  if (!occupant || occupant.sessionId === args.sessionId) return { ok: true };

  // Stale stored lane is the NORMAL case: the staged group may already be out on
  // track and the lane simply has not caught up. Displacing them then is right.
  const alreadyOut =
    args.racing?.sessionId === occupant.sessionId || args.pitIn?.sessionId === occupant.sessionId;
  if (alreadyOut) return { ok: true };

  const who = occupant.heatNumber != null ? `Session ${occupant.heatNumber}` : "another group";
  return {
    ok: false,
    error: `${who} is still in holding. Move them to the karts first — this would drop them off the boards.`,
  };
}
