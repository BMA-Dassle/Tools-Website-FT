/**
 * Pure duration-feasibility logic for bowling offers.
 *
 * Owner bug (2026-07-19): availability showed times that weren't actually
 * bookable for the specific experience/duration — if the 1.5-hour offer was
 * open at a slot, the 2-hour offer showed the same slot even when the lane
 * wasn't free long enough. QAMF's availability search is point-in-time and
 * echoes every configured Time option, so duration truth has to come from OUR
 * config (Neon) plus a window check over point-in-time probes.
 *
 * Everything here is pure (no I/O) so it can be unit-tested and reused by the
 * availability route's accurate mode, the hold/reserve guards, and the
 * reservation-edit rebook guard. RULE: QAMF's `Minutes` field is NEVER read
 * for logic — `bowling_experience_duration_options` (+ the offer-level
 * `duration_minutes` column for fixed-duration packages) is the only duration
 * source of truth.
 */

import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";

/**
 * Check whether a slot's start time + duration would exceed the center's
 * closing time. `bookedAt` is an ISO string with ET offset. (Moved verbatim
 * from the availability route, 2026-07-19.) End == close is allowed.
 */
export function slotExceedsClose(
  bookedAt: string,
  durationMin: number,
  closeHour24: number,
): boolean {
  const d = new Date(bookedAt);
  const endMs = d.getTime() + durationMin * 60_000;
  const end = new Date(endMs);
  const endET = new Date(end.toLocaleString("en-US", { timeZone: "America/New_York" }));
  let endHour24 = endET.getHours() + endET.getMinutes() / 60;
  if (endHour24 < 6) endHour24 += 24;
  return endHour24 > closeHour24;
}

/** The subset of experience config the feasibility helpers need. */
export type OfferConfig = Pick<
  BowlingExperienceWithDetails,
  "qamfWebOfferId" | "qamfOptionType" | "qamfOptionId" | "durationOptions"
> & {
  /** bowling_experience_offers.duration_minutes — fixed-duration packages
   *  (Pizza Bowl 120, Fun 4 All 90, World Cup 150). Null for Game/Unlimited
   *  and for hourly offers (those carry durationOptions instead). */
  qamfOfferDurationMinutes?: number | null;
};

/**
 * Resolve an option's duration in minutes from OUR config. Returns null when
 * the option carries no duration semantics (Game/Unlimited — KBF, midnight
 * madness) or when we simply don't know it (unknown option id) — null always
 * means "exempt from duration window logic", never "zero minutes".
 *
 * `exps` is every experience sharing the web offer (Fun 4 All shares offer
 * 154 with regular-mon-thur): the first experience that can name a duration
 * for this option wins.
 */
export function resolveOptionMinutes(
  exps: OfferConfig[],
  optionId: number | null | undefined,
  optionType?: string | null,
): number | null {
  if (optionId == null) return null;
  if (optionType === "Game" || optionType === "Unlimited") return null;
  for (const exp of exps) {
    const durOpt = (exp.durationOptions ?? []).find((d) => d.qamfOptionId === optionId);
    if (durOpt) return durOpt.durationMinutes;
    if (exp.qamfOptionId === optionId && exp.qamfOfferDurationMinutes != null) {
      return exp.qamfOfferDurationMinutes;
    }
  }
  return null;
}

/**
 * Does the client-supplied option belong to this web offer per OUR config?
 * Guards against a spoofed/cross-offer optionId reaching QAMF. Accepts when:
 *  - no optionId was supplied (the hold/reserve routes allow that), or
 *  - any sharing experience lists it as a duration option or its seeded
 *    offer option, or
 *  - NO sharing experience seeds any option data at all (fail-open — some
 *    Game offers derive their option from QAMF at runtime).
 */
export function optionBelongsToOffer(
  exps: OfferConfig[],
  optionId: number | null | undefined,
): boolean {
  if (optionId == null) return true;
  let anyConfigured = false;
  for (const exp of exps) {
    const configured = (exp.durationOptions?.length ?? 0) > 0 || exp.qamfOptionId != null;
    if (!configured) continue;
    anyConfigured = true;
    if (exp.qamfOptionId === optionId) return true;
    if ((exp.durationOptions ?? []).some((d) => d.qamfOptionId === optionId)) return true;
  }
  return !anyConfigured;
}

/**
 * Shortest duration (minutes) configured for a web offer across its sharing
 * experiences. QAMF only lists an offer at instants where a NEW booking could
 * still start, so its last listed instant is close − this value — later
 * instants are absent for EVERY offer even when all lanes sit empty. Null
 * when nothing is configured (Game/Unlimited offers carry no duration).
 */
export function minConfiguredMinutes(exps: OfferConfig[]): number | null {
  let min: number | null = null;
  for (const exp of exps) {
    const candidates = (exp.durationOptions ?? []).map((d) => d.durationMinutes);
    if (exp.qamfOfferDurationMinutes != null) candidates.push(exp.qamfOfferDurationMinutes);
    for (const c of candidates) {
      if (c > 0 && (min == null || c < min)) min = c;
    }
  }
  return min;
}

/**
 * Point-in-time probe results keyed by ET minutes-of-day (0-26h notation,
 * 15-min grid): key present = that instant was probed; the Set holds the
 * web offer ids QAMF reported available there. Key ABSENT = not probed /
 * probe failed — treated as unknown.
 */
export type ProbeMap = Map<number, Set<number>>;

/**
 * Windowed necessary-condition check (design branch D): a `durationMin`
 * booking starting at `startMin` is only POSSIBLE if the offer shows some
 * availability at every probed instant of [startMin, startMin + durationMin).
 * A probed instant with the offer ABSENT proves no lane can span the window →
 * false (sound rejection). Unprobed instants are skipped (fail-open for
 * display; the hold attempt remains the final authority). The converse false
 * positive — different lanes free at different instants, none spanning — is
 * accepted residual, caught by QAMF at hold time.
 *
 * `lastStartMin` (close − the offer's shortest option, from
 * minConfiguredMinutes): instants PAST it are skipped, because QAMF never
 * lists the offer there regardless of lane occupancy — absence proves
 * nothing. Without the clamp, every last-of-night slot was rejected (the
 * 2026-07-19 "No Regular Fri–Sun lanes left today" kiosk bug: the bookable
 * 10:30 PM 90-min slot needed the offer listed at 11:15 PM, past the
 * 11:00 PM last start for a midnight close).
 */
export function evaluateWindow(
  probeMap: ProbeMap,
  webOfferId: number,
  startMin: number,
  durationMin: number,
  lastStartMin?: number | null,
): boolean {
  for (let g = startMin; g < startMin + durationMin; g += 15) {
    if (lastStartMin != null && g > lastStartMin) break;
    const probed = probeMap.get(g);
    if (probed && !probed.has(webOfferId)) return false;
  }
  return true;
}

/** Interior window instants (ET minutes, 15-min grid) a duration guard should
 *  probe for a booking at `startMin`: every grid point strictly inside
 *  (startMin, startMin + durationMin). The start instant itself is validated
 *  by QAMF's createReservation. Empty when the start isn't 15-min aligned
 *  (defensive — admin tools can produce odd minutes; skip rather than guess).
 *  `lastStartMin` caps the list the same way evaluateWindow clamps: probing
 *  past the offer's last bookable start only yields meaningless absences. */
export function windowCheckMinutes(
  startMin: number,
  durationMin: number,
  lastStartMin?: number | null,
): number[] {
  if (startMin % 15 !== 0) return [];
  const out: number[] = [];
  for (let g = startMin + 15; g < startMin + durationMin; g += 15) {
    if (lastStartMin != null && g > lastStartMin) break;
    out.push(g);
  }
  return out;
}
