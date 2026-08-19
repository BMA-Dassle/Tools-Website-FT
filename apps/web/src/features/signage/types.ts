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
import type { BriefingRoomState } from "./briefing/types";
import type { CheckinProgressSession } from "./checkin-progress";
import type { FastPitRoster, PitBoardInfo, PitLanes } from "./pit/pit-board";
import type { ResultsBoardView } from "./results-board";
import type { TopTimesView } from "./top-times";

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
 *  - `briefing`       a briefing room's TV: the safety video for the session
 *                     that was just sent here, then helmet sizes, then who
 *                     levelled up in the session before it
 *  - `camera`         a live CCTV monitor: one venue camera, full-bleed, refreshed
 *                     a frame a second (e.g. a briefing room's own camera on a
 *                     wall so staff can see it fill). Which camera is per-screen
 *                     config (`cameraMonitor`); nothing else shows on the board
 *  - `pit-board`      a track's pit assignment TV: the staged session's spots,
 *                     names and photos, camera state per racer, and the seating
 *                     rail (seat while the race runs, hold while karts return).
 *                     Always assignment — it replaces the vendor AssignmentTV
 *  - `race-results`   a track's SCORES wall, at the kart return: the race that
 *                     just came back in — final standings, best laps, and who
 *                     levelled up. Carries lap times deliberately; it is the
 *                     surface the briefing room's welcome-back board points to
 *  - `race-guide`     the check-in guide wall, between the desk and the briefing
 *                     rooms: what to know before you race, over track
 *                     photography — then a very large arrow in the track's
 *                     colour the moment that heat is sent to a room
 *
 *  THE FRONT-DESK WALL (HeadPinz Fort Myers, five panels over a second kiosk
 *  bank). All three read `wall.position` through `choreo()` and render THEIR
 *  SLICE of one composition — five panels of the same card would be a hall of
 *  mirrors. All three are also DATA-OPTIONAL: they must never be given
 *  `requiresData`, because a dropped entry changes `totalSlots` on one panel and
 *  tears the wall (see ScreenWall and the plan's tear invariant).
 *
 *  - `vip-showcase`   the VIP Experience across five panels, four sub-slides:
 *                     the statement, the night's three legs, what's included,
 *                     the price. A gold identity rail names the product and its
 *                     price on every panel of every slide, so a guest walking up
 *                     mid-slide always knows what they are looking at
 *  - `open-now`       the venue's menu board: ten attraction tiles dealt across
 *                     the five panels, with live "next available" from the same
 *                     cache the kiosks read. A paused product shows no price and
 *                     no time
 *  - `kiosk-howto`    one verb per panel, each over the machine it names —
 *                     CHECK IN · BUY A LANE · BOOK A RACE · LOAD A CARD · BUY
 *                     THE VIP NIGHT — with the arrow band pointing down at it
 *
 *  - `sleep`          venue closed — panel/power saver
 */
export type SceneType =
  | "ads"
  | "event-welcome"
  | "vip-welcome"
  | "celebration"
  | "billboard-crown"
  | "race-checkin"
  | "briefing"
  | "camera"
  | "pit-board"
  | "race-results"
  | "race-guide"
  | "vip-showcase"
  | "open-now"
  | "kiosk-howto"
  | "bowling-checkin"
  | "sleep";

/** Scenes a screen rotates through on its base loop (interrupts are separate). */
export const ROTATION_SCENE_TYPES = [
  "ads",
  "event-welcome",
  "race-checkin",
  "briefing",
  "camera",
  "pit-board",
  "race-results",
  "race-guide",
  "vip-showcase",
  "open-now",
  "kiosk-howto",
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
/**
 * How much of a WALL one playlist entry occupies.
 *
 *   `wall`    every panel — the default, and what every screen off a wall does.
 *   `middle`  positions 1..count-2, i.e. the middle three of five. The panels either
 *             side fall out of the composition and render their own `outsideScene`.
 *
 * ON THE ENTRY, NOT ON THE SCREEN, and that is what keeps the tear invariant intact
 * for free: the playlist stays byte-identical on all five panels, the span is part of
 * that identical playlist, and each panel works out from its OWN position whether it
 * is inside. Nothing is negotiated between screens.
 *
 * A SPAN NEVER CHANGES AT RUNTIME. It is tempting to widen a 3-wide scene back to 5
 * when the wings have nothing to say — and that tears the wall, for the same reason
 * `requiresData` is banned here: five players poll on independent 15s phases, so for
 * up to fifteen seconds one panel can believe the composition is 3-wide while another
 * believes it is 5-wide, and both then render the leftmost slice. A wing with nothing
 * to show runs the ADS scene instead, which is not a spanning composition at all (each
 * panel picks its own slide off the shared clock), so there is no position to disagree
 * about. See tasks/front-desk-wall-formats.md.
 */
export type SceneSpan = "wall" | "middle";

export interface PlaylistEntry {
  scene: SceneType;
  /** Length in 40s slots. Defaults to 1. */
  slots?: number;
  /** How much of a wall this entry occupies. Defaults to the whole wall, which is
   *  also what every screen that is not on a wall does. */
  span?: SceneSpan;
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

/**
 * A VIDEO WALL — several screens hung close enough to read as one picture.
 *
 * The other half of `ScreenPairing`, and deliberately NOT the same field, because
 * `pairing` is already doing two jobs that collide once a group grows past two:
 *
 *   1. `resolvePair()` returns null unless a group has EXACTLY 2 screens, and
 *      that is what builds the two-monitor launcher (`buildDualStartupScript`).
 *   2. `SceneBirthdayTakeover` and `track.ts megaSplit` read `position`/`count`
 *      as the CHOREOGRAPHY primitive.
 *
 * The HeadPinz Fort Myers front-desk wall is five panels driven by three player
 * PCs (2 + 1 + 2). Folding a 5-wide choreography group into `pairing` would take
 * the dual launchers away from two of those machines. So the machine pairs stay
 * in `pairing` and the wall lives here — `choreo()` in ./wall.ts is the one
 * resolver every scene asks, so no scene has to know which field it got.
 *
 * THE GAP IS THE DESIGN CONSTRAINT. The karting boards sit ~4 feet apart, where
 * nothing readable may cross the gap; these sit ~6 INCHES apart, where the gap
 * reads as word-spacing. So the law for a wall is "a word never crosses a gap, a
 * sentence may" — see tasks/front-desk-wall-plan.md.
 */
export interface ScreenWall {
  /** Which wall. Every panel of one wall carries the same id. */
  wallId: string;
  /** 0 = leftmost as you FACE the wall. */
  position: number;
  /** How many panels the wall has. */
  count: number;
  /**
   * Gap between panels as a percent of ONE panel's picture width. ~6in on a
   * ~48in picture is ~12. Drives the virtual canvas any wall-wide gradient
   * paints into, so a light pass travels at one speed across glass and gap
   * alike. Clamped 0-100 at read time; defaults to 12.
   */
  gapPct?: number;
  /**
   * A brand mark this panel may carry. "two locations" is FastTrax FM + HeadPinz
   * FM (owner 2026-08-17), and the two marks live on the two ENDS of the wall so
   * the statement it makes has a bookend either side. Inner panels carry "none".
   * Absent = derived (first panel fasttrax, last headpinz, inner none).
   */
  brand?: "fasttrax" | "headpinz" | "none";
  /**
   * WHAT THIS PANEL SHOWS WHEN THE RUNNING SCENE DOES NOT REACH IT.
   *
   * A fact about this panel's job, which is why it lives on the screen rather than on
   * the playlist: the wall's left wing is the self-check-in board and its right wing
   * is today's events, and that is true of those two panels whatever is playing in the
   * middle. Absent on the middle panels, which are never outside a span.
   *
   * Falls back to house ads, which is the right answer for a wing whose own board has
   * nothing to say — see the note on SceneSpan for why it must not instead widen the
   * middle scene.
   */
  outsideScene?: SceneType;
}

/** The per-screen config blob (JSONB in Neon). Every field optional. */
export interface ScreenConfig {
  playlist?: PlaylistEntry[];
  interrupts?: ScreenInterrupts;
  scope?: ScreenScope;
  pairing?: ScreenPairing;
  /** This screen is one panel of a video wall — see ScreenWall. Absent on every
   *  screen hung on its own, which is all of them but the front-desk five. */
  wall?: ScreenWall;
  /** Which ad slide set to run. Defaults to the venue's own. */
  adSet?: string;
  /** Put "Next available" times on the ad slides. Off unless asked for — an
   *  advert that quotes a time nobody can honour is worse than one that does
   *  not. */
  showNextAvailable?: boolean;
  /** How many minutes a racer has to check in, counted from the moment the
   *  heat was first called. Drives the countdown on the track boards. */
  checkinWindowMins?: number;
  /** Show that countdown at all. Off = the session shows with no timer. */
  showCheckinCountdown?: boolean;
  /** What this board does on a MEGA day, when both tracks run as one circuit
   *  and the pair would otherwise show the same thing: keep showing the
   *  session, or become a big live check-in feed where names never clear. */
  megaRole?: "session" | "checkin";
  /** The PIT boards' version of the same choice (owner 2026-08-17): on a Mega
   *  day the two pit signs read the one combined lane, so the pair splits the
   *  job — one keeps the seat-assignment board, the other becomes the SESSION
   *  TRACKER: every stage a heat passes through, full screen. */
  pitMegaRole?: "assignment" | "tracker";
  /** Show a labelled "scan for track records" QR on the track boards. */
  showRecordsQr?: boolean;
  /** Minutes before an event's first leg that it appears on the welcome board. */
  welcomeLeadMins?: number;
  /** Minutes after the first leg starts that it drops off the welcome board. */
  welcomeTrailMins?: number;
  /**
   * WHICH BRIEFING ROOM this screen stands in — the one thing a briefing TV
   * cannot work out for itself.
   *
   * Both rooms read the same feed, so the room is what tells a screen which of
   * the two Redis states is addressed to it. Absent on every screen that is not
   * a briefing TV, which is why it is optional rather than defaulted to a side:
   * guessing "red" would put a Red briefing on a lobby wall.
   */
  briefingRoom?: "red" | "blue";
  /**
   * WHICH CAMERA a `camera` monitor board shows — the one thing that board
   * cannot work out for itself.
   *
   * `deviceId` is an Nx Witness device id (a GUID); `label` is the staff-facing
   * caption burned onto the corner of the board ("Blue Briefing Room"). Absent on
   * every screen that is not a camera monitor. This is also the ALLOWLIST: the
   * frame proxy will only ever serve the camera named here for this screen, so a
   * board can never be repointed at an arbitrary camera from the client side.
   *
   * `track` ties the board to a race track so it can carry that track's live
   * clocks (session remaining + running-behind), big, along the bottom — a
   * briefing-room camera is a briefing-room camera FOR a track. Absent on a
   * camera with no track (a lobby cam), which then just shows picture.
   */
  cameraMonitor?: { deviceId: string; label?: string; track?: "blue" | "red" | "mega" };
  /**
   * WHICH TRACK a `race-results` board reports on — the one thing that board
   * cannot work out for itself.
   *
   * Deliberately its own field rather than reusing `scope.resourceIds` (which
   * is how the check-in and pit boards find their track): scope also decides
   * which scan events reach a screen, and a scores wall at the kart return
   * should not light up because somebody checked in for the next heat. One
   * knob, one meaning.
   *
   * Absent on every screen that is not a results board, which then shows the
   * setup notice rather than adopting a track at random.
   *
   * `role` is WHAT this wall reports, and it is the same idea as `megaRole` and
   * `pitMegaRole` next door: two scores walls on one track — which is what a
   * Mega day makes of the Blue and Red pair, since both then follow the one
   * combined circuit — would otherwise show byte-identical content and waste a
   * screen. `last-race` is the race that just came back in (the default, and
   * today's behaviour to the pixel); `top-times` is the hall-of-fame board,
   * fastest laps over a window.
   *
   * `ranges` belongs to `top-times` only: which windows it cycles through, in
   * order, one per playlist slot. Empty or absent means `["month"]`, which is
   * the window /leaderboards itself opens on — a hall of fame is about the
   * standing record, whereas a "today" wall is a list of the session that just
   * finished. Ignored by `last-race`.
   */
  resultsBoard?: {
    track: "blue" | "red" | "mega";
    role?: "last-race" | "top-times";
    ranges?: Array<"today" | "week" | "month" | "year" | "alltime">;
  };
  /**
   * The check-in guide wall: which track it speaks for, WHICH WAY THE BRIEFING
   * ROOMS ARE, and how long the wayfinding takeover holds.
   *
   * `arrow` is a fact about the building, not about the software — this screen
   * hangs somewhere specific and the rooms are physically left or right of it,
   * so it can only ever be per screen. Defaults to `left` (owner 2026-08-15).
   *
   * `holdMs` is clamped at read time (20s–10min): this field decides how long
   * an instruction stays on a wall, and a fat-fingered value either pins the
   * screen on one heat all night or blinks it out before anybody turns around.
   *
   * NOTE this screen also needs `scope.resourceIds`, unlike the results board —
   * it follows one track's check-in desk, which is the entire point.
   */
  raceGuide?: {
    /**
     * WHICH TRACKS this one wall covers. Plural, because it is ONE screen for
     * the whole check-in area rather than one per track (owner 2026-08-15) —
     * it carries a qualifying card per track and takes a send from either.
     * Defaults to both when absent.
     */
    tracks?: Array<"blue" | "red" | "mega">;
    /** Superseded by `tracks`; still read so a row written before the
     *  one-screen change keeps working until it is next saved. */
    track?: "blue" | "red" | "mega";
    arrow?: "left" | "right";
    holdMs?: number;
  };
  /**
   * HOW MUCH OF THIS PANEL'S EDGE IS CROPPED — the one thing about a TV that the
   * TV cannot work out for itself.
   *
   * Overscan: a panel that throws away ~2–5% around the edge of the incoming
   * 1080p signal and zooms the rest, so the bottom of a canvas authored to the
   * pixel is simply not on the glass. It is a property of THAT PHYSICAL PANEL
   * (and of whatever HDMI extender is in the run), not of the venue or the role,
   * which is why it belongs here per screen rather than in a constant.
   *
   * FIX THE TV FIRST. Nearly every panel can be told to stop — "Just Scan" on
   * LG, "Fit to Screen" on Samsung, "Dot by Dot"/"Normal" elsewhere, or naming
   * the HDMI input "PC" — and that is strictly better than this field, because
   * overscan is upscaling a crop: turning it off makes the board sharper as well
   * as complete. This knob exists for the panels whose firmware will not
   * cooperate (commercial/hotel modes, some HDMI-over-CAT extenders).
   *
   * Percent inset per EDGE. 3 scales the canvas to 94% and centres it, so a
   * 3%-per-edge crop eats letterbox black instead of content. Absent or 0 is
   * today's behaviour to the pixel — which is why every screen already hanging
   * is unaffected by this field existing. Clamped to 0–10 at read time
   * (`tvFitScale`): this number scales the whole wall, and a fat-fingered 100
   * would otherwise leave a panel unlit.
   */
  overscanPct?: number;
}

/**
 * One bowling offer as a wall reads it.
 *
 * `unit` matters as much as the price: an hourly lane is priced PER LANE (up to 6
 * bowlers) and an open-play package PER PERSON, so a bare "$35" on a wall is two
 * very different offers depending on which it is. Derived from the experience's
 * own kind (`isPerLaneExperience`), never guessed.
 */
export interface BowlingWallOffer {
  /** Guest-facing name, day range stripped — the wall only shows today's. */
  label: string;
  /** e.g. "$35". Absent when the catalog row carries no priced primary item. */
  priceLabel: string | null;
  /** "per lane" | "per person" */
  unit: string;
  /** e.g. "1.5 hours", when the offer has a fixed length. */
  durationLabel: string | null;
  /**
   * Are shoes in the price?
   *
   * NOT a constant, and not something to assume of a "special": Fun 4 All and Pizza
   * Bowl include them, MIDNIGHT MADNESS DOES NOT, and neither does an hourly lane.
   * Blanket-printing "shoes included" would be a $5-per-person surprise at the desk
   * on a Friday night. Derived from the catalog's own description so the wall follows
   * whatever the offer actually says.
   */
  shoesIncluded: boolean;
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

export type SignageEventKind =
  | "booking-completed"
  | "checkin-completed"
  | "racer-scanned"
  /** Scanned, but not for the heat that is checking in. */
  | "racer-wrong-race";

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
  /** This racer has a headsock waiting at the desk — the check-in feed's
   *  action strip says so, so staff and racer both see it. */
  headsockDue?: boolean;
  /** For a wrong-race scan: when their heat actually is, already formatted.
   *  Pre-formatted rather than an ISO string because the board must not do
   *  timezone maths to tell somebody where to be. */
  theirRaceLabel?: string;
  /**
   * WHO this scan was, for de-duplication — `{personId}:{sessionId}`.
   *
   * Not displayed, and not a name: it exists because a racer who scans four times
   * appeared on the check-in board four times (owner 2026-08-11). The board is a
   * list of who is here, so the same person twice is simply wrong.
   *
   * Keyed by person AND session so a racer legitimately checking in for a later
   * heat is a different entry, not a suppressed duplicate.
   */
  racerKey?: string;
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
 * THE CAMERA RETURN STRIP as it travels on the wire — carried on BOTH the 15s
 * feed and the 2s pulse, so it is named once here rather than written twice.
 *
 * No PII, same posture as briefingRooms: camera numbers, a heat number and a
 * track, never the racer the camera was scanned to.
 */
/** One camera on the strip. No PII, same posture as briefingRooms: a number, a
 *  heat and a track, never the racer it was scanned to. */
export interface CameraReturnFeedBox {
  camera: string;
  state: "still-out" | "waiting" | "back";
  heatNumber: number | null;
  /** Circuit it went out on — the colour the box wears in every state, so staff
   *  know which track to walk to. Null when the finish record named none. */
  track: "blue" | "red" | "mega" | null;
  sinceFlagMs: number;
  assignedAtMs: number;
}

export interface CameraReturnFeedStrip {
  /** SOLID TRACK COLOUR, left section: race over, next race called, never came
   *  back. Red only when `track` is null — see CameraReturnBar note 2. */
  stillOut: CameraReturnFeedBox[];
  /** GREY then GREEN, right section: the group just off track. Settles when the
   *  next race is called — green ones leave, grey ones move to stillOut. */
  incoming: CameraReturnFeedBox[];
  /** What the strip prints. `stillOut.length`, named so no caller has to know
   *  that, and so it can never accidentally count the incoming ones. */
  outCount: number;
  /** The facts could not be read this poll. Holds the strip's space and says so,
   *  rather than claiming an all-clear it cannot stand behind. */
  stale?: boolean;
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
    /** How the heat is NAMED on a wall — "Session 59", "Pro" — read from the same
     *  record as `sessionId`, so the send announcement below can identify the heat
     *  it is talking to even after the client's own session poll has moved on. */
    heatNumber: number | null;
    raceType: string | null;
    vipOnHeat: boolean;
    vipFirstNames: string[];
    /** How many of the heat's racers are checked in, and how many there are.
     *  Null when the roster could not be read — the board then shows no count
     *  rather than a wrong one. */
    checkedIn: number | null;
    total: number | null;
    /**
     * When this heat was sent to a briefing room, or null.
     *
     * The track board hands over on this rather than on elapsed time: a group that
     * has been sent to a briefing room has finished checking in (owner
     * 2026-08-11). It first announces where to go for a moment, then goes idle.
     */
    briefedAtMs: number | null;
    /**
     * WHICH room to send them to, for that announcement.
     *
     * On a Mega day both track boards read the same session, so both name the same
     * room — the one it actually went to. On an ordinary day each board only ever
     * sees its own track's session, so only the relevant board reacts at all.
     */
    briefedRoom: "red" | "blue" | null;
  } | null;
  /**
   * Briefing-room extra: the films and poster this screen plays, plus the
   * qualification board for its room. Null for every screen that is not a
   * briefing TV.
   *
   * SLOW HALF. Assets change when somebody uploads — a handful of times a year —
   * and quals change once a heat, so both ride the 15s feed. The room's live
   * state is `briefingRooms` below and rides the 2-second pulse instead, so a
   * send reaches the wall in about two seconds without the player re-reading a
   * manifest it already has.
   *
   */
  briefing: {
    videos: {
      starter: { url: string; durationMs: number | null } | null;
      intermediate: { url: string; durationMs: number | null } | null;
      /** Optional — Pro sessions fall back to the Intermediate film without it. */
      pro: { url: string; durationMs: number | null } | null;
    };
    helmetPosterUrl: string | null;
    /**
     * The room's group has FINISHED racing — the timing system stamped their
     * session's actualEnd — and is walking back in to return kit. Shown only
     * while the room is otherwise idle; any live timeline outranks it.
     * `results` carries the end-of-race capture (names verbatim from the
     * timing system, best laps in ms) split against the qualifying time; null
     * when the capture never landed, and the board renders name-less.
     */
    welcomeBack: {
      heatNumber: number | null;
      raceType: string | null;
      track: "blue" | "red" | "mega";
      /** The timing system's end stamp that opened this window — the anchor
       *  for the greeting audio's 2-minute cap, server-stamped so both room
       *  TVs and a mid-window reboot all stop at the same moment. */
      endedAtMs: number;
      /** When this race's post-race cue played, null until it has — the
       *  greeting audio waits for it (the post is what calls them back in). */
      postPlayedAtMs: number | null;
      /** The welcome-back jingle (signage asset `welcome-back-audio`) — null
       *  until one is uploaded, and the board simply greets silently. */
      audioUrl: string | null;
      results: {
        levelledUp: Array<{ name: string; bestMs: number }>;
        keepPushing: Array<{ name: string; bestMs: number | null }>;
      } | null;
      /**
       * Who in this group races again within the next two heats, one row per
       * heat they are JOINING. Names come from the BMI roster, not the timing
       * socket — `results` above carries transponder names, and the two must
       * never be matched to each other.
       *
       * Empty is the normal case and the degraded case alike.
       */
      racingAgain: Array<{ session: number | null; track: string; names: string[] }>;
    } | null;
    /**
     * WHICH POV CAMERAS ARE STILL OUT — the strip along the bottom of both
     * briefing TVs. See briefing/camera-return.ts for what the states mean.
     *
     * VENUE-WIDE, not room-scoped, unlike `welcomeBack` above: a camera lost on
     * a Blue heat is just as much a problem for whoever is handing out kit in
     * Red (owner 2026-08-12), so both rooms carry the identical strip.
     *
     * NULL MEANS THE KILL SWITCH IS OFF, and nothing else — the scene then
     * renders no strip and the boards get their full 1080 px back. A failed read
     * is reported as `stale` instead, keeping the strip's reserved height so the
     * wall never springs taller and shrinks again mid-briefing. `boxes: []` with
     * no `stale` is the third, meaningful state: everything is accounted for,
     * which paints the all-clear line.
     *
     * NO PII on this rail, same as briefingRooms: camera numbers and a heat
     * number, never the racer the camera was scanned to.
     */
    cameraReturn: CameraReturnFeedStrip | null;
  } | null;
  /**
   * FAST HALF — what each briefing room is showing right now. Also present on
   * the pulse (see TvPulse), which is what actually keeps it current; carried on
   * the full feed too so a cold boot paints the right board on its first frame
   * instead of idling for two seconds.
   */
  briefingRooms: Record<"red" | "blue", BriefingRoomState | null> | null;
  /**
   * PULSE-ONLY — which room, if either, is holding up a race that is already
   * back in the pit. Always null on the full feed; useTvFeed merges the pulse's
   * copy over it. See TvPulse.roomBlocked.
   */
  roomBlocked: Record<"red" | "blue", { heatNumber: number | null } | null> | null;
  /**
   * Pit-board extra: the staged session, its roster with spots, and the
   * per-racer joins (camera, birthday, VIP). Null for every screen that is
   * not a pit board.
   *
   * PII NOTE — this section deliberately carries FULL NAMES and personIds,
   * unlike everything above it (owner 2026-08-13: the vendor AssignmentTV it
   * replaces has always shown full names and photos). The ids exist so the
   * board can fetch photos; they only ever reach screens somebody registered.
   */
  pitBoard: PitBoardInfo | null;
  /**
   * Every track's pit-lane state (holding / racing / pitted). Carried on the
   * pulse too — that is what makes a staff press land on the wall in about
   * two seconds — and here so a cold boot paints the right rail immediately.
   */
  pitLanes: PitLanes | null;
  /**
   * The FAST roster slice, per track — PULSE-ONLY. The server feed always
   * writes null here; useTvFeed merges the pulse's copy in, and the scene
   * overlays it on `pitBoard.roster` (mergePitRoster). Participants are
   * "basically real time" (owner 2026-08-13): who is on the session, checked
   * in, and BMI's grid position all land within a pulse or two.
   */
  pitRosters: Record<"blue" | "red" | "mega", FastPitRoster | null> | null;
  /**
   * Camera-monitor extra: how far the check-in station has got through EVERY
   * heat it currently has open — "6 of 14 checked in", per track.
   *
   * Distinct from `raceCheckin` above, which is one track's heat and only exists
   * for screens scoped to a track by resource id. A camera monitor is scoped by
   * camera, not by resource, so it never had that section; and a marshal in a
   * briefing room wants the whole desk's picture, not only their own track's.
   * Null for every screen that is not a track-tied camera monitor.
   */
  checkinProgress: CheckinProgressSession[] | null;
  /**
   * Camera-monitor extra: THE GROUP WALKING BACK INTO THIS CAMERA'S ROOM, and
   * which heats they are due out on next.
   *
   * The same fact the room's own welcome-back wall is showing at that moment,
   * from the same resolver — deliberately, so the guest screen inside the room
   * and the staff screen at the pit door can never describe one return
   * differently (owner 2026-08-14: "similar to what you have on welcome screen
   * but for staff").
   *
   * Null when nobody is returning, when the room has no camera, or when the
   * briefing kill switch is off. `groups` is never empty when this is non-null —
   * a returning group nobody is racing again with is not news to staff.
   */
  checkinReturning: {
    /** The heat that just finished — the one group walking back in. */
    fromSession: number | null;
    groups: Array<{ session: number | null; track: string; names: string[] }>;
  } | null;
  /**
   * Results-board extra: the last race on this board's track that we can name,
   * with the qualification already decided server-side.
   *
   * A SECTION OF ITS OWN, not a widening of `briefing.welcomeBack`. That one is
   * room-scoped and narrows its drivers to `{name, bestMs}` on the wire — a
   * scores wall needs position, kart and laps as well, and needs them for races
   * that were never briefed in any room at all.
   *
   * Rides the 15s feed, never the pulse: a result changes once every ~10
   * minutes, and the group it is about takes minutes to walk back from the
   * track.
   *
   * PII NOTE — full names, verbatim from the timing system, same posture as the
   * briefing wall and the pit board it hangs near. No ids of any kind.
   *
   * Null means "no race we can stand behind has finished on this track today",
   * which is the scene's designed idle card, not an error.
   */
  raceResults: ResultsBoardView | null;
  /**
   * The OTHER face of the scores wall: fastest laps over a window, by tier and
   * class, for a `race-results` screen whose `resultsBoard.role` is
   * `top-times`. Null on every other screen, including a results wall in its
   * default `last-race` role — the two roles are mutually exclusive and the
   * feed only ever builds the one this screen asked for.
   *
   * PII NOTE — participant names as the timing system holds them, same posture
   * as `raceResults` above and as the public /leaderboards page, which shows
   * these exact rows.
   */
  topTimes: TopTimesView | null;
  /**
   * Guide-wall extra: the live send state of EVERY track this one screen
   * covers, so a single wall can point either group at their room.
   *
   * `raceCheckin` above cannot serve this. It is built from
   * `scope.resourceIds` and describes exactly ONE track — fine for a board
   * that belongs to a track, wrong for a wall that belongs to the check-in
   * AREA and has to react to Blue and Red alike.
   *
   * No PII: a heat number, a race type and two timestamps.
   * Null for every screen that is not a guide wall.
   */
  raceGuide: {
    tracks: Array<{
      track: "blue" | "red" | "mega";
      heatNumber: number | null;
      raceType: string | null;
      /** When this heat was sent to a briefing room, or null. The trigger. */
      briefedAtMs: number | null;
      /** WHICH room to point at — never assumed from the track, because on a
       *  Mega day both rooms serve the one circuit. */
      briefedRoom: "red" | "blue" | null;
    }>;
  } | null;
  /**
   * TONIGHT'S BOWLING, from the experience catalog — the regular offer and the VIP
   * one, with the prices the kiosk will charge.
   *
   * Its own feed section rather than a price in the scene, because bowling is the
   * one attraction with NO static price: lanes are dynamic through QAMF and
   * `ATTRACTIONS.bowling` carries `price: 0` on purpose. The real numbers live in
   * Neon (`bowling_experiences` + `bowling_experience_offers`), which is a server
   * read, so the only honest way to get them onto a wall is through the feed.
   *
   * Null for every screen that does not run the menu board, and null when the
   * catalog read fails — the panel then sells availability instead of inventing a
   * lane price, which is the failure mode the house pricing rule exists to stop.
   */
  bowlingTonight: {
    /**
     * TONIGHT'S SPECIAL — the package, in its regular and VIP forms. Fun 4 All
     * Mon–Thu, Midnight Madness Fri/Sat, Pizza Bowl Sunday. This is what the wall
     * leads with: the hourly lane rate is the everyday baseline, not the offer
     * (owner 2026-08-18, "Bowling is missing the special. Fun 4 All tonight").
     */
    special: { regular: BowlingWallOffer | null; vip: BowlingWallOffer | null } | null;
    /** The plain hourly lane rate, so a guest who just wants a lane still has a
     *  price. Null on a night with no hourly offer. */
    hourly: { regular: BowlingWallOffer | null; vip: BowlingWallOffer | null } | null;
  } | null;
  /** Product ids currently off-sale — never advertise a paused product. */
  pausedProductIds: string[];
  /** "Next available" per product key, e.g. { bowling: "3 lanes · 9:30 PM" }.
   *  Only populated for screens that asked for it. */
  nextAvailable: Record<string, string> | null;
  /** Set when staff asked the screens to reload. A screen reloads if this is
   *  newer than its own boot. Null when nobody has asked. */
  reloadAt: number | null;
  /** A preview pushed to THIS screen from the admin page. Expires on its own,
   *  so a wall cannot be left showing fabricated guests. */
  demoMode: string | null;
  /** True when an upstream failed and sections were dropped. */
  degraded: boolean;
}

/**
 * The FAST half of the feed — Redis reads only, polled every couple of seconds.
 *
 * Declared here, beside TvFeed, rather than inline in the builder and again in
 * the hook. The two used to be separate literal types and a field added to one
 * and not the other is invisible until a wall does not react: exactly the class
 * of bug that made pushed previews silently decorate nothing (2026-08-11). One
 * declaration, two importers, no way to drift.
 */
export interface TvPulse {
  now: number;
  kioskEvents: SignageEvent[];
  reloadAt: number | null;
  demoMode: string | null;
  /**
   * Both briefing rooms' live state. Null for venues with no briefing rooms —
   * the key is per-venue rather than per-screen because the pulse deliberately
   * never loads a screen row (it is three Redis reads and nothing else), so each
   * TV picks its own room out of this by its `briefingRoom` config.
   */
  briefingRooms: Record<"red" | "blue", BriefingRoomState | null> | null;
  /**
   * The camera return strip, on the FAST lane (owner 2026-08-12: "when we see a
   * register can we clear it pretty fast on the screen?").
   *
   * Affordable here despite being derived from three Redis reads, because the
   * build is cached per venue — a pulse is one GET of that cache, and the rebuild
   * happens at most once every CACHE_TTL_SECONDS however many screens are asking.
   * Per-venue for the same reason briefingRooms is: the pulse never loads a
   * screen row.
   */
  cameraReturn: CameraReturnFeedStrip | null;
  /**
   * The pit lanes, on the FAST lane too: "send to holding" and "race returned"
   * are staff presses with a group standing at the seats, and the rail they
   * flip must move in seconds, not on the 15s feed. Per-venue (FT only) for
   * the same reason briefingRooms is — the pulse never loads a screen row.
   */
  pitLanes: PitLanes | null;
  /**
   * The fast roster slice per track — the one measured exception to the
   * pulse's Redis-only rule. A short per-session cache + NX rebuild claim
   * bound Pandora to at most one roster read per session per ~4s venue-wide,
   * whatever the screen count (see pit/fast-roster.server.ts).
   */
  pitRosters: Record<"blue" | "red" | "mega", FastPitRoster | null> | null;
  /**
   * IS EITHER BRIEFING ROOM HOLDING UP A RACE THAT IS ALREADY BACK IN THE PIT,
   * and which race (owner 2026-08-16)?
   *
   * The post-race announcement calls a finished group back in to hand kit over,
   * so it cannot play into an occupied room — the rule `postRaceGate` has
   * enforced since 2026-08-14. This is that same refusal, addressed to the room
   * causing it, so the wall can raise it (briefing/room-blocked.ts).
   *
   * NOT DERIVED ON THE WALL from `pitLanes.pitIn.room`, deliberately: the gate
   * decides the room from the briefed marker, which knows it in cases the lane
   * slot does not. Resolving it here is what keeps the alert and the pit
   * station's Play Post button describing one fact.
   *
   * FT only, and null whenever the gate could not be read — a wall that cannot
   * answer stays quiet rather than raising a full-screen alarm on a clear room.
   */
  roomBlocked: Record<"red" | "blue", { heatNumber: number | null } | null> | null;
}
