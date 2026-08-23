/**
 * Race Sims catalog (PLACEHOLDER — staff testing phase, 2026-08).
 *
 * Racing simulators at FastTrax Fort Myers. This file is the SINGLE SEAM
 * between the placeholder flow and real money: every price, track, and
 * product id the kiosk flow shows comes from here, and checkout is
 * fail-closed server-side (unified-reserve guard 2e) until the money ids
 * below are filled in. Dropping real ids into this file is what lights up
 * charging — nothing else needs to change.
 *
 * PREREQUISITE before setting ids: decide the vendor booking rail. Setting
 * `squareCatalogObjectId` alone would let checkout CHARGE with no sim-rig
 * reservation behind it (the racesim service in booking/service/index.ts is
 * a deliberate no-op during the placeholder phase). If sims get a BMI/other
 * vendor rail, wire it first; if they are walk-up-only, record that decision
 * here before arming the ids.
 *
 * Catalog lives HERE in code, never in Square — same rule as race-products.ts
 * and data/packs.ts. Prices are USD pre-tax stickers, PLACEHOLDERS until the
 * owner prices the sims.
 *
 * Tracks: 3 sim rigs run a rotating track lineup (weekly/biweekly — rotation
 * config is future work). Placeholder labels Track A/B/C until real track
 * names exist. Display names for guests come from the kiosk i18n catalog
 * (parts/racesim.ts); the `name` fields here are the EN source of truth.
 */

export type RaceSimTrackKey = "a" | "b" | "c";

export interface RaceSimTrack {
  key: RaceSimTrackKey;
  /** EN display label — PLACEHOLDER until the rotating lineup is named. */
  name: string;
}

export const RACE_SIM_TRACKS: readonly RaceSimTrack[] = [
  { key: "a", name: "Track A" },
  { key: "b", name: "Track B" },
  { key: "c", name: "Track C" },
] as const;

export function getRaceSimTrack(key: string | null): RaceSimTrack | null {
  return RACE_SIM_TRACKS.find((t) => t.key === key) ?? null;
}

export interface RaceSimProduct {
  /** Stable cart/session key, e.g. "sim-single". */
  slug: string;
  /** single = the "1 Race" card; pack = a multi-race bundle. */
  kind: "single" | "pack";
  /** EN display name. */
  name: string;
  /** Sim races granted per racer. */
  raceCount: number;
  /** PLACEHOLDER sticker price per racer, USD pre-tax. NOT owner-approved. */
  price: number;
  /**
   * REAL Square catalog variation id — null until configured. Checkout is
   * fail-closed on null (RaceSimNotConfiguredError from unified-reserve
   * guard 2e); the quote/review screen still prices from `price`.
   */
  squareCatalogObjectId: string | null;
  /**
   * BMI product id if sims get a BMI rail — RAW string, NEVER through
   * Number()/JSON.parse (@ft/db BMI id precision rule). null until decided.
   */
  bmiProductId: string | null;
}

/** PLACEHOLDER SKUs — shape mirrors what the kiosk product step renders:
 *  one "1 Race" card plus the pack cards. Prices are stand-ins for layout
 *  testing only. */
export const RACE_SIM_PRODUCTS: readonly RaceSimProduct[] = [
  {
    slug: "sim-single",
    kind: "single",
    name: "1 Race",
    raceCount: 1,
    price: 14.99,
    squareCatalogObjectId: null,
    bmiProductId: null,
  },
  {
    slug: "sim-3-pack",
    kind: "pack",
    name: "3-Race Pack",
    raceCount: 3,
    price: 39.99,
    squareCatalogObjectId: null,
    bmiProductId: null,
  },
  {
    slug: "sim-5-pack",
    kind: "pack",
    name: "5-Race Pack",
    raceCount: 5,
    price: 59.99,
    squareCatalogObjectId: null,
    bmiProductId: null,
  },
] as const;

export function getRaceSimProduct(slug: string | null): RaceSimProduct | null {
  return RACE_SIM_PRODUCTS.find((p) => p.slug === slug) ?? null;
}

/** The seam the reserve guard reads: a product may charge ONLY when every
 *  money id is set. Placeholder phase = always false. */
export function raceSimProductConfigured(p: RaceSimProduct): boolean {
  return p.squareCatalogObjectId != null;
}

/** Thrown by unified-reserve guard 2e for any racesim item whose product is
 *  not fully configured. Caught by the reserve routes → 409 with `code`, so
 *  the kiosk shows a staff-readable message instead of arming a charge. */
export class RaceSimNotConfiguredError extends Error {
  readonly code = "RACESIM_NOT_CONFIGURED" as const;
  constructor(slug: string | null) {
    super(
      "Race sim checkout isn't live yet — please see the front desk." +
        (slug ? ` (product: ${slug})` : ""),
    );
    this.name = "RaceSimNotConfiguredError";
  }
}
