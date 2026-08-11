/**
 * Server-side duration/option validation for bowling holds, reserves, and
 * reschedules. Prevents booking an offer duration that cannot actually fit —
 * the "2-hour shown when only 1.5h fits" bug — and turns opaque QAMF failures
 * into typed 4xx codes the UI can act on (refresh the slot grid).
 *
 * Policy (per tasks/bowling-reservation-flow-plan.md §8):
 *  - fail-OPEN on infrastructure errors (DB down, probe throws) — QAMF's own
 *    createReservation stays the final authority; a flaky probe must never
 *    block a legitimate booking.
 *  - fail-CLOSED on affirmative signals: option doesn't belong to the offer,
 *    duration runs past close, or a probed instant inside the window shows
 *    the offer unavailable.
 */

import { getBowlingExperiences } from "@/lib/bowling-db";
import { isDbConfigured } from "@/lib/db";
import { searchAvailability } from "@/lib/qamf-bowling";
import { etMinutesOfDay } from "~/components/features/booking/steps/bowling/availability-client";
import { QAMF_TO_CENTER_CODE, centerHoursForDate } from "./bowling-hours";
import {
  minConfiguredMinutes,
  optionBelongsToOffer,
  resolveOptionMinutes,
  slotExceedsClose,
  tailForgiveMinutes,
  windowCheckMinutes,
} from "./duration-feasibility";

export type DurationGuardCode = "invalid_option" | "option_unavailable" | "past_close";

export class DurationGuardError extends Error {
  readonly code: DurationGuardCode;
  readonly status: 400 | 409;
  constructor(code: DurationGuardCode, message: string) {
    super(message);
    this.name = "DurationGuardError";
    this.code = code;
    this.status = code === "invalid_option" ? 400 : 409;
  }
}

export interface AssertBookableInput {
  centerId: number;
  webOfferId: number;
  optionId?: number | null;
  optionType?: string | null;
  /** ISO with ET offset, e.g. "2026-07-24T19:00:00-04:00". */
  bookedAt: string;
  players: number;
  /**
   * "full" (default) also runs the QAMF occupancy-window probes.
   * "config-only" validates offer/option/closing only — used on the
   * hold-first reserve path, where the hold itself already probed.
   */
  mode?: "full" | "config-only";
  /** Log prefix, e.g. "[bowling/v2/reserve/hold]". */
  logTag?: string;
}

/** Operating date (YYYY-MM-DD, ET) for a bookedAt — post-midnight slots
 *  (before 6 AM) belong to the PREVIOUS day's operating window. */
function operatingDateEt(bookedAt: string): string {
  const d = new Date(bookedAt);
  const dateEt = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const hourEt = Number(
    d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }),
  );
  if (hourEt >= 6) return dateEt;
  const [y, mo, day] = dateEt.split("-").map(Number);
  const prev = new Date(y, mo - 1, day - 1, 12);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
}

/** Build the ISO probe time for an ET minutes-of-day (0-26h) on an operating
 *  date, preserving the offset style QAMF expects (route parity). */
function probeIsoFor(operatingDate: string, minutesOfDay: number, tzOffset: string): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  let calDate = operatingDate;
  if (h >= 24) {
    const [y, mo, d] = operatingDate.split("-").map(Number);
    const next = new Date(y, mo - 1, d + 1, 12);
    calDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  }
  return `${calDate}T${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tzOffset}`;
}

/**
 * Assert a (webOfferId, optionId, bookedAt, players) pick is bookable per our
 * config and — in full mode — per a QAMF occupancy-window check. Throws
 * DurationGuardError; resolves silently on pass OR on infrastructure failure
 * (fail-open).
 */
export async function assertBookable(input: AssertBookableInput): Promise<void> {
  const tag = input.logTag ?? "[duration-guard]";
  const centerCode = QAMF_TO_CENTER_CODE[input.centerId];
  if (!centerCode) {
    throw new DurationGuardError("invalid_option", `unknown centerId: ${input.centerId}`);
  }
  if (!isDbConfigured()) return; // no config to validate against — fail open

  let sharing;
  try {
    // Pinboyz seam: include the inactive pinboyz-* rows so holds on
    // offer 176 validate — without this the guard fail-closes with
    // "unknown web offer 176" even though availability listed the slot.
    const all = await getBowlingExperiences(centerCode, undefined, true);
    sharing = all.filter((e) => e.qamfWebOfferId === input.webOfferId);
  } catch (err) {
    console.warn(`${tag} duration guard config fetch failed (fail-open):`, err);
    return;
  }

  if (sharing.length === 0) {
    throw new DurationGuardError(
      "invalid_option",
      `unknown web offer ${input.webOfferId} for this center`,
    );
  }

  if (!optionBelongsToOffer(sharing, input.optionId)) {
    throw new DurationGuardError(
      "invalid_option",
      `option ${input.optionId} does not belong to offer ${input.webOfferId}`,
    );
  }

  const minutes = resolveOptionMinutes(sharing, input.optionId, input.optionType);
  if (minutes == null) return; // Game/Unlimited/unknown — exempt from duration logic

  const operatingDate = operatingDateEt(input.bookedAt);
  const { close: closeHour } = centerHoursForDate(input.centerId, operatingDate);
  if (slotExceedsClose(input.bookedAt, minutes, closeHour)) {
    throw new DurationGuardError(
      "past_close",
      `a ${minutes}-minute session starting at this time runs past closing`,
    );
  }

  if (input.mode === "config-only") return;

  // Occupancy-window necessary-condition check (branch D): the offer must
  // show availability at every 15-min instant inside the window's SOUND ZONE,
  // else no lane can span it. Start instant is left to QAMF's
  // createReservation. Instants past the offer's last bookable start
  // (close − shortest option) are excluded — QAMF never lists the offer there
  // even with empty lanes, so probing them would 409 every legitimate
  // last-of-night booking — and the window's own start-tail instants are
  // excluded for the same reason ahead of mid-day event blocks (see
  // tailForgiveMinutes, 2026-08-10; must mirror the availability route or a
  // slot the grid offers would 409 at hold time).
  const startMin = etMinutesOfDay(input.bookedAt);
  const minCfg = minConfiguredMinutes(sharing);
  const lastStartMin = minCfg != null ? closeHour * 60 - minCfg : null;
  const checkMinutes = windowCheckMinutes(
    startMin,
    minutes,
    lastStartMin,
    tailForgiveMinutes(minCfg),
  );
  if (checkMinutes.length === 0) return;

  const offsetMatch = input.bookedAt.match(/([+-]\d{2}:\d{2})$/);
  const tzOffset = offsetMatch?.[1] ?? "-04:00";

  const results = await Promise.all(
    checkMinutes.map(async (g) => {
      const iso = probeIsoFor(operatingDate, g, tzOffset);
      try {
        const res = await searchAvailability(input.centerId, {
          BookedAtRange: { StartAt: iso, EndAt: iso },
          TotalPlayers: input.players,
          WebOffer: { Services: ["BookForLater"] },
        });
        const present = (res.Availabilities ?? []).some(
          (a) => Number(a.WebOffer?.Id) === input.webOfferId,
        );
        return { g, probed: true, present };
      } catch (err) {
        console.warn(`${tag} window probe at +${g - startMin}min failed (fail-open):`, err);
        return { g, probed: false, present: true };
      }
    }),
  );

  const blockedAt = results.find((r) => r.probed && !r.present);
  if (blockedAt) {
    console.log(
      `${tag} duration window blocked: offer=${input.webOfferId} start=${input.bookedAt} ` +
        `${minutes}min — unavailable at +${blockedAt.g - startMin}min`,
    );
    throw new DurationGuardError(
      "option_unavailable",
      "That duration no longer fits at this time — pick another time or a shorter session.",
    );
  }
}

/** Map a QAMF createReservation failure message to a typed slot conflict when
 *  it looks like a lane-fit/availability rejection (409-class), else null. */
export function qamfSlotTakenMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/:\s*409\b|LanesNotAvailable|WebOfferNotAvailable|not\s*available/i.test(msg)) {
    return "That time was just taken — pick another time.";
  }
  return null;
}
