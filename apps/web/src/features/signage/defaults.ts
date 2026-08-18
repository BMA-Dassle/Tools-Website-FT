/**
 * Screen ROLES and config resolution.
 *
 * A "role" is just a starting playlist — the admin page offers them as presets
 * so staff hang a TV by saying what it is FOR ("the one above the kiosks", "the
 * Blue Track check-in screen") instead of hand-authoring JSON. Once created, a
 * screen's config is free-form and the role is not stored: it is a template, not
 * a type. That keeps "add a screen" in config-space while leaving every knob
 * editable afterwards.
 *
 * RESOLUTION CONTRACT (the CONFIG_VERSION lesson, restated in code): a stored
 * config is always PARTIAL and always trusted. `resolveScreenConfig` fills every
 * missing field with a default and never rejects, so a config written by an
 * older or newer deploy still boots a screen. There is deliberately no version
 * field to mismatch on.
 */
import { clampOverscanPct, VENUE_INFO, type SignageVenue } from "./constants";
import { clampHoldMs } from "./race-guide";
import type { TopTimesRange } from "./top-times";
import type { PlaylistEntry, ScreenConfig, SceneType } from "./types";

export type ScreenRole =
  | "kiosk-bank"
  | "race-checkin"
  | "briefing-room"
  | "camera-monitor"
  | "pit-board"
  | "results-board"
  | "check-in-guide"
  | "ads-only";

export interface RolePreset {
  role: ScreenRole;
  label: string;
  description: string;
  /** Venues this role makes sense at (admin picker filters by it). */
  venues: SignageVenue[];
  config: ScreenConfig;
}

/**
 * The TV above the bank of 6 kiosks at HeadPinz Fort Myers — the first screen.
 * Welcomes today's parties, greets VIPs before their bowling leg, sells what the
 * kiosks below can take money for, reacts when someone books down there, and
 * crowns the bank's own billboard every cycle.
 */
const KIOSK_BANK_CONFIG: ScreenConfig = {
  playlist: [
    { scene: "event-welcome", slots: 2, requiresData: true },
    { scene: "ads", slots: 1 },
    { scene: "event-welcome", slots: 1, requiresData: true },
    { scene: "ads", slots: 1 },
  ],
  interrupts: {
    "vip-welcome": { enabled: true, leadMins: 10, floorMins: 3, minShowMs: 45_000 },
    celebration: { enabled: true, maxAgeSecs: 90, showMs: 8_000 },
    "billboard-crown": { enabled: true, joinEvery: 1 },
  },
  welcomeLeadMins: 75,
  welcomeTrailMins: 30,
};

/**
 * A FastTrax track check-in TV (Blue or Red). Scoped to ONE track via
 * `scope.resourceIds` so a racer scanning in for Blue lights the Blue screen
 * only — and so the VIP greeting on it belongs to that track's heat.
 * `pairing` is filled in per screen (Blue = position 0, Red = position 1) so the
 * two can perform as one display on Mega races.
 */
const RACE_CHECKIN_CONFIG: ScreenConfig = {
  // NO ADS. A track board has one job, and a racer walking up needs to see
  // their session — not an advert for bowling, and not a screen they have to
  // wait out. It has its own designed standby state for between heats, so
  // there is never dead air to fill (owner 2026-08-11: "karting check in tvs
  // are showing kiosk ads").
  playlist: [{ scene: "race-checkin", slots: 3 }],
  interrupts: {
    celebration: { enabled: true, maxAgeSecs: 90, showMs: 8_000 },
    "vip-welcome": { enabled: true, leadMins: 10, floorMins: 0, minShowMs: 30_000 },
    "billboard-crown": { enabled: false },
  },
  // The audience for lap records is already standing here waiting to check in.
  showRecordsQr: true,
};

/**
 * A briefing room TV (Red or Blue). One job, one scene, no interrupts.
 *
 * NOTHING MAY PREEMPT THIS BOARD. A safety briefing is the one thing on the
 * estate that a guest is required to watch, and a kiosk celebration cutting into
 * minute three of it — confetti over a safety film — would be both absurd and a
 * genuine liability. So every interrupt is explicitly off rather than left to
 * default, and the playlist is a single scene that owns the wall.
 *
 * `briefingRoom` is filled in per screen (there is no sensible default side).
 */
const BRIEFING_ROOM_CONFIG: ScreenConfig = {
  playlist: [{ scene: "briefing", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

/**
 * A live camera monitor. One job, one scene, no interrupts — like the briefing
 * board, it OWNS its wall: a kiosk celebration cutting across a security monitor
 * would be noise on a screen whose whole point is an uninterrupted picture.
 *
 * `cameraMonitor.deviceId` is filled in per screen (there is no default camera),
 * which is why the picker on the admin page is required before the board shows
 * anything but a setup notice.
 */
const CAMERA_MONITOR_CONFIG: ScreenConfig = {
  playlist: [{ scene: "camera", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

/**
 * A track's pit assignment TV (Blue or Red). One job, one scene, no
 * interrupts — like the briefing board it OWNS its wall: this screen is
 * ALWAYS assignment (owner 2026-08-13), and a celebration cutting across the
 * seating rail mid-"hold — karts coming in" would put confetti over a safety
 * instruction. Scoped to one track via `scope.resourceIds`, exactly like the
 * check-in boards.
 */
const PIT_BOARD_CONFIG: ScreenConfig = {
  playlist: [{ scene: "pit-board", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

/**
 * A track's SCORES wall, at the kart return. One job, one scene, no interrupts
 * — it owns its wall like the briefing, camera and pit boards do: a kiosk
 * celebration cutting across the standings would put confetti over the line
 * somebody is reading their own lap time off.
 *
 * `resultsBoard.track` is filled in per screen (there is no default track),
 * which is why the board shows a setup notice until it is picked.
 *
 * NO `scope.resourceIds`, deliberately. Scope decides which scan events reach a
 * screen as well as which track it follows, and a scores wall has no business
 * reacting to a check-in for the next heat.
 */
const RESULTS_BOARD_CONFIG: ScreenConfig = {
  playlist: [{ scene: "race-results", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

/**
 * The check-in guide wall, between the desk and the briefing rooms. One job,
 * one scene, no interrupts — it owns its wall like the boards above, and for a
 * sharper reason than any of them: a celebration cutting across the arrow that
 * is telling a group which room to walk into would not just be noise, it would
 * send them the wrong way.
 *
 * SCOPE IS SET here, unlike the results board. This screen follows one track's
 * check-in desk; that is what the takeover is built on.
 */
const RACE_GUIDE_CONFIG: ScreenConfig = {
  playlist: [{ scene: "race-guide", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

/** The safe fallback: house ads and nothing else. Needs no data at all, which
 *  is exactly why it is what an unprovisioned or degraded screen falls back to. */
const ADS_ONLY_CONFIG: ScreenConfig = {
  playlist: [{ scene: "ads", slots: 1 }],
  interrupts: {
    "vip-welcome": { enabled: false },
    celebration: { enabled: false },
    "billboard-crown": { enabled: false },
  },
};

export const ROLE_PRESETS: RolePreset[] = [
  {
    role: "kiosk-bank",
    label: "Kiosk bank welcome screen",
    description:
      "Above a bank of kiosks. Welcomes today's parties, greets VIPs before bowling, advertises what the kiosks below sell, and reacts when someone books.",
    venues: ["FT", "HPFM", "HPN"],
    config: KIOSK_BANK_CONFIG,
  },
  {
    role: "race-checkin",
    label: "Race check-in screen (one track)",
    description:
      "Above a track's check-in point. Welcomes racers as they scan, shows the session checking in now, and sends VIP parties to the in-field.",
    venues: ["FT"],
    config: RACE_CHECKIN_CONFIG,
  },
  {
    role: "briefing-room",
    label: "Briefing room screen (Red or Blue)",
    description:
      "In a briefing room. Plays the safety video for the session staff send here, then helmet sizes, then who levelled up in the session before. Nothing interrupts it.",
    venues: ["FT"],
    config: BRIEFING_ROOM_CONFIG,
  },
  {
    role: "pit-board",
    label: "Pit assignment screen (one track)",
    description:
      "At a track's pit. Shows the staged session's spots — names, photos, camera state — with the seating rail: seat while the race runs, hold while karts return. Always assignment; nothing interrupts it.",
    venues: ["FT"],
    config: PIT_BOARD_CONFIG,
  },
  {
    role: "results-board",
    label: "Race results screen (one track)",
    description:
      "At a track's kart return. Shows the race that just came back in — final standings, best laps, and who levelled up a class. Pick the track after choosing this. Nothing interrupts it.",
    venues: ["FT"],
    config: RESULTS_BOARD_CONFIG,
  },
  {
    role: "check-in-guide",
    label: "Check-in screen (one track)",
    description:
      "Between check-in and the briefing rooms. Explains what to know before you race — shoes, lockers, how you move up a class — over track photos, then turns that track's colour with a big arrow to the briefing room the moment the session is sent. Pick the track and which way the rooms are.",
    venues: ["FT"],
    config: RACE_GUIDE_CONFIG,
  },
  {
    role: "camera-monitor",
    label: "Camera monitor (live CCTV)",
    description:
      "A single venue camera, full-bleed and refreshed about once a second — e.g. a briefing room's own camera on a wall so staff can watch it fill. Pick the camera after choosing this. Nothing else shows and nothing interrupts it.",
    venues: ["FT", "HPFM", "HPN"],
    config: CAMERA_MONITOR_CONFIG,
  },
  {
    role: "ads-only",
    label: "Advertising only",
    description: "House advertising on a loop. No guest data on screen.",
    venues: ["FT", "HPFM", "HPN"],
    config: ADS_ONLY_CONFIG,
  },
];

/** Look up a preset. Falls back to ads-only — the role that needs no data — for
 *  a name this deploy does not have. Found BY ROLE rather than by index so
 *  inserting a preset above it can never silently change the fallback. */
export function rolePreset(role: ScreenRole): RolePreset {
  return (
    ROLE_PRESETS.find((p) => p.role === role) ??
    ROLE_PRESETS.find((p) => p.role === "ads-only") ??
    ROLE_PRESETS[ROLE_PRESETS.length - 1]
  );
}

/* ── resolution ───────────────────────────────────────────────────────── */

/** Every default in one place, so a partial config can always be completed. */
export interface ResolvedScreenConfig {
  playlist: Required<PlaylistEntry>[];
  vip: { enabled: boolean; leadMins: number; floorMins: number; minShowMs: number };
  celebration: { enabled: boolean; maxAgeSecs: number; showMs: number };
  billboardCrown: { enabled: boolean; joinEvery: number };
  scope: { resourceIds: string[]; gfCenterCodes: string[] };
  pairing: { groupId: string; position: number; count: number } | null;
  adSet: string | null;
  showNextAvailable: boolean;
  checkinWindowMins: number;
  showCheckinCountdown: boolean;
  megaRole: "session" | "checkin";
  pitMegaRole: "assignment" | "tracker";
  showRecordsQr: boolean;
  welcomeLeadMins: number;
  welcomeTrailMins: number;
  /** Null for anything that is not a briefing TV — there is no default side. */
  briefingRoom: "red" | "blue" | null;
  /** Null for anything that is not a camera monitor, or a monitor whose camera
   *  has not been picked yet — the board then shows a setup notice. `track` is
   *  null for a camera with no track (a lobby cam), which shows no clocks. */
  cameraMonitor: {
    deviceId: string;
    label: string | null;
    track: "blue" | "red" | "mega" | null;
  } | null;
  /** Null for anything that is not a results board, or one whose track has not
   *  been picked yet — the board then shows a setup notice rather than
   *  reporting on a track at random. `ranges` is never empty when this is
   *  non-null: a top-times wall with no window to report on has nothing to
   *  show, so it resolves to `["month"]` rather than to nothing. */
  resultsBoard: {
    track: "blue" | "red" | "mega";
    role: "last-race" | "top-times";
    ranges: TopTimesRange[];
  } | null;
  /** Null for anything that is not a guide wall. `tracks` is never empty when
   *  this is non-null — a wall covering no track has nothing to point at. */
  raceGuide: {
    tracks: Array<"blue" | "red" | "mega">;
    arrow: "left" | "right";
    holdMs: number;
  } | null;
  /** Percent inset per edge for a panel that crops its own input. 0 on every
   *  screen that has not been told otherwise, so the default path is the
   *  unchanged full-bleed fit. */
  overscanPct: number;
}

function sanitizePlaylist(entries: PlaylistEntry[] | undefined): Required<PlaylistEntry>[] {
  const list = Array.isArray(entries) ? entries : [];
  const cleaned = list
    // An unknown scene name (config written by a NEWER deploy) is dropped rather
    // than crashing the screen — the rest of the playlist still runs.
    .filter((e): e is PlaylistEntry => !!e && typeof e.scene === "string")
    .map((e) => ({
      scene: e.scene as SceneType,
      slots: Number.isInteger(e.slots) && (e.slots as number) > 0 ? (e.slots as number) : 1,
      requiresData: e.requiresData === true,
    }));
  // A screen with an empty playlist still has to show SOMETHING.
  return cleaned.length > 0 ? cleaned : [{ scene: "ads", slots: 1, requiresData: false }];
}

/**
 * Complete a stored (partial, possibly foreign-versioned) config.
 * Never throws, never discards — see the contract note at the top of this file.
 */
export function resolveScreenConfig(
  config: ScreenConfig | null | undefined,
  venue: SignageVenue,
): ResolvedScreenConfig {
  const c = config ?? {};
  const vip = c.interrupts?.["vip-welcome"] ?? {};
  const cel = c.interrupts?.celebration ?? {};
  const crown = c.interrupts?.["billboard-crown"] ?? {};
  const pairing = c.pairing;

  return {
    playlist: sanitizePlaylist(c.playlist),
    vip: {
      enabled: vip.enabled !== false,
      leadMins: numOr(vip.leadMins, 10),
      floorMins: numOr(vip.floorMins, 3),
      minShowMs: numOr(vip.minShowMs, 45_000),
    },
    celebration: {
      // Defaults ON for a config that omits the block. Briefing-room, pit,
      // camera and results screens should carry an explicit `enabled: false`
      // (the role presets write one at creation) — a celebration interrupt
      // remounts the scene it cuts across, which on a briefing room means
      // re-adopting the film set from disk for no guest-visible reason.
      enabled: cel.enabled !== false,
      maxAgeSecs: numOr(cel.maxAgeSecs, 90),
      showMs: numOr(cel.showMs, 8_000),
    },
    billboardCrown: {
      // Off unless asked for: only a screen physically standing over a kiosk
      // bank should join the bank's choreography.
      enabled: crown.enabled === true,
      joinEvery: Math.max(1, numOr(crown.joinEvery, 1)),
    },
    scope: {
      resourceIds: strArray(c.scope?.resourceIds),
      gfCenterCodes:
        strArray(c.scope?.gfCenterCodes).length > 0
          ? strArray(c.scope?.gfCenterCodes)
          : [VENUE_INFO[venue].center],
    },
    pairing:
      pairing && typeof pairing.groupId === "string" && Number.isInteger(pairing.position)
        ? {
            groupId: pairing.groupId,
            position: Math.max(0, pairing.position),
            count: Math.max(1, numOr(pairing.count, 1)),
          }
        : null,
    adSet: typeof c.adSet === "string" && c.adSet ? c.adSet : null,
    showNextAvailable: c.showNextAvailable === true,
    // 8 minutes from the call (owner 2026-08-11).
    checkinWindowMins: Math.max(1, numOr(c.checkinWindowMins, 8)),
    showCheckinCountdown: c.showCheckinCountdown !== false,
    megaRole: c.megaRole === "checkin" ? "checkin" : "session",
    // Same posture as megaRole: only the non-default literal switches, so an
    // untouched pit sign keeps today's behavior (both show the assignment).
    pitMegaRole: c.pitMegaRole === "tracker" ? "tracker" : "assignment",
    showRecordsQr: c.showRecordsQr === true,
    welcomeLeadMins: numOr(c.welcomeLeadMins, 75),
    welcomeTrailMins: numOr(c.welcomeTrailMins, 30),
    // Only the two literals. Anything else — including a typo'd config or a
    // value from a newer deploy — resolves to "not a briefing screen", which
    // shows the designed idle board rather than adopting a room at random.
    briefingRoom: c.briefingRoom === "red" || c.briefingRoom === "blue" ? c.briefingRoom : null,
    // A camera monitor needs a non-empty device id to mean anything; a blank or
    // malformed one resolves to "not configured yet" so the board shows its
    // setup notice instead of asking the proxy for a camera that isn't named.
    cameraMonitor:
      c.cameraMonitor && typeof c.cameraMonitor.deviceId === "string" && c.cameraMonitor.deviceId
        ? {
            deviceId: c.cameraMonitor.deviceId,
            label:
              typeof c.cameraMonitor.label === "string" && c.cameraMonitor.label
                ? c.cameraMonitor.label
                : null,
            // Only the three real tracks; anything else means "no track clocks".
            track:
              c.cameraMonitor.track === "blue" ||
              c.cameraMonitor.track === "red" ||
              c.cameraMonitor.track === "mega"
                ? c.cameraMonitor.track
                : null,
          }
        : null,
    // Only the three real tracks. A typo'd or newer-deploy value resolves to
    // "not a results board", which shows the setup notice — the same posture
    // briefingRoom and cameraMonitor take, and for the same reason: guessing a
    // track would put Red's standings on the Blue wall.
    //
    // `role` takes the same posture as megaRole and pitMegaRole: only the
    // non-default literal switches, so a results wall written before this field
    // existed — and one whose role is a typo, or a value from a newer deploy —
    // keeps showing the last race rather than silently becoming a leaderboard.
    //
    // `ranges` is filtered to the literals we know and de-duplicated (a list
    // saved as ["month","month"] would otherwise buy itself two slots of the
    // rotation), and an empty result resolves to ["month"]: a top-times wall
    // with nothing to cycle through would render no panel at all, and the month
    // is the window /leaderboards itself opens on.
    resultsBoard:
      c.resultsBoard?.track === "blue" ||
      c.resultsBoard?.track === "red" ||
      c.resultsBoard?.track === "mega"
        ? {
            track: c.resultsBoard.track,
            role: c.resultsBoard.role === "top-times" ? "top-times" : "last-race",
            ranges: resultRanges(c.resultsBoard.ranges),
          }
        : null,
    // ONE WALL, BOTH TRACKS (owner 2026-08-15). `tracks` is the field; the old
    // singular `track` is still honoured so a row written before that change
    // keeps working until it is next saved. An empty or unrecognisable list
    // falls back to both rather than to nothing — a guide wall covering no
    // track has nothing to point at, and an empty rotation is worse than a
    // wrong one.
    //
    // The arrow defaults LEFT and belongs to the SCREEN, not the room: both
    // rooms are the same way from this wall (owner: "both arrows go the same
    // direction. Left"). The hold goes through the scene's own clamp so the
    // legal range has one definition rather than one per reader.
    raceGuide: c.raceGuide
      ? {
          tracks: guideTracks(c.raceGuide.tracks ?? (c.raceGuide.track ? [c.raceGuide.track] : [])),
          arrow: c.raceGuide.arrow === "right" ? "right" : "left",
          holdMs: clampHoldMs(c.raceGuide.holdMs),
        }
      : null,
    // Clamped through the same helper the stage uses, so "what inset is legal"
    // has exactly one definition. 0 for an absent, negative, non-numeric or
    // absurd value — every one of which means "this panel is fine", which is the
    // safe reading: an unnecessary inset only wastes glass, whereas an unclamped
    // one can leave a wall dark.
    overscanPct: clampOverscanPct(c.overscanPct),
  };
}

/** The tracks a guide wall covers, made safe. Unknown values are dropped and
 *  an empty result becomes BOTH — the default posture for a wall that serves
 *  the whole check-in area. */
function guideTracks(v: unknown): Array<"blue" | "red" | "mega"> {
  const list = Array.isArray(v) ? v : [];
  const seen = new Set<string>();
  const out: Array<"blue" | "red" | "mega"> = [];
  for (const t of list) {
    if (t !== "blue" && t !== "red" && t !== "mega") continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length > 0 ? out : ["blue", "red"];
}

/** Which windows a top-times wall cycles through, in the order given.
 *
 *  Order is the SAVED order, not a canonical one — a wall that should open on
 *  the month and settle on the all-time board is a legitimate thing to want,
 *  and sorting here would quietly take it away. Unknown values and repeats are
 *  dropped; see the note at the `resultsBoard` branch for why empty becomes the
 *  month. The accepted values are exactly RecordTimeRange, so every window
 *  /leaderboards offers can be put on a wall. */
function resultRanges(v: unknown): TopTimesRange[] {
  const list = Array.isArray(v) ? v : [];
  const seen = new Set<string>();
  const out: TopTimesRange[] = [];
  for (const r of list) {
    if (r !== "today" && r !== "week" && r !== "month" && r !== "year" && r !== "alltime") continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out.length > 0 ? out : ["month"];
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}
