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
  isImplemented: (scene: SceneType) => boolean = () => true,
): RotationSegment[] {
  const segments: RotationSegment[] = [];
  let startSlot = 0;
  for (const entry of playlist) {
    // A scene this deploy cannot render must never be selected — it would paint
    // as something else and look like the screen ignoring its config.
    if (!isImplemented(entry.scene)) continue;
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
 * Every VIP party inside the greeting window right now, most urgent first.
 *
 * Window is (floorMins, leadMins]: we start greeting at ~10 minutes out and
 * STOP at ~3, because by then they are walking up and a screen telling them
 * they're late is worse than silence. The bowling step is what matters — that's
 * the leg the guest has to be somewhere for.
 */
export function vipCandidatesAt(
  nowMs: number,
  vips: VipEntry[] | null,
  cfg: ResolvedScreenConfig["vip"],
  stepLabelMatches: (label: string) => boolean,
): { vip: VipEntry; minsUntil: number }[] {
  if (!cfg.enabled || !vips || vips.length === 0) return [];
  const out: { vip: VipEntry; minsUntil: number }[] = [];
  for (const vip of vips) {
    for (const step of vip.schedule) {
      if (!stepLabelMatches(step.label)) continue;
      const mins = minutesUntil(step.iso, nowMs);
      if (mins == null) continue;
      if (mins > cfg.floorMins && mins <= cfg.leadMins) {
        out.push({ vip, minsUntil: mins });
        break; // one entry per party, on its soonest matching leg
      }
    }
  }
  // Soonest first; id as the tie-break so the order is total and two screens
  // can never disagree about it.
  out.sort((a, b) => a.minsUntil - b.minsUntil || a.vip.id.localeCompare(b.vip.id));
  return out;
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
 * Is this event big enough to take THIS screen over?
 *
 * The answer depends on which kind of board is asking:
 *
 * KARTING BOARDS celebrate birthdays and nothing else. Racers scan in bursts —
 * a party of eight is through the desk in twenty seconds — so a takeover per
 * scan would queue over a minute of them and bury the session the board exists
 * to show. Ordinary scans live on the rail; the takeover is earned. A birthday
 * also IGNORES track scope: birthday check-in happens at race check-in
 * downstairs, which serves both tracks, so both boards run it together
 * (owner 2026-08-11).
 *
 * LOBBY BOARDS celebrate kiosk bookings and check-ins — the guest is standing
 * at the bank directly below the screen, and reacting to them is the whole
 * point of hanging it there (owner 2026-08-11: "kiosk interactions can
 * interrupt"). They do NOT run race-check-in birthdays; that moment belongs to
 * the boards at the track. In-scope only, so a scoped lobby screen stays
 * quiet for the far end of the building.
 */
export function isTakeoverEvent(
  e: SignageEvent,
  forRacingBoard: boolean,
  scopeResourceIds: string[],
): boolean {
  if (forRacingBoard) return e.birthday === true; // scope deliberately ignored
  return (
    (e.kind === "booking-completed" || e.kind === "checkin-completed") &&
    eventInScope(e, scopeResourceIds)
  );
}

/** The newest event worth taking this screen over for. */
export function celebrationAt(
  nowMs: number,
  events: SignageEvent[],
  cfg: ResolvedScreenConfig["celebration"],
  scopeResourceIds: string[],
  seen: ReadonlySet<string>,
  isRacingBoard: boolean,
): SignageEvent | null {
  if (!cfg.enabled) return null;
  const maxAgeMs = cfg.maxAgeSecs * 1000;
  let best: SignageEvent | null = null;
  for (const e of events) {
    if (seen.has(e.id)) continue;
    if (!isTakeoverEvent(e, isRacingBoard, scopeResourceIds)) continue;
    const age = nowMs - e.atMs;
    // Guard both ends: a future-stamped event (clock skew on the writer) is as
    // untrustworthy as an ancient one.
    if (age < -5_000 || age > maxAgeMs) continue;
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
  const inWindow = events
    .filter((e) => {
      if (e.kind !== "racer-scanned") return false;
      const age = nowMs - e.atMs;
      if (age < -5_000 || age > windowMs) return false;
      return eventInScope(e, scopeResourceIds);
    })
    .sort((a, b) => b.atMs - a.atMs);

  // ONE ENTRY PER RACER. A racer who swipes four times landed on the board four
  // times (owner 2026-08-11) — the board is a list of who is here, so a person
  // appearing twice is simply wrong. Newest wins, because the latest swipe is the
  // one carrying current state (a headsock handed over between swipes, say).
  const seen = new Set<string>();
  const deduped: SignageEvent[] = [];
  for (const e of inWindow) {
    const key = racerIdentity(e);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(e);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

/**
 * A stable per-racer key for a scan, or null when there is nothing to key on.
 *
 * Prefers the explicit `racerKey`. Falls back to parsing the event id, whose shape
 * is `scan-{personId}-{sessionId}-{timestamp}` — needed because the rail holds an
 * hour of events and the ones published before `racerKey` existed must dedupe too,
 * rather than the fix appearing to do nothing for the first hour after a deploy.
 *
 * Null for anything else (simulated scans, hand-made events), which keeps those
 * unique instead of collapsing every one of them into a single entry.
 */
function racerIdentity(e: SignageEvent): string | null {
  if (e.racerKey) return e.racerKey;
  const m = /^scan-([^-]+)-([^-]+)-/.exec(e.id);
  return m ? `${m[1]}:${m[2]}` : null;
}

/* ── the decision ─────────────────────────────────────────────────────── */

export interface DecisionInput {
  nowMs: number;
  config: ResolvedScreenConfig;
  hasData: (scene: SceneType) => boolean;
  events: SignageEvent[];
  seenEventIds: ReadonlySet<string>;
  /** Venue closed — panel saver wins over everything. */
  asleep?: boolean;
  /** Does this deploy actually have the scene? Defaults to yes. */
  isImplemented?: (scene: SceneType) => boolean;
}

/**
 * What the screen shows at this instant.
 *
 * PRECEDENCE, highest first:
 *   sleep  →  celebration  →  billboard crown  →  rotation
 *
 * VIP is deliberately NOT here (owner 2026-08-11: "it shouldn't just take over
 * everything, that doesn't make sense"). VIP parties are a gold slide the
 * welcome board interleaves with its own pages — rotation content, not an
 * interrupt. The only things that preempt are a moment happening right now
 * (celebration) and the bank choreography (crown).
 */
export function resolveActiveScene(input: DecisionInput): SceneDecision {
  const { nowMs, config } = input;
  const implemented = input.isImplemented ?? (() => true);

  if (input.asleep) {
    // startedAtMs 0, NOT nowMs: sleep has no meaningful start, and a ticking
    // start would remount the scene every decision tick (the VIP freak-out,
    // same mechanism).
    return { scene: "sleep", startedAtMs: 0, durationMs: null, isInterrupt: true };
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

  if (implemented("billboard-crown") && crownActiveAt(nowMs, config.billboardCrown)) {
    const cycleStart = Math.floor(nowMs / SLOT_MS) * SLOT_MS;
    return {
      scene: "billboard-crown",
      startedAtMs: cycleStart,
      durationMs: CROWN_WINDOW_MS,
      isInterrupt: true,
    };
  }

  const segments = buildRotation(config.playlist, input.hasData, implemented);
  const { segment, startedAtMs, durationMs } = rotationAt(nowMs, segments);
  return { scene: segment.scene, startedAtMs, durationMs, isInterrupt: false };
}
