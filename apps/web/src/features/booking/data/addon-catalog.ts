/**
 * Booking ADD-ON catalog (owner 2026-08-10) — small retail extras sold inside
 * the booking flows ("Race Video & Extras" step). v1 ships ONE entry, the $3
 * replacement headsock; future merch = one row here + its i18n key pairs in
 * `kiosk/i18n/messages/parts/addons.ts` (EN + ES in the same commit).
 *
 * Design rules (mirror race packs / POV — the two prior extras):
 *   - The session stores selection POINTERS only (`RaceItem.addonSelections`);
 *     every price re-derives from THIS registry, client and server, so a stale
 *     client can never set its own price.
 *   - Money maps to Square through `chargeLineKey` → SQUARE_CATALOG_MAP (the
 *     synthetic-key pattern packages use), NOT through the display name.
 *   - NOT `RaceItem.addons` — that rail is legacy BMI-priced activities; any
 *     qty there drops the item off the $0-BMI model (race.ts
 *     raceUsesZeroBmiModel). Add-ons are Square-only merch.
 *   - Future package-included add-ons (none exist today) suppress here in
 *     `offerableAddons` AND in `addonChargeLines` — the same shared-seam idea
 *     as POV's raceItemFullyPackaged.
 */
import type { RaceItem } from "../state/types";
import { SQUARE_CATALOG_IDS as SQ } from "./square-catalog-map";

export type AddonAttribution =
  /** Guest picks WHICH party members get one (chip picker); one unit per
   *  member; fulfillment (grant) is per-person. The headsock model. */
  | "per-racer"
  /** Plain quantity stepper capped at maxQty (defaults to party size). */
  | "qty";

export interface BookingAddon {
  /** Stable slug — ledger + session pointer key. Never rename a shipped slug. */
  slug: string;
  /** English display + Square wire-line base name ("Replacement Headsock ·
   *  {racer}" on per-racer lines). Kiosk display uses the i18n keys instead. */
  name: string;
  /** Unit price in cents. The ONLY price source (import, never re-declare). */
  priceCents: number;
  /** Synthetic BillLine.bmiProductId + SQUARE_CATALOG_MAP key — resolves the
   *  Square catalog variation in the reserve route via lookupCatalogId. */
  chargeLineKey: string;
  /** The Square variation this maps to (informational — resolution goes
   *  through SQUARE_CATALOG_MAP[chargeLineKey]; keep the two in sync). */
  squareCatalogObjectId: string;
  attribution: AddonAttribution;
  /** $0 BMI product to record this add-on on the reservation bill (rides the
   *  same booking/sell call as the $0 POV line, money stays on Square). Omit
   *  for add-ons ops shouldn't see on the BMI bill. */
  bmiZeroProductId?: string;
  /** qty attribution only: hard cap; undefined = party size. */
  maxQty?: number;
  /** i18n key prefix in parts/addons.ts — `${i18nPrefix}.name`, `.blurb`,
   *  `.pickerLabel`, `.cart.rowLabel` … EN + ES both required. */
  i18nPrefix: string;
  /** Post-charge Pandora fulfillment: +amountPerUnit on this deposit kind per
   *  unit, on the racer's account (per-racer) — check-in detects + deducts it.
   *  Omit for pure line-item merch with no credit fulfillment. */
  grant?: { depositKindId: string; amountPerUnit: number };
  /** Which booking flows offer it. Only "race" exists in v1 — combos stay
   *  excluded (the extras step is hiddenInCombo). */
  surfaces: Array<"race">;
}

/** Pandora "Credit - Headsock" — same id as lib/pandora-deposits.ts
 *  DEPOSIT_KIND.HEADSOCK (literal duplicated here like packs.ts does, so this
 *  client-bundled registry never imports the server deposit lib). Check-in
 *  already detects + deducts this kind ("Headsock Due" banner). */
const HEADSOCK_DEPOSIT_KIND_ID = "48069703";

export const BOOKING_ADDONS: BookingAddon[] = [
  {
    slug: "headsock",
    name: "Replacement Headsock",
    priceCents: 300, // $3 — matches the e-ticket HeadsockNotice copy
    chargeLineKey: "addon-headsock",
    squareCatalogObjectId: SQ.HEADSOCK,
    // "Headsock Pre-Purchase" — owner-created 2026-08-10 on the same BMI page
    // as the $0 POV product, so the reservation bill shows the sock was
    // pre-bought (the Pandora credit remains the check-in fulfillment signal).
    bmiZeroProductId: "48952128",
    attribution: "per-racer",
    i18nPrefix: "addon.headsock",
    grant: { depositKindId: HEADSOCK_DEPOSIT_KIND_ID, amountPerUnit: 1 },
    surfaces: ["race"],
  },
];

export function getBookingAddon(slug: string): BookingAddon | undefined {
  return BOOKING_ADDONS.find((a) => a.slug === slug);
}

/** KILL SWITCH — default ON (flags are kill switches only, never opt-in
 *  gates). `NEXT_PUBLIC_BOOKING_ADDONS_ENABLED=false` darkens the sell UI,
 *  the charge lines, the cart estimate, AND the reserve intent/grant rail. */
export function bookingAddonsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BOOKING_ADDONS_ENABLED !== "false";
}

/**
 * The add-ons a given surface may OFFER right now. Item passed so legacy
 * BMI-priced race items (old `addons` rail, qty>0) offer nothing — those items
 * never run buildRaceChargeLines, so a selection there could never charge.
 */
export function offerableAddons(surface: "race", item?: RaceItem): BookingAddon[] {
  if (!bookingAddonsEnabled()) return [];
  if (item?.addons?.some((a) => a.qty > 0)) return [];
  return BOOKING_ADDONS.filter((a) => a.surfaces.includes(surface));
}
