/**
 * Arena e-ticket centers — every HeadPinz location the arena crons serve.
 *
 * The feature launched FM-only (2026-06-11) with FM literals baked into
 * constants.ts; this file is the multi-center seam added for HeadPinz
 * Naples (2026-08-16). Each center carries everything location-specific:
 * the Pandora location id, dayplanner resource names, sender DID, and the
 * address/phone rendered on tickets and emails.
 *
 * Naples runs its OWN BMI server (unlike HP FM, which shares FastTrax's),
 * so every Redis key built from its BMI ids is location-scoped via
 * bmiKeyScope (lib/bmi-key-scope.ts) — the documented prerequisite for
 * onboarding Naples. FM keys keep their legacy shape.
 *
 * Naples resource name verified by live Pandora probe 2026-08-16: the
 * dayplanner resource is ALSO named "HP Arena" (200 with live sessions;
 * "NEXUS"/"Arena"/"Gel Blaster" variants all 404), and session names use
 * the same "NN - Nexus Gel Blaster" / "NN - Nexus Laser Tag" convention
 * classifyArenaSession already matches.
 */

import {
  ARENA_RESOURCES,
  HEADPINZ_BASE_URL,
  HP_FM_LOCATION_ID,
  HP_NAPLES_LOCATION_ID,
  ARENA_LOCATION_META,
  VOX_FROM_HEADPINZ_FM,
  VOX_FROM_HEADPINZ_NAPLES,
} from "./constants";

export interface ArenaCenter {
  /** Stable short key — used in cron summaries and log prefixes. */
  key: "hp-fm" | "hp-naples";
  label: string;
  /** Square/Pandora location id — routes to the right BMI server upstream. */
  locationId: string;
  /** Dayplanner resource names (CF_RSC_NAME) hosting arena sessions. */
  resources: readonly string[];
  /** Sender DID for this center's SMS (A2P-registered, already in
   *  production use for this center's bowling/booking confirmations). */
  smsFrom: string;
  address: string;
  phoneDisplay: string;
  phoneTel: string;
}

const HP_FM_CENTER: ArenaCenter = {
  key: "hp-fm",
  label: "HeadPinz Fort Myers",
  locationId: HP_FM_LOCATION_ID,
  resources: ARENA_RESOURCES,
  smsFrom: VOX_FROM_HEADPINZ_FM,
  address: ARENA_LOCATION_META[HP_FM_LOCATION_ID].address,
  phoneDisplay: ARENA_LOCATION_META[HP_FM_LOCATION_ID].phoneDisplay,
  phoneTel: ARENA_LOCATION_META[HP_FM_LOCATION_ID].phoneTel,
};

const HP_NAPLES_CENTER: ArenaCenter = {
  key: "hp-naples",
  label: "HeadPinz Naples",
  locationId: HP_NAPLES_LOCATION_ID,
  resources: ARENA_RESOURCES, // same "HP Arena" resource name — probed 2026-08-16
  smsFrom: VOX_FROM_HEADPINZ_NAPLES,
  address: ARENA_LOCATION_META[HP_NAPLES_LOCATION_ID].address,
  phoneDisplay: ARENA_LOCATION_META[HP_NAPLES_LOCATION_ID].phoneDisplay,
  phoneTel: ARENA_LOCATION_META[HP_NAPLES_LOCATION_ID].phoneTel,
};

export const ARENA_CENTERS: readonly ArenaCenter[] = [HP_FM_CENTER, HP_NAPLES_CENTER];

/** Kill switch ONLY (owner rule 2026-07-31: flags default ON, exist to
 *  turn features OFF in an emergency — never opt-in gates). */
function naplesEnabled(): boolean {
  return process.env.ARENA_NAPLES !== "false";
}

/** Centers the arena crons should serve this run. */
export function activeArenaCenters(): ArenaCenter[] {
  return ARENA_CENTERS.filter((c) => c.key !== "hp-naples" || naplesEnabled());
}

/** Center for a ticket/QR locationId — null for non-arena locations. */
export function arenaCenterForLocation(locationId: string | null | undefined): ArenaCenter | null {
  const loc = String(locationId ?? "").trim();
  return ARENA_CENTERS.find((c) => c.locationId === loc) ?? null;
}

export { HEADPINZ_BASE_URL };
