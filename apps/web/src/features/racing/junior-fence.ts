/**
 * Junior adjacency fence — plan which EMPTY heats need a BMI product limit.
 *
 * Pure. No fetch, no React, no clock of its own. Given one day's BMI sessions
 * it returns the fences to add and the fences no longer justified. The server
 * half (junior-fence.server.ts) does the I/O; this file is the whole rule.
 *
 * ── Why a BMI-side fence exists at all ──
 * `blue/mega-no-back-to-back-junior` in race-restriction-rules.ts already
 * blocks a junior session adjacent to another junior session — but only on our
 * web + kiosk surfaces. The register, the phone and BMI's own dayplanner never
 * run it, and 30 days of live sessions (7/18–8/16) carried 125 back-to-back
 * junior pairs anyway, ~4.3/day. A BMI product limit locked on the neighbouring
 * slot is enforced by BMI itself, so it binds every channel at once.
 *
 * That is also why this is a SWEEP and not a hook on our own booking confirm:
 * `/bmi/sessions` sits downstream of all three channels, so one reader/writer
 * covers them all. Hooking `patchHeatSetups` as well would be a second writer
 * on the same BMI entity — see tasks/lessons.md, ONE writer per BMI entity.
 * The picker rules stay exactly as they are; they explain the block to the
 * guest, this is the backstop underneath them.
 *
 * ── Finding empty slots without an availability call ──
 * BMI materialises a session row only when something is booked into it (or when
 * we fence it), so an empty heat is simply ABSENT from `/bmi/sessions`. Heat
 * starts are a pure function of the day's grid — `heat n = open + (n-1) ×
 * cadence` — so the gaps in that grid ARE the fenceable slots. One cheap GET
 * per day yields both the junior heats and their empty neighbours.
 *
 * ── Slot identity is the TIME, never the heat number ──
 * BMI heat numbers are a display artefact (see the heat-numbering lore: Blue 51
 * ≠ Red 51, and numbers are per-track). We derive every slot index from
 * `scheduledStart` and use the number parsed out of the name only as a
 * cross-check, surfaced as `numberMismatch` rather than trusted.
 */
import { TRACK_ADJACENT_GAP_MIN } from "~/features/booking/service/conflict";
import { fasttraxHoursFor, weekdayOfIsoDate } from "~/lib/constants/fasttrax-hours";
import type { RaceTier } from "~/features/booking/service/race-products";

/**
 * Every track runs a 12-min cadence (owner 2026-07-02; Blue was 15-min before).
 * This and `TRACK_ADJACENT_GAP_MIN` (13 = cadence + 1) must move together — the
 * assertion in `adjacencyIsOneSlot` fails loudly if they ever drift apart.
 */
export const HEAT_CADENCE_MIN = 12;

/**
 * Only Blue and Mega sell junior products (race-products.ts), so Red can never
 * need a fence. Listing them rather than deriving keeps a new junior product on
 * Red from silently enrolling that track before anyone has thought about it.
 */
export const FENCE_TRACKS = ["Blue", "Mega"] as const;
export type FenceTrack = (typeof FENCE_TRACKS)[number];

/**
 * The adjacency the picker rule enforces (13 min at a 12-min cadence) is
 * exactly ±1 slot. We plan in slot indices, which is exact; this guards the
 * equivalence so a cadence change can't silently turn ±1 slot into the wrong
 * distance.
 */
export function adjacencyIsOneSlot(track: FenceTrack): boolean {
  const gap = TRACK_ADJACENT_GAP_MIN[track.toLowerCase()];
  return gap > HEAT_CADENCE_MIN && gap <= 2 * HEAT_CADENCE_MIN;
}

/** One row as `GET /bmi/sessions` returns it (only the fields we read). */
export interface BmiSessionRow {
  sessionId: string;
  name: string;
  /** UTC instant, e.g. "2026-08-16T19:36:00.000Z". Null rows are skipped. */
  scheduledStart: string | null;
}

/** A heat that exists in BMI, placed on the day's grid. */
export interface PlacedHeat {
  sessionId: string;
  name: string;
  track: FenceTrack;
  /** 1-based index on the day's grid; heat 1 starts at open. */
  slot: number;
  /** Naive center-local start, the format the PATCH matches on. */
  startLocal: string;
  junior: boolean;
  tier: RaceTier | null;
  /** Group-function heat ("Blue GF Starter"). */
  gf: boolean;
  /** Already carries our product limit (named "<n> - <limitName>"). */
  fenced: boolean;
  /** The number BMI printed in the name. DISPLAY ONLY — see numberOffsets. */
  namedNumber: number | null;
}

/** A slot we want to fence, or unfence. */
export interface FenceTarget {
  track: FenceTrack;
  slot: number;
  /** Naive center-local start — what the PATCH sends as `heatStart`. */
  startLocal: string;
  /** Why: the junior heats whose adjacency this slot sits in. */
  becauseOf: { slot: number; startLocal: string; name: string }[];
  /** Set on `remove` entries only. */
  sessionId?: string;
}

export interface FencePlan {
  date: string;
  /** Empty, still-future slots adjacent to a junior heat and not yet fenced. */
  add: FenceTarget[];
  /** Fenced slots whose justification is gone (the junior booking left). */
  remove: FenceTarget[];
  /** Fenced, still justified — no action, reported so a run is legible. */
  keep: FenceTarget[];
  /** Every race heat we could place, for logging / tests. */
  placed: PlacedHeat[];
  /** Junior heats that are ALREADY back-to-back — the fence arrived too late
   *  (or was never there). Not actionable, but the number that should fall. */
  existingAdjacentJuniorSlots: number[];
  /**
   * Distinct values of `namedNumber − slot` seen on the day.
   *
   * BMI's heat numbering has a per-day origin that is NOT the day's open: on
   * 2026-08-16 the offset was 0 (heat 24 = slot 24), on 2026-08-03 it was +10
   * for every row (heat 13 sat at 13:24, slot 3). So a number can never be used
   * to locate a slot — hence time-as-identity throughout. A day is internally
   * consistent when this holds exactly ONE value; more than one means the
   * numbering drifted mid-day and the log deserves a look.
   */
  numberOffsets: number[];
  /** Slots BMI returned more than one row for (e.g. "47 - …", "… (2)", "… (3)"
   *  all at 20:12 on 2026-08-03 — one physical block, three session rows). */
  duplicateSlots: number[];
  /** Rows we could not place (unparseable name, off-grid start, other track). */
  skipped: { name: string; reason: string }[];
}

/** `"13 - Blue Junior Intermediate"` / `"24 - Adult Only"` / `"7 - Blue GF Starter"`. */
const HEAT_NAME_RE =
  /^\s*(\d+)\s*-\s*(Red|Blue|Mega)\s+(GF\s+)?(Junior\s+)?(Starter|Intermediate|Pro)\b/i;
/** A fenced-but-unbooked heat: heat number + the limit's own name, nothing else. */
const FENCED_NAME_RE = /^\s*(\d+)\s*-\s*(.+?)\s*$/;

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** UTC instant → center-local `{date, minutes since local midnight}`. */
export function etDateAndMinutes(utcIso: string): { date: string; minutes: number } | null {
  const t = new Date(utcIso);
  if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(ET_FMT.formatToParts(t).map((x) => [x.type, x.value]));
  // Intl renders midnight as "24" in some ICU versions; normalise to 0.
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

/** Minutes since local midnight → naive center-local ISO on `date`. */
export function localStartIso(date: string, minutes: number): string {
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00`;
}

/** How many heats the day's grid holds, and when heat 1 starts. */
export function gridFor(date: string): { openMinutes: number; slots: number } {
  const { openMinutes, closeMinutes } = fasttraxHoursFor(weekdayOfIsoDate(date), date);
  // A heat must START before close; closeMinutes > 1440 means after midnight.
  const slots = Math.max(0, Math.ceil((closeMinutes - openMinutes) / HEAT_CADENCE_MIN));
  return { openMinutes, slots };
}

/** 1-based slot index for a center-local clock time, or null if off-grid. */
export function slotForMinutes(date: string, minutes: number): number | null {
  const { openMinutes, slots } = gridFor(date);
  const offset = minutes - openMinutes;
  if (offset < 0 || offset % HEAT_CADENCE_MIN !== 0) return null;
  const slot = offset / HEAT_CADENCE_MIN + 1;
  return slot >= 1 && slot <= slots ? slot : null;
}

/** Center-local start of a 1-based slot. */
export function startForSlot(date: string, slot: number): string {
  const { openMinutes } = gridFor(date);
  return localStartIso(date, openMinutes + (slot - 1) * HEAT_CADENCE_MIN);
}

export interface PlanInput {
  /** Center-local calendar date being planned, `YYYY-MM-DD`. */
  date: string;
  /** Every session BMI returned for that date, all attractions — we filter. */
  sessions: BmiSessionRow[];
  /** The product limit's current name in BMI, e.g. "Adult Only". Renamed three
   *  times on 2026-08-16 alone, so it is a parameter, never a literal. */
  limitName: string;
  /** Epoch ms. Slots at or before this are never fenced — pointless, and on
   *  the live same-day sweep it stops us writing to heats that already ran. */
  nowMs: number;
  /** Don't fence a slot starting sooner than this. Mirrors the picker's
   *  last-minute thinking: a fence landing 40 seconds before the heat only
   *  blocks a walk-in nobody was going to sell anyway. */
  minLeadMinutes?: number;
}

/**
 * Work out the day's fences. Returns what to add, what is no longer justified,
 * and what is already correct — the caller writes nothing this function did not
 * name.
 */
export function planJuniorFences(input: PlanInput): FencePlan {
  const { date, sessions, limitName, nowMs } = input;
  const minLead = (input.minLeadMinutes ?? 0) * 60_000;
  const placed: PlacedHeat[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const { slots: totalSlots } = gridFor(date);

  for (const s of sessions) {
    if (!s.scheduledStart) {
      skipped.push({ name: s.name, reason: "no scheduledStart" });
      continue;
    }
    const et = etDateAndMinutes(s.scheduledStart);
    if (!et) {
      skipped.push({ name: s.name, reason: "unparseable scheduledStart" });
      continue;
    }
    if (et.date !== date) {
      // A range query can straddle midnight (Fri/Sat close at 12:00 AM).
      skipped.push({ name: s.name, reason: `other date ${et.date}` });
      continue;
    }

    const booked = s.name.match(HEAT_NAME_RE);
    const fencedMatch = !booked ? s.name.match(FENCED_NAME_RE) : null;
    const isFenced = Boolean(
      fencedMatch && fencedMatch[2].trim().toLowerCase() === limitName.trim().toLowerCase(),
    );

    // A fenced-only row carries no track in its name ("24 - Adult Only"), so
    // its track has to come from the caller's per-track query. Handled by
    // planning one track at a time — see planDayByTrack.
    if (!booked && !isFenced) {
      skipped.push({ name: s.name, reason: "not a race heat" });
      continue;
    }

    const track = booked
      ? ((booked[2][0].toUpperCase() + booked[2].slice(1).toLowerCase()) as FenceTrack)
      : null;
    if (booked && !FENCE_TRACKS.includes(track as FenceTrack)) {
      skipped.push({ name: s.name, reason: `track ${track} carries no junior products` });
      continue;
    }

    const slot = slotForMinutes(date, et.minutes);
    if (slot == null) {
      skipped.push({ name: s.name, reason: `off-grid start ${localStartIso(date, et.minutes)}` });
      continue;
    }

    const namedNumber = Number((booked ?? fencedMatch)?.[1]);
    placed.push({
      sessionId: s.sessionId,
      name: s.name,
      // A fenced row's track is supplied by the caller's query scope.
      track: (track ?? (null as unknown as FenceTrack)) as FenceTrack,
      slot,
      startLocal: startForSlot(date, slot),
      junior: Boolean(booked?.[4]),
      tier: booked ? (booked[5].toLowerCase() as RaceTier) : null,
      gf: Boolean(booked?.[3]),
      fenced: isFenced,
      namedNumber: Number.isFinite(namedNumber) ? namedNumber : null,
    });
  }

  // One physical block can carry several session rows (a restart, or BMI's
  // "… (2)" / "… (3)" duplicates). Collapse to one, preferring a junior row —
  // if ANY row on the slot is a junior session, the slot is a junior session,
  // and preferring it keeps the adjacency rule from missing a neighbour.
  const occupied = new Map<number, PlacedHeat>();
  const duplicateSlots: number[] = [];
  for (const h of placed) {
    const prev = occupied.get(h.slot);
    if (!prev) {
      occupied.set(h.slot, h);
      continue;
    }
    if (!duplicateSlots.includes(h.slot)) duplicateSlots.push(h.slot);
    if (h.junior && !prev.junior) occupied.set(h.slot, h);
    // A real booking always outranks a fence marker on the same slot.
    else if (prev.fenced && !h.fenced) occupied.set(h.slot, h);
  }

  const numberOffsets = [
    ...new Set(placed.filter((h) => h.namedNumber != null).map((h) => h.namedNumber! - h.slot)),
  ].sort((a, b) => a - b);

  // Desired fences: every empty slot beside a booked junior heat. Iterate the
  // collapsed map, not `placed`, so a triple-booked slot is considered once.
  const desired = new Map<number, FenceTarget["becauseOf"]>();
  const existingAdjacentJuniorSlots: number[] = [];
  for (const h of [...occupied.values()].sort((a, b) => a.slot - b.slot)) {
    if (!h.junior) continue;
    for (const neighbour of [h.slot - 1, h.slot + 1]) {
      if (neighbour < 1 || neighbour > totalSlots) continue;
      const sitting = occupied.get(neighbour);
      if (sitting?.junior) {
        // Already back-to-back — too late to prevent, but worth counting.
        if (!existingAdjacentJuniorSlots.includes(h.slot)) existingAdjacentJuniorSlots.push(h.slot);
        continue;
      }
      // Occupied by anything else: a fait accompli. Never touch a booked heat —
      // locking a limit onto a live party's heat could block their own add-ons.
      if (sitting && !sitting.fenced) continue;
      const why = desired.get(neighbour) ?? [];
      why.push({ slot: h.slot, startLocal: h.startLocal, name: h.name });
      desired.set(neighbour, why);
    }
  }

  // "Is this slot still worth fencing?" — compared entirely in center-local
  // minutes. Never build a Date from a naive local string; that reads it as UTC
  // and silently shifts by the offset.
  const etNow = etDateAndMinutes(new Date(nowMs).toISOString());
  const { openMinutes } = gridFor(date);
  const stillWorthFencing = (slot: number): boolean => {
    if (!etNow) return true; // unknowable clock — plan it, the server re-checks
    if (etNow.date > date) return false; // whole day is behind us
    if (etNow.date < date) return true; // future day — every slot qualifies
    const slotMinutes = openMinutes + (slot - 1) * HEAT_CADENCE_MIN;
    return slotMinutes - etNow.minutes >= minLead / 60_000;
  };

  const add: FenceTarget[] = [];
  const keep: FenceTarget[] = [];
  for (const [slot, becauseOf] of [...desired.entries()].sort((a, b) => a[0] - b[0])) {
    const sitting = occupied.get(slot);
    const target: FenceTarget = {
      track: FENCE_TRACKS[0],
      slot,
      startLocal: startForSlot(date, slot),
      becauseOf,
    };
    if (sitting?.fenced) {
      keep.push({ ...target, sessionId: sitting.sessionId });
      continue;
    }
    if (!stillWorthFencing(slot)) continue;
    add.push(target);
  }

  // Fenced slots whose junior justification is gone.
  const remove: FenceTarget[] = [];
  for (const h of occupied.values()) {
    if (!h.fenced || desired.has(h.slot)) continue;
    remove.push({
      track: h.track,
      slot: h.slot,
      startLocal: h.startLocal,
      becauseOf: [],
      sessionId: h.sessionId,
    });
  }

  return {
    date,
    add,
    remove,
    keep,
    placed,
    existingAdjacentJuniorSlots: existingAdjacentJuniorSlots.sort((a, b) => a - b),
    numberOffsets,
    duplicateSlots: duplicateSlots.sort((a, b) => a - b),
    skipped,
  };
}

/**
 * Plan one track. `sessions` must already be the response for THAT track
 * (`?resourceName=Blue Track`) — a fenced row is named "24 - Adult Only" with
 * no track word in it, so the track can only come from the query scope.
 */
export function planTrackFences(
  track: FenceTrack,
  input: Omit<PlanInput, "date"> & { date: string },
): FencePlan {
  const plan = planJuniorFences(input);
  const stamp = <T extends { track: FenceTrack }>(t: T): T => ({ ...t, track });
  return {
    ...plan,
    add: plan.add.map(stamp),
    remove: plan.remove.map(stamp),
    keep: plan.keep.map(stamp),
    placed: plan.placed.map(stamp),
  };
}
