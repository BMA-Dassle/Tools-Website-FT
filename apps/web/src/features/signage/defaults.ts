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
import { VENUE_INFO, type SignageVenue } from "./constants";
import type { PlaylistEntry, ScreenConfig, SceneType } from "./types";

export type ScreenRole = "kiosk-bank" | "race-checkin" | "ads-only";

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
    role: "ads-only",
    label: "Advertising only",
    description: "House advertising on a loop. No guest data on screen.",
    venues: ["FT", "HPFM", "HPN"],
    config: ADS_ONLY_CONFIG,
  },
];

export function rolePreset(role: ScreenRole): RolePreset {
  return ROLE_PRESETS.find((p) => p.role === role) ?? ROLE_PRESETS[2];
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
  showRecordsQr: boolean;
  welcomeLeadMins: number;
  welcomeTrailMins: number;
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
    showRecordsQr: c.showRecordsQr === true,
    welcomeLeadMins: numOr(c.welcomeLeadMins, 75),
    welcomeTrailMins: numOr(c.welcomeTrailMins, 30),
  };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}
