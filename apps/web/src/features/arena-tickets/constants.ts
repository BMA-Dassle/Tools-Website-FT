/**
 * HP Arena e-tickets — feature constants.
 *
 * Single place for every arena-specific literal so the future @ft/env
 * migration (restructure PR4+) is a one-file change. Mirrors the racing
 * e-ticket system's constants, parameterized for HeadPinz Fort Myers.
 *
 * Naples (PPTR5G2N0QXF7) is deliberately NOT here yet — it runs a
 * separate BMI server, and the shared ticket dedup keys
 * (ticket:bySession:{sid}:{pid}, alert:arena-pre:{sid}:{pid}) are not
 * location-scoped. Add a location segment to those keys before
 * onboarding Naples. See tasks/todo.md § HP Arena E-Tickets.
 */

/** Square location id for HeadPinz Fort Myers — shares a BMI server
 *  (and therefore a sessionId namespace) with FastTrax FM. */
export const HP_FM_LOCATION_ID = "TXBSQN0FEKQ11";

/** BMI dayplanner resource (CF_RSC_NAME) covering BOTH Nexus Laser Tag
 *  and Nexus Gel Blaster sessions. Verified by live probe 2026-06-11:
 *  "HP Arena" is the only matching name — "Nexus Laser Tag",
 *  "Laser Tag", "Arena" etc. all 404 from /bmi/sessions. */
export const ARENA_RESOURCES = ["HP Arena"] as const;

/** HeadPinz FM SMS sender (Voxtelesys DID). Already A2P-registered and
 *  in production use by bowling lane-ready / guest-survey / booking
 *  confirmations. Env override supports a future dedicated arena DID
 *  without a code change. */
export const VOX_FROM_HEADPINZ_FM = process.env.VOX_FROM_HEADPINZ_FM || "+12393022155";

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
