/**
 * WHEN A SOLD SEAT LEAVES A HEAT — the venue's own account of it.
 *
 * `eticket-removals` diffs Pandora's active roster against its all-state roster
 * to find `F_PAR_STATE = 5` scratches, then waits out a six-minute grace before
 * texting anyone that their ticket is dead. The grace exists because ONE
 * Pandora diff is not proof: a partial payload, a filtered page or an upstream
 * hiccup all look exactly like a removal, and an unsendable "your ticket is
 * dead" text is the worst thing this rail can do.
 *
 * The venue broadcast is a SECOND, INDEPENDENT WITNESS to the same event — and
 * two independent witnesses is precisely what the grace was standing in for. So
 * when the wire also saw a sold seat leave that heat, the grace is not needed
 * and the retraction can go at once (owner 2026-08-19: "ignore racers with no
 * products on WS on the removal but make the others instant removal").
 *
 * ── WHY ONLY `Product`-BEARING SEATS COUNT ──────────────────────────────────
 *
 * A `BcDriver` carries `Product`/`ProductId` — the thing the racer actually
 * bought — and some carry neither. Race 58599144 on 8/16 is the clean case: its
 * roster read 7→6→3→7→3→7→3 inside ninety seconds, and the four drivers that
 * came and went ALL had no Product while the three that stayed all had
 * `Product: "Intermediate Race Red"`. By the final frame of every race in the
 * survey, 530 of 533 rows (99.4%) carry a Product. A seat with no Product is
 * provisional and its coming and going is not evidence of anything.
 *
 * ── WHY THE SIGNAL IS PER SESSION AND NOT PER PERSON ────────────────────────
 *
 * It would be better to say WHO left. We cannot, safely: the roster frames
 * identify a driver by `DriverId` (which Pandora's participant payload does not
 * carry) and by `PersonId` (which the bridge's JSON.parse rounds — 39 distinct
 * ids in the survey map to more than one human, one of them to four). So this
 * reports only that a sold seat left THIS session. Pandora still names the
 * person and still decides whether they are really at state 5; the wire only
 * corroborates that a real departure happened on that heat.
 *
 * ── HOW HONEST IS A DEPARTURE? ──────────────────────────────────────────────
 *
 * Measured across 107 races: 160 departures, of which 3 were provably false
 * (the driver reappeared later), all 3 inside the single pathological race
 * above. 106 of 107 rosters are monotonic. So a departure is real 98.1% of the
 * time — and the 1.9% cannot cause a wrong text anyway, because it only removes
 * a grace period from a decision Pandora has already made on its own evidence.
 */

/** One session's sold-seat roster, as one frame reported it. */
export interface SeatSnapshot {
  sessionId: string;
  /** `DriverId`s of the Product-bearing drivers, sorted, deduped. */
  seatIds: string[];
  /**
   * The venue's own version stamp for the frame. STRING, ALWAYS — these run 17
   * digits, past Number.MAX_SAFE_INTEGER, and a Number round-trip would round
   * neighbouring versions into false equality. Null when absent.
   */
  recordVersion: string | null;
}

/** Every sold-seat snapshot in this message. Roster-bearing types only. */
export function seatSnapshots(message: unknown): SeatSnapshot[] {
  const records = Array.isArray(message) ? message : [message];
  const out: SeatSnapshot[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r["$type"] !== "RaceAdvice" && r["$type"] !== "RaceStop") continue;
    if (r.RaceId === undefined || r.RaceId === null) continue;
    if (!Array.isArray(r.Drivers)) continue;
    const seen = new Set<string>();
    for (const d of r.Drivers as Record<string, unknown>[]) {
      if (!d || typeof d !== "object") continue;
      // No product, no seat. See the module doc.
      if (d.ProductId === undefined || d.ProductId === null) continue;
      if (d.DriverId === undefined || d.DriverId === null) continue;
      seen.add(String(d.DriverId));
    }
    out.push({
      sessionId: String(r.RaceId),
      seatIds: [...seen].sort(),
      recordVersion:
        r.RecordVersion === undefined || r.RecordVersion === null ? null : String(r.RecordVersion),
    });
  }
  return out;
}

/**
 * Is `next` a NEWER frame than `prev` for the same race?
 *
 * Compares the venue's `RecordVersion` as a string, because these are 17-digit
 * numbers that must never be parsed. Equal-length numeric strings compare
 * correctly lexicographically, so the common case is exact; different lengths
 * fall back to length, which is the correct ordering for unsigned decimals.
 *
 * A missing version on either side answers TRUE — an unversioned frame is
 * treated as new rather than discarded, because losing a real departure is
 * worse than processing one twice (processing twice is idempotent: the seat set
 * is rewritten to the same value and no departure is detected).
 */
export function isNewerFrame(prev: string | null, next: string | null): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return next.length > prev.length;
  return next > prev;
}

/** Which sold seats present in `prev` are absent from `next`. */
export function departedSeats(prev: string[], next: string[]): string[] {
  if (prev.length === 0) return [];
  const now = new Set(next);
  return prev.filter((id) => !now.has(id));
}
