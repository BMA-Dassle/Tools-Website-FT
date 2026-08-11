/**
 * Scene scheduling — PURE. No React, no clock reads, no I/O.
 *
 * Everything a screen shows is DERIVED from the shared wall clock, never
 * remembered. That single choice buys three things the platform depends on:
 *
 *   1. Two screens with the same playlist are frame-synced with NO messaging
 *      between them — the property the kiosk bank already proves.
 *   2. A TV that reboots at 3am rejoins the show mid-stride; there is no
 *      "position" to restore and nothing to drift.
 *   3. The whole thing is testable by passing a number in.
 *
 * SLOTS, NOT MILLISECONDS. Rotation time is quantized to the kiosk bank's 40s
 * billboard cycle (SLOT_MS === BILLBOARD_CYCLE_MS, imported so the two can
 * never drift apart). A scene asking for "about a minute and a half" gets 2
 * slots. Quantizing is what lets a TV drop into the bank's choreography on an
 * exact boundary instead of arriving halfway through a word.
 */
import { BILLBOARD_CYCLE_MS } from "~/features/kiosk/attract/billboard";
import type { ResolvedScreenConfig } from "../defaults";
import type { SceneType, SignageEvent, VipEntry } from "../types";

/** One rotation slot. Locked to the kiosk bank's cycle — see the note above. */
export const SLOT_MS = BILLBOARD_CYCLE_MS;

/**
 * How long the bank's billboard show occupies at the top of a joined cycle.
 * Derived from billboard.ts's own timeline (lead 900 + 5×1000 steps + hold 2200
 * + finale 3800). Pinned to `billboardStage` by a test rather than duplicated as
 * arithmetic here — if the choreography is ever retuned, that test fails loudly
 * instead of the crown quietly overstaying.
 */
export const CROWN_WINDOW_MS = 11_900;

/**
 * How long a birthday takeover holds both boards. Longer than an ordinary
 * celebration on purpose — it is a moment for the guest and the people with
 * them, and eight seconds is not enough to turn round and see it.
 */
export const BIRTHDAY_SHOW_MS = 16_000;

/** Which scene is on screen, and why — the director renders from this. */
export interface SceneDecision {
  scene: SceneType;
  /** Shared-clock ms this decision began (drives enter animations + seeks). */
  startedAtMs: number;
  /** Rotation only: how long this segment runs. Interrupts are open-ended. */
  durationMs: number | null;
  /** True when an interrupt preempted the base rotation. */
  isInterrupt: boolean;
  /** The event a celebration is showing, when that's the decision. */
  event?: SignageEvent;
  /** The VIP party a takeover is greeting, when that's the decision. */
  vip?: VipEntry;
}

/* ── base rotation ────────────────────────────────────────────────────── */

export interface RotationSegment {
  scene: SceneType;
  /** Slot index within the cycle where this segment starts. */
  startSlot: number;
  slots: number;
}

/**
 * Flatten a playlist into concrete segments, dropping entries whose data isn't
 * there. `hasData` answers "does this scene have anything to show right now?" —
 * an event-welcome board with no parties today is skipped so the rotation closes
 * over it, rather than rendering an empty panel on a lobby wall.
 *
 * Always returns at least one segment: a screen with nothing to say still shows
 * house ads, which need no data at all.
 */
export function buildRotation(
  playlist: ResolvedScreenConfig["playlist"],
  hasData: (scene: SceneType) => boolean,
): RotationSegment[] {
  const segments: RotationSegment[] = [];
  let startSlot = 0;
  for (const entry of playlist) {
    if (entry.requiresData && !hasData(entry.scene)) continue;
    segments.push({ scene: entry.scene, startSlot, slots: entry.slots });
    startSlot += entry.slots;
  }
  if (segments.length === 0) {
    return [{ scene: "ads", startSlot: 0, slots: 1 }];
  }
  return segments;
}

export function totalSlots(segments: RotationSegment[]): number {
  return segments.reduce((sum, s) => sum + s.slots, 0);
}

/**
 * The rotation segment playing at `nowMs`. Pure modular arithmetic on the shared
 * clock — no stored index, so every screen running this playlist agrees.
 */
export function rotationAt(
  nowMs: number,
  segments: RotationSegment[],
): { segment: RotationSegment; startedAtMs: number; durationMs: number } {
  const total = totalSlots(segments);
  const slot = Math.floor(nowMs / SLOT_MS);
  // `%` keeps a negative clock (test fixtures, a wildly wrong RTC) in range.
  const pos = ((slot % total) + total) % total;
  let segment = segments[segments.length - 1];
  for (const s of segments) {
    if (pos >= s.startSlot && pos < s.startSlot + s.slots) {
      segment = s;
      break;
    }
  }
  const slotsIntoSegment = pos - segment.startSlot;
  const startedAtMs = (slot - slotsIntoSegment) * SLOT_MS;
  return { segment, startedAtMs, durationMs: segment.slots * SLOT_MS };
}

/* ── billboard crown ──────────────────────────────────────────────────── */

/**
 * Is this screen inside a cycle where it crowns the kiosk bank's billboard?
 * Only true for a screen physically standing over a bank (config opt-in) and
 * only for the ~12s the show actually runs, so the base scene keeps the rest of
 * the cycle.
 */
export function crownActiveAt(
  nowMs: number,
  crown: ResolvedScreenConfig["billboardCrown"],
): boolean {
  if (!crown.enabled) return false;
  const cycle = Math.floor(nowMs / SLOT_MS);
  if (((cycle % crown.joinEvery) + crown.joinEvery) % crown.joinEvery !== 0) return false;
  const t = ((nowMs % SLOT_MS) + SLOT_MS) % SLOT_MS;
  return t < CROWN_WINDOW_MS;
}

/* ── VIP takeover ─────────────────────────────────────────────────────── */

/** Minutes until an ISO instant, on the shared clock. Null when unparseable. */
export function minutesUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (t - nowMs) / 60_000;
}

/**
 * The VIP party to greet right now, if any.
 *
 * Window is (floorMins, leadMins]: we start greeting at ~10 minutes out and
 * STOP at ~3, because by then they are walking up and a countdown telling them
 * they're late is worse than silence. The bowling step is what matters — that's
 * the leg the guest has to be somewhere for.
 */
export function vipTakeoverAt(
  nowMs: number,
  vips: VipEntry[] | null,
  cfg: ResolvedScreenConfig["vip"],
  stepLabelMatches: (label: string) => boolean,
): { vip: VipEntry; minsUntil: number } | null {
  if (!cfg.enabled || !vips || vips.length === 0) return null;
  let best: { vip: VipEntry; minsUntil: number } | null = null;
  for (const vip of vips) {
    for (const step of vip.schedule) {
      if (!stepLabelMatches(step.label)) continue;
      const mins = minutesUntil(step.iso, nowMs);
      if (mins == null) continue;
      if (mins > cfg.floorMins && mins <= cfg.leadMins) {
        // Soonest wins when two parties overlap — the more urgent greeting.
        if (!best || mins < best.minsUntil) best = { vip, minsUntil: mins };
      }
    }
  }
  return best;
}

/** Default matcher: the VIP itinerary's bowling leg. */
export function isBowlingStep(label: string): boolean {
  return /bowl/i.test(label);
}

/* ── celebrations ─────────────────────────────────────────────────────── */

/** Does this event belong to this screen? Empty scope = the whole venue. */
export function eventInScope(e: SignageEvent, scopeResourceIds: string[]): boolean {
  if (scopeResourceIds.length === 0) return true;
  return !!e.resourceId && scopeResourceIds.includes(e.resourceId);
}

/**
 * Is this event big enough to take the WHOLE screen?
 *
 * Only the rare, genuinely special ones. Racers scan in bursts — a party of
 * eight can be through the desk in twenty seconds — so a full-screen takeover
 * per scan would queue over a minute of them, bury the session information the
 * screen exists to show, and land the last person's welcome long after they had
 * walked away (owner, 2026-08-11).
 *
 * Ordinary scans appear instead as a LIVE RAIL of names inside the scene,
 * several at once, while the session stays up. That also earns the takeover its
 * impact: when the whole wall does change, it is somebody's birthday.
 */
export function isTakeoverEvent(e: SignageEvent): boolean {
  return e.birthday === true;
}

/**
 * The newest event worth taking the whole screen over for.
 *
 * A BIRTHDAY IGNORES TRACK SCOPE. Birthday check-in happens at race check-in
 * downstairs, which serves both tracks — so it is one building-wide moment and
 * BOTH karting boards run it together, whatever track the racer is on and
 * whether or not it is a Mega day (owner 2026-08-11). Scoping it by track is
 * what made only one board light up.
 *
 * But it belongs ONLY to the karting boards — `isRacingBoard`. A lobby TV
 * across the building has no part in a race check-in and must not take itself
 * over for one.
 */
export function celebrationAt(
  nowMs: number,
  events: SignageEvent[],
  cfg: ResolvedScreenConfig["celebration"],
  scopeResourceIds: string[],
  seen: ReadonlySet<string>,
  isRacingBoard: boolean,
): SignageEvent | null {
  if (!cfg.enabled) return null;
  if (!isRacingBoard) return null;
  const maxAgeMs = cfg.maxAgeSecs * 1000;
  let best: SignageEvent | null = null;
  for (const e of events) {
    if (seen.has(e.id)) continue;
    if (!isTakeoverEvent(e)) continue;
    const age = nowMs - e.atMs;
    // Guard both ends: a future-stamped event (clock skew on the writer) is as
    // untrustworthy as an ancient one.
    if (age < -5_000 || age > maxAgeMs) continue;
    // NB: deliberately no scope check — see the note above.
    if (!best || e.atMs > best.atMs) best = e;
  }
  return best;
}

/** Does this screen run the race check-in scene? Only those boards take part in
 *  a race-check-in birthday. */
export function isRacingBoard(playlist: ResolvedScreenConfig["playlist"]): boolean {
  return playlist.some((p) => p.scene === "race-checkin");
}

/**
 * Everyone who has checked in here recently, newest first — the live rail.
 *
 * Deliberately a LIST rather than one-at-a-time: rapid scanning is the normal
 * case at race check-in, and a party wants to watch the whole group land.
 */
export function recentScans(
  nowMs: number,
  events: SignageEvent[],
  scopeResourceIds: string[],
  windowMs: number,
  limit: number,
): SignageEvent[] {
  return events
    .filter((e) => {
      if (e.kind !== "racer-scanned") return false;
      const age = nowMs - e.atMs;
      if (age < -5_000 || age > windowMs) return false;
      return eventInScope(e, scopeResourceIds);
    })
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, limit);
}

/* ── the decision ─────────────────────────────────────────────────────── */

export interface DecisionInput {
  nowMs: number;
  config: ResolvedScreenConfig;
  hasData: (scene: SceneType) => boolean;
  vips: VipEntry[] | null;
  events: SignageEvent[];
  seenEventIds: ReadonlySet<string>;
  /** Venue closed — panel saver wins over everything. */
  asleep?: boolean;
}

/**
 * What the screen shows at this instant.
 *
 * PRECEDENCE, highest first:
 *   sleep  →  celebration  →  VIP takeover  →  billboard crown  →  rotation
 *
 * Celebration outranks the VIP takeover deliberately: it is 8 seconds long and
 * it is about a guest who is standing right there, right now. The VIP takeover
 * has a multi-minute window and loses nothing by yielding briefly.
 */
export function resolveActiveScene(input: DecisionInput): SceneDecision {
  const { nowMs, config } = input;

  if (input.asleep) {
    return { scene: "sleep", startedAtMs: nowMs, durationMs: null, isInterrupt: true };
  }

  const event = celebrationAt(
    nowMs,
    input.events,
    config.celebration,
    config.scope.resourceIds,
    input.seenEventIds,
    isRacingBoard(config.playlist),
  );
  if (event) {
    return {
      scene: "celebration",
      startedAtMs: event.atMs,
      // A birthday takes over both boards and deserves room to land; an
      // ordinary scan is a glance. Same scene slot, very different moment.
      durationMs: event.birthday ? BIRTHDAY_SHOW_MS : config.celebration.showMs,
      isInterrupt: true,
      event,
    };
  }

  const vip = vipTakeoverAt(nowMs, input.vips, config.vip, isBowlingStep);
  if (vip) {
    return {
      scene: "vip-welcome",
      startedAtMs: nowMs,
      durationMs: null,
      isInterrupt: true,
      vip: vip.vip,
    };
  }

  if (crownActiveAt(nowMs, config.billboardCrown)) {
    const cycleStart = Math.floor(nowMs / SLOT_MS) * SLOT_MS;
    return {
      scene: "billboard-crown",
      startedAtMs: cycleStart,
      durationMs: CROWN_WINDOW_MS,
      isInterrupt: true,
    };
  }

  const segments = buildRotation(config.playlist, input.hasData);
  const { segment, startedAtMs, durationMs } = rotationAt(nowMs, segments);
  return { scene: segment.scene, startedAtMs, durationMs, isInterrupt: false };
}
