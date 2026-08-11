/**
 * Lobby-TV signage — the config + data contracts.
 *
 * THE CENTRAL IDEA: a scene TYPE is code, but which scenes a given screen runs,
 * in what mix, with what triggers, is CONFIG stored per screen in Neon. Hanging
 * a second TV — a different room, a different job — is a row in
 * `signage_screens` and an admin checkbox, never a deploy. Everything below is
 * shaped to keep that true.
 *
 * ADDITIVE-ONLY, and never discard on shape mismatch. Every field a screen
 * config gains must be optional with a sane default resolved at read time. The
 * kiosk's CONFIG_VERSION incident (2026-07-26: a version bump + discard-on-
 * mismatch wiped every provisioned kiosk mid-service and they could not take
 * payments) is the reason there is no version field here at all — a config we
 * cannot fully parse is a config we partially honour, not one we throw away.
 */

/**
 * A scene is one full-screen visual. Adding a scene type is the only reason
 * this union changes; adding a SCREEN is not.
 *
 *  - `ads`            house advertising for what's purchasable at the kiosks
 *  - `event-welcome`  today's birthday parties + contracted group functions
 *  - `vip-welcome`    VIP party takeover ahead of their bowling leg
 *  - `celebration`    a booking/check-in just completed on a kiosk below
 *  - `billboard-crown` the TV joining the kiosk bank's billboard as its crown
 *  - `race-checkin`   the racing check-in screen: welcome the racer who just
 *                     scanned + show the session currently checking in
 *  - `sleep`          venue closed — panel/power saver
 */
export type SceneType =
  | "ads"
  | "event-welcome"
  | "vip-welcome"
  | "celebration"
  | "billboard-crown"
  | "race-checkin"
  | "sleep";

/** Scenes a screen rotates through on its base loop (interrupts are separate). */
export const ROTATION_SCENE_TYPES = [
  "ads",
  "event-welcome",
  "race-checkin",
] as const satisfies readonly SceneType[];

/** Scenes that PREEMPT the rotation when their trigger fires. */
export const INTERRUPT_SCENE_TYPES = [
  "vip-welcome",
  "celebration",
  "billboard-crown",
] as const satisfies readonly SceneType[];

/**
 * One entry in a screen's base rotation.
 *
 * `slots` is measured in 40-second billboard cycles, NOT free-form milliseconds.
 * Quantizing every scene to the kiosk bank's cycle length is what lets a TV drop
 * into the bank's billboard choreography on an exact boundary, and what keeps
 * two screens with the same playlist frame-synced with no messaging between
 * them. A scene that wants ~80s asks for 2 slots.
 */
export interface PlaylistEntry {
  scene: SceneType;
  /** Length in 40s slots. Defaults to 1. */
  slots?: number;
  /**
   * Skip this entry when its data selector comes back empty — an event-welcome
   * board with no events today must never render as a blank panel; the rotation
   * simply closes over it.
   */
  requiresData?: boolean;
}

/** VIP takeover tuning. */
export interface VipInterruptConfig {
  enabled?: boolean;
  /** Start greeting this many minutes before the VIP bowling leg. */
  leadMins?: number;
  /** Stop greeting once the leg is this close (they're walking up). */
  floorMins?: number;
  /** Hold the takeover at least this long once it starts. */
  minShowMs?: number;
}

/** Kiosk-activity celebration tuning. */
export interface CelebrationInterruptConfig {
  enabled?: boolean;
  /** Ignore events older than this — never replay stale joy after an outage. */
  maxAgeSecs?: number;
  /** How long one celebration holds the overlay. */
  showMs?: number;
}

/** Billboard-crown tuning (the TV performing as the kiosk bank's 7th screen). */
export interface BillboardCrownConfig {
  enabled?: boolean;
  /** Join every Nth 40s cycle. 1 = every cycle. */
  joinEvery?: number;
}

export interface ScreenInterrupts {
  "vip-welcome"?: VipInterruptConfig;
  celebration?: CelebrationInterruptConfig;
  "billboard-crown"?: BillboardCrownConfig;
}

/**
 * What slice of the venue this screen speaks for.
 *
 * Exists because of the racing check-in TVs: FastTrax has a Blue Track and a
 * Red Track screen, and a racer scanning in for Blue must light up the Blue TV
 * ONLY. Without a scope, every screen in a center reacts to every event in it.
 * Empty/absent scope = the whole venue (the kiosk-bank TV's case).
 */
export interface ScreenScope {
  /** BMI/Office resource ids this screen covers (e.g. Blue Track 11208654). */
  resourceIds?: string[];
  /** Center slugs whose group-function events belong on this screen. */
  gfCenterCodes?: string[];
}

/**
 * Multi-screen choreography group.
 *
 * When two or more screens should perform as ONE display — the owner's Mega-race
 * ask, where the Blue and Red TVs stop being independent and hand animation off
 * between them — each carries the same `groupId` and its own ordered `position`.
 * This is the identical primitive the kiosk bank already proves
 * (`bankPosition` + `billboardStage` + the shared clock): choreography derived
 * from position and wall-clock time, never from screens talking to each other.
 * A TV that reboots mid-show rejoins in step because nothing is remembered.
 */
export interface ScreenPairing {
  groupId: string;
  /** 0 = leftmost/first. */
  position: number;
  /** How many screens are in the group. */
  count: number;
}

/** The per-screen config blob (JSONB in Neon). Every field optional. */
export interface ScreenConfig {
  playlist?: PlaylistEntry[];
  interrupts?: ScreenInterrupts;
  scope?: ScreenScope;
  pairing?: ScreenPairing;
  /** Which ad slide set to run. Defaults to the venue's own. */
  adSet?: string;
  /** Minutes before an event's first leg that it appears on the welcome board. */
  welcomeLeadMins?: number;
  /** Minutes after the first leg starts that it drops off the welcome board. */
  welcomeTrailMins?: number;
}

/** A provisioned screen — one row of `signage_screens`. */
export interface SignageScreen {
  screenId: string;
  venue: string;
  center: string;
  screenNumber: number;
  /** Staff-facing placement name, e.g. "Above the kiosk bank". */
  name: string;
  config: ScreenConfig;
  updatedAt: string;
}

/* ── the live event rail ──────────────────────────────────────────────── */

export type SignageEventKind = "booking-completed" | "checkin-completed" | "racer-scanned";

/**
 * Something just happened on a device in the building, pushed onto a short Redis
 * list for the TVs to notice on their next poll. Deliberately ephemeral: this is
 * a display cue, never a record — the durable truth is already in Neon/BMI.
 *
 * PII posture: `firstName` ONLY, and only because a lobby TV is going to print
 * it 8 feet tall anyway ("Welcome, Marcus!"). No last name, no ids, no contact
 * details ever ride this rail.
 */
export interface SignageEvent {
  id: string;
  kind: SignageEventKind;
  center: string;
  /** First name only — the greeting. Absent ⇒ generic copy. */
  firstName?: string;
  /** BMI/Office resource this concerns (track/lane), for screen scoping. */
  resourceId?: string;
  /** Which kiosk in the bank, when it came from one. */
  kioskNumber?: number;
  /** Coarse activity keys for copy + accent colour, e.g. ["bowling"]. */
  activityKeys?: string[];
  partySize?: number;
  /** This racer is on an Ultimate VIP combo today — drives the gold treatment
   *  and the "proceed to the in-field" instruction on a track screen. */
  vip?: boolean;
  /** It's their birthday. Triggers the full two-board takeover on the karting
   *  check-in screens — the biggest thing either wall ever does. */
  birthday?: boolean;
  /** Shared-clock ms when it happened. */
  atMs: number;
}

/* ── the feed ─────────────────────────────────────────────────────────── */

/** One party on the welcome board. First names only — public screen. */
export interface WelcomeEntry {
  id: string;
  /** Display name, already reduced to first names by the server. */
  title: string;
  guestCount: number | null;
  /** "First up: Bowling — HP VIP Lanes" */
  firstStopLabel: string | null;
  /** Building to send them to, e.g. "HeadPinz". */
  building: string | null;
  /** ISO start of the first leg. */
  startsAtIso: string | null;
  /** Wall-clock label, e.g. "6:30 PM". */
  startsAtLabel: string | null;
  isVip: boolean;
}

/** One step of a VIP party's itinerary (mirrors the combo board's shape). */
export interface VipStep {
  label: string;
  iso: string | null;
  lane: string | null;
  location: string | null;
  durationMin: number | null;
}

export interface VipEntry {
  id: string;
  /** First name only. */
  title: string;
  comboName: string | null;
  playerCount: number | null;
  /** Chronological steps; the bowling step drives the takeover countdown. */
  schedule: VipStep[];
}

/**
 * What /api/tv/feed returns.
 *
 * `null` on a data section means "we could not build this right now" and its
 * playlist entries self-skip — distinct from `[]`, which means "nothing today".
 * The screen degrades toward ads and NEVER renders an error state.
 */
export interface TvFeed {
  /** Server clock, for a sanity cross-check against the shared offset. */
  now: number;
  screen: SignageScreen | null;
  events: WelcomeEntry[] | null;
  vip: VipEntry[] | null;
  kioskEvents: SignageEvent[];
  /**
   * Track-screen extra: is a VIP party on the heat checking in right now?
   *
   * Server-computed from the HEAT ROSTER, not from scans — VIPs do not scan in
   * (owner 2026-08-11), they are met and escorted, so the scan rail would never
   * see them. Null for screens that are not scoped to a track.
   */
  raceCheckin: {
    track: string;
    sessionId: number | null;
    vipOnHeat: boolean;
    vipFirstNames: string[];
  } | null;
  /** Product ids currently off-sale — never advertise a paused product. */
  pausedProductIds: string[];
  /** True when an upstream failed and sections were dropped. */
  degraded: boolean;
}
