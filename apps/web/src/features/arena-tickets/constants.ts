/**
 * HP Arena e-tickets — feature constants.
 *
 * Single place for every arena-specific literal so the future @ft/env
 * migration (restructure PR4+) is a one-file change. Mirrors the racing
 * e-ticket system's constants. Per-center wiring (FM + Naples) lives in
 * ./centers.ts; this file keeps the client-safe literals (the ticket
 * views import ARENA_LOCATION_META, and centers.ts is server-only
 * because it reads env kill switches).
 *
 * Naples (PPTR5G2N0QXF7) onboarded 2026-08-16: it runs a separate BMI
 * server, so every Redis key built from its BMI ids carries a location
 * segment via bmiKeyScope (lib/bmi-key-scope.ts). FM keys keep their
 * legacy shape — FT + HP FM share one BMI server / id namespace.
 */

/** Square location id for HeadPinz Fort Myers — shares a BMI server
 *  (and therefore a sessionId namespace) with FastTrax FM. */
export const HP_FM_LOCATION_ID = "TXBSQN0FEKQ11";

/** Square location id for HeadPinz Naples — its OWN BMI server (numeric
 *  BMI location 332145, client key "headpinznaples"). */
export const HP_NAPLES_LOCATION_ID = "PPTR5G2N0QXF7";

/** BMI dayplanner resource (CF_RSC_NAME) covering BOTH Nexus Laser Tag
 *  and Nexus Gel Blaster sessions. Verified by live probe 2026-06-11 at
 *  FM and 2026-08-16 at Naples: "HP Arena" is the only matching name at
 *  BOTH centers — "Nexus Laser Tag", "Laser Tag", "Arena", "NEXUS" etc.
 *  all 404 from /bmi/sessions. */
export const ARENA_RESOURCES = ["HP Arena"] as const;

/** HeadPinz FM SMS sender (Voxtelesys DID). Already A2P-registered and
 *  in production use by bowling lane-ready / guest-survey / booking
 *  confirmations. Env override supports a future dedicated arena DID
 *  without a code change. */
export const VOX_FROM_HEADPINZ_FM = process.env.VOX_FROM_HEADPINZ_FM || "+12393022155";

/** HeadPinz Naples SMS sender — the DID already texting Naples guests
 *  for bowling/booking confirmations and lane-ready. Same env-override
 *  pattern as FM. */
export const VOX_FROM_HEADPINZ_NAPLES = process.env.VOX_FROM_HEADPINZ_NAPLES || "+12394553755";

/** Base URL for arena ticket links (SMS short-link targets). The /t,
 *  /g, /s routes serve on headpinz.com via the shared-route middleware
 *  entries added in PR-1. */
export const HEADPINZ_BASE_URL = (process.env.HEADPINZ_SITE_URL || "https://headpinz.com").replace(
  /\/+$/,
  "",
);

/** Check-in QR rendering on arena tickets. Enabled together with the
 *  location-aware staff scanner (PR-5) — the /api/admin/checkin route
 *  understands the HP QR form and gates arena scans on the session's
 *  scheduled-time window. Flip OFF to hide the QR block from arena
 *  tickets without touching the views. */
export const ARENA_QR_ENABLED = true;

export const HP_FM_ADDRESS = "14513 Global Parkway, Fort Myers, FL 33913";
export const HP_FM_PHONE_DISPLAY = "(239) 302-2155";
export const HP_FM_PHONE_TEL = "+12393022155";

export const HP_NAPLES_ADDRESS = "8525 Radio Ln, Naples, FL 34104";
export const HP_NAPLES_PHONE_DISPLAY = "(239) 455-3755";
export const HP_NAPLES_PHONE_TEL = "+12394553755";

/** Client-safe per-location display meta, keyed by ticket.locationId —
 *  the ticket views and email builders pick address/phone from the
 *  ticket record instead of hardcoding FM. Unknown location ids fall
 *  back to FM (matches every ticket minted before Naples existed). */
export const ARENA_LOCATION_META: Record<
  string,
  { address: string; phoneDisplay: string; phoneTel: string }
> = {
  [HP_FM_LOCATION_ID]: {
    address: HP_FM_ADDRESS,
    phoneDisplay: HP_FM_PHONE_DISPLAY,
    phoneTel: HP_FM_PHONE_TEL,
  },
  [HP_NAPLES_LOCATION_ID]: {
    address: HP_NAPLES_ADDRESS,
    phoneDisplay: HP_NAPLES_PHONE_DISPLAY,
    phoneTel: HP_NAPLES_PHONE_TEL,
  },
};

/** Address/phone for a ticket's locationId, FM fallback for legacy/unknown. */
export function arenaLocationMeta(locationId: string | null | undefined): {
  address: string;
  phoneDisplay: string;
  phoneTel: string;
} {
  return (
    ARENA_LOCATION_META[String(locationId ?? "").trim()] ?? ARENA_LOCATION_META[HP_FM_LOCATION_ID]
  );
}
