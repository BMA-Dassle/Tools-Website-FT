/**
 * Race Sims CIRCUIT catalog + the weekly programming.
 *
 * ── Why this is a separate file from products.ts ─────────────────────────────
 * `RACE_SIM_TRACKS` in products.ts are the three BMI $0 KEYS. Those are fixed
 * forever: their ids are armed in BMI, their labels are written into
 * `booking_metadata.racesims[].track` at reserve, and that string is read back
 * out of Neon to enforce the sim conflict rules (lib/bowling-db.ts
 * raceHeatsForPersonsOnDate → scheduling.ts isRaceSimTrackLabel).
 *
 * The CIRCUIT is what the guest actually picks — "Bristol Motor Speedway" —
 * and it ROTATES. Those two things must never be the same string:
 *
 *   If the key's persisted label became the circuit name, then every sim
 *   already booked under last week's lineup would stop being recognised as a
 *   sim by isRaceSimTrackLabel, and would silently fall back to the 30-minute
 *   cross-activity rule instead of the same-start rule. That breaks once per
 *   rotation, forever, and it breaks in the past — for bookings already sold.
 *
 * So: the key label is STABLE and machine-facing; the circuit is DISPLAY and
 * rotates. Everything a guest reads comes from here; everything a rule keys
 * off comes from products.ts.
 *
 * ── One session runs ONE circuit ─────────────────────────────────────────────
 * There are FOUR RIGS and one shared capacity pool (scheduling.ts: "the SAME
 * time slot on any track is the same four rigs"). A 10:00 session is therefore
 * one circuit for everyone in it. The first booking on a slot LOCKS that slot's
 * circuit (owner 2026-09-15); later parties join the circuit already running.
 * The lock is resolved from our own Neon rows — see `simSlotCircuitLocks` in
 * lib/bowling-db.ts and guard 2f in unified-reserve.ts.
 *
 * Circuit facts below are real-world specifications, sourced and transcribed —
 * not estimates. Do not "tidy" a number without re-checking the source.
 */

export type SimCircuitLayout = "street" | "oval";

export interface SimCircuit {
  /** Stable id used in the lineup + persisted alongside the booking. Never
   *  reused for a different circuit. */
  id: string;
  /** Proper name — a real venue, so it stays English in every locale (same
   *  rule as FastTrax / HeadPinz in the kiosk glossary). */
  name: string;
  /** Short form for tight spaces (cards, cart subtitles, Square line names). */
  shortName: string;
  /** The series/event this layout is known for — EN. */
  eventName: string;
  /** Guest-facing one-liner — EN. */
  blurb: string;
  /** Spanish for the two translatable fields. The circuit NAME is never
   *  translated; these are the descriptive parts around it. */
  es: { eventName: string; blurb: string };
  layout: SimCircuitLayout;
  /** Lap length, miles and km — both carried so no surface has to convert
   *  (and round) on its own. */
  lengthMi: number;
  lengthKm: number;
  turns: number;
  /** The one stat worth putting on a card — EN. */
  signature: string;
  /** Spanish signature line. */
  signatureEs: string;
  /** Card accent. Belongs to the CIRCUIT, not the key, so a track card looks
   *  the same wherever that circuit appears in the rotation. */
  accent: string;
}

/**
 * Every circuit we can programme. Adding one here does NOT put it on sale —
 * a lineup below has to reference it.
 */
export const SIM_CIRCUITS: readonly SimCircuit[] = [
  {
    id: "baku",
    name: "Baku City Circuit",
    shortName: "Baku",
    eventName: "Azerbaijan Grand Prix",
    blurb: "Flat-out down a two-kilometre straight, then thread the castle walls at walking pace.",
    es: {
      eventName: "Gran Premio de Azerbaiyán",
      blurb:
        "A fondo por una recta de dos kilómetros y luego a paso de hombre entre las murallas del castillo.",
    },
    layout: "street",
    lengthMi: 3.73,
    lengthKm: 6.003,
    turns: 20,
    signature: "Formula 1's longest straight — 2.2 km",
    signatureEs: "La recta más larga de la Fórmula 1: 2,2 km",
    accent: "#00b5a5",
  },
  {
    id: "bristol",
    name: "Bristol Motor Speedway",
    shortName: "Bristol",
    eventName: "NASCAR short track",
    blurb: "Half a mile of concrete banked like a bowl. Everyone is close. Nobody is safe.",
    es: {
      eventName: "Óvalo corto de NASCAR",
      blurb:
        "Media milla de concreto peraltada como un tazón. Todos van pegados. Nadie está a salvo.",
    },
    layout: "oval",
    lengthMi: 0.533,
    lengthKm: 0.858,
    turns: 4,
    signature: "Banking up to 30° — the steepest on the circuit",
    signatureEs: "Peraltes de hasta 30°: los más inclinados del calendario",
    accent: "#e53935",
  },
  {
    id: "indianapolis",
    name: "Indianapolis Motor Speedway",
    shortName: "Indianapolis",
    eventName: "Indianapolis 500",
    blurb: "Two and a half miles, four identical corners, and absolutely nowhere to hide.",
    es: {
      eventName: "Indianápolis 500",
      blurb: "Cuatro kilómetros, cuatro curvas idénticas y ningún lugar donde esconderse.",
    },
    layout: "oval",
    lengthMi: 2.5,
    lengthKm: 4.023,
    turns: 4,
    signature: "Corners banked 9°12′ — unchanged since 1909",
    signatureEs: "Curvas con peralte de 9°12′: sin cambios desde 1909",
    accent: "#ffb300",
  },
] as const;

export function getSimCircuit(id: string | null | undefined): SimCircuit | null {
  if (!id) return null;
  return SIM_CIRCUITS.find((c) => c.id === id) ?? null;
}

/**
 * ONE WEEK'S PROGRAMMING: which circuit each $0 track key is running.
 *
 * `from` is the first operating day the lineup applies to (ET, inclusive). The
 * lineup in force on a date is the LATEST entry whose `from` is on or before
 * it, so programming next week is one entry appended here — no edit to a live
 * row, and the history stays readable for anything looking back at an old
 * booking.
 *
 * Keys are the stable track keys from products.ts, NOT circuit ids, because
 * the key is what BMI holds the seat against.
 */
export interface SimLineup {
  /** YYYY-MM-DD, ET, inclusive. */
  from: string;
  /** trackKey → circuit id. */
  a: string;
  b: string;
  c: string;
}

/**
 * The programmed lineups, oldest first.
 *
 * 2026-09-15 (owner): Azerbaijan GP, Bristol Motor Speedway, Indianapolis
 * Motor Speedway. This is the first real lineup — everything before it was the
 * "Track A/B/C" placeholder phase, which is why there is no earlier entry.
 */
export const RACE_SIM_LINEUPS: readonly SimLineup[] = [
  { from: "2026-09-15", a: "baku", b: "bristol", c: "indianapolis" },
] as const;

/** The lineup in force on `ymd`, or null if the date predates the first one. */
export function simLineupFor(ymd: string): SimLineup | null {
  let found: SimLineup | null = null;
  for (const lineup of RACE_SIM_LINEUPS) {
    if (lineup.from <= ymd) found = lineup;
  }
  return found;
}

/**
 * The circuit a track key is running on a date. Null before the first lineup
 * (the placeholder phase) or for an unknown key — callers fall back to the
 * key's own stable label, which is exactly what the kiosk showed pre-launch.
 */
export function circuitForTrack(
  trackKey: string | null | undefined,
  ymd: string,
): SimCircuit | null {
  if (trackKey !== "a" && trackKey !== "b" && trackKey !== "c") return null;
  const lineup = simLineupFor(ymd);
  if (!lineup) return null;
  return getSimCircuit(lineup[trackKey]);
}

/**
 * The name to PRINT for a booked session — on a receipt line, a cart row, a
 * BMI line label.
 *
 * Keyed off the session's OWN date, not today, so a receipt reprinted after the
 * lineup rotates still names the circuit that was actually raced. Falls back to
 * the key's stable label for dates before the first lineup (the placeholder
 * phase), which is exactly what those bookings were sold as.
 */
export function simSessionCircuitName(
  trackKey: string | null | undefined,
  slotIso: string,
  fallback: string,
): string {
  return circuitForTrack(trackKey, slotIso.slice(0, 10))?.name ?? fallback;
}

/** Lap length for a card: "0.533 mi · 0.86 km". Two surfaces wanted this and
 *  rounded it differently, so it lives in one place. */
export function circuitLengthLabel(circuit: SimCircuit): string {
  return `${circuit.lengthMi.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} mi · ${circuit.lengthKm.toFixed(2)} km`;
}
