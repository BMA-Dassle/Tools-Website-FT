/**
 * Attract-screen bank choreography — position map + billboard timeline.
 *
 * PHYSICAL bank order (owner 2026-07-26): cross-kiosk choreography must
 * stagger by where a kiosk STANDS in the row, not by its number. FastTrax's
 * seven kiosks happen to be banked in number order, but HeadPinz Fort Myers
 * runs 3 · 2 · 6 · 1 · 4 — kioskNumber arithmetic scrambles any handoff
 * there (the attract race car included, which this map now also drives).
 *
 * The billboard is the owner-picked HeadPinz attract event: each screen in
 * the bank takes one activity (photo + neon word) lighting up in physical
 * order, then every screen lands the line together — "All right here."
 * All timing derives from the shared kiosk wall clock (useKioskClock), so
 * the bank performs in unison with no cross-kiosk messaging; a kiosk that is
 * mid-booking simply isn't rendering the attract screen, and the sequence
 * visually passes "behind" it.
 */
import { KIOSK_PHOTOS } from "../assets";
import type { MessageKey } from "../i18n";

export type VenueSlug = "FT" | "HPFM" | "HPN";

/** Left-to-right physical kiosk numbers per venue (owner 2026-07-26). */
const BANK_ORDER: Record<VenueSlug, number[]> = {
  FT: [1, 2, 3, 4, 5, 6, 7],
  HPFM: [3, 2, 6, 1, 4],
  HPN: [10, 9, 7, 8],
};

/** How many screens the venue's bank choreography spans. */
export function bankSize(venue: VenueSlug): number {
  return BANK_ORDER[venue].length;
}

/**
 * Physical position (0 = leftmost) of a kiosk in its venue's bank, or null
 * when the kiosk isn't in the map — unmapped kiosks sit OUT of the bank
 * choreography (owner 2026-07-26: "don't include kiosks not in the bank map
 * for now") and just keep running the normal attract loop.
 */
export function bankPosition(venue: VenueSlug, kioskNumber: number): number | null {
  const idx = BANK_ORDER[venue].indexOf(kioskNumber);
  return idx >= 0 ? idx : null;
}

export interface BillboardSlide {
  /** i18n key of the neon word(s) — the catalog value uses \n for line
   *  breaks (rendered whitespace-pre-line, k-display uppercase). */
  word: MessageKey;
  /** Accent color for the word's neon glow. */
  accent: string;
  photo: string;
}

/**
 * One slide per physical screen, leftmost first. Positions beyond the list
 * reuse the last slide ("…and more"), so bank growth never crashes the show.
 * Naples never advertises racing (same rule as the ad rotation).
 */
export const BILLBOARD_SLIDES: Record<VenueSlug, BillboardSlide[]> = {
  // FastTrax's picked events are the drive-by + relay wave (later PR) — no
  // billboard content yet, and the flag is per-brand-guarded anyway.
  FT: [],
  HPFM: [
    { word: "attract.billboard.bowling", accent: "#00e2e5", photo: KIOSK_PHOTOS.bowl },
    { word: "attract.billboard.gel", accent: "#46d68c", photo: KIOSK_PHOTOS.gel },
    { word: "attract.billboard.duckpin", accent: "#4fa9ff", photo: KIOSK_PHOTOS.duck },
    { word: "attract.billboard.gameZone", accent: "#f0b341", photo: KIOSK_PHOTOS.arcade },
    { word: "attract.billboard.andMore", accent: "#e8b14c", photo: KIOSK_PHOTOS.shuf },
  ],
  HPN: [
    { word: "attract.billboard.bowling", accent: "#00e2e5", photo: KIOSK_PHOTOS.bowl },
    { word: "attract.billboard.gel", accent: "#46d68c", photo: KIOSK_PHOTOS.gel },
    { word: "attract.billboard.laser", accent: "#f800c6", photo: KIOSK_PHOTOS.laser },
    { word: "attract.billboard.gameZone", accent: "#f0b341", photo: KIOSK_PHOTOS.arcade },
  ],
};

/* ── clock-locked timeline ─────────────────────────────────────────────
   One event per CYCLE. Screen at position p lights at p·STEP, all hold
   until every screen is lit + HOLD, then the finale line shows on every
   screen for FINALE, then back to the idle attract. Bursts against
   stillness: ~11s of show in a 40s cycle. */
export const BILLBOARD_CYCLE_MS = 40_000;
const STEP_MS = 1_000;
const HOLD_MS = 2_200;
const FINALE_MS = 3_800;

export type BillboardPhase = "idle" | "activity" | "finale";

/** Phase for the screen at `position` (of `count` screens) at shared-clock `nowMs`. */
export function billboardPhase(nowMs: number, position: number, count: number): BillboardPhase {
  const t = ((nowMs % BILLBOARD_CYCLE_MS) + BILLBOARD_CYCLE_MS) % BILLBOARD_CYCLE_MS;
  const activityStart = position * STEP_MS;
  const finaleStart = count * STEP_MS + HOLD_MS;
  const finaleEnd = finaleStart + FINALE_MS;
  if (t >= finaleEnd) return "idle";
  if (t >= finaleStart) return "finale";
  if (t >= activityStart) return "activity";
  return "idle";
}
