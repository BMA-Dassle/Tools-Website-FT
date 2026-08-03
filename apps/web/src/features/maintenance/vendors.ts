/**
 * Which UPSTREAM VENDORS each guest-facing product depends on.
 *
 * This is the axis outages actually travel along (owner 2026-08-03: "bowling,
 * duck and game zone is only ones working so maybe it's by vendor in future").
 * When a vendor goes down it does not take "laser tag" down — it takes down
 * *everything that vendor serves*, and what we can still sell is exactly what
 * runs on a different one. Modeling per-attraction means editing a list every
 * incident and forgetting the derived product (a combo leg, a package, a credit
 * pack); modeling per-vendor means one switch.
 *
 * A product can depend on MORE THAN ONE vendor and is off sale when ANY of them
 * is down (owner: "vip depends on both"). The Ultimate VIP combo chains BMI race
 * legs into a QAMF bowling lane: either vendor dark breaks the itinerary, and
 * half a combo is not a product we sell.
 *
 * ── The four upstreams, kept SEPARATE on purpose ────────────────────────────
 * "BMI" is two different services on two different hosts, and the 2026-08-03
 * incident took both while a third BMI-adjacent service stayed healthy. Lumping
 * them together would have taken down surfaces that were working:
 *
 *   bmi         api.bmileisure.com/public-booking — availability, booking/book,
 *               booking/sell, payment/confirm. The SELLING rail.
 *   bmi-office  office-api22.sms-timing.com — person search, project lookup and
 *               project state. The LOOKUP rail: "find my reservation", "find my
 *               account", license scan, check-in.
 *   pandora     bma-pandora-api.azurewebsites.net — person records, deposits,
 *               memberships, waiver signing. Declared here even though it was
 *               HEALTHY through the 2026-08-03 outage, so the products that lean
 *               on it are explicitly attributed rather than assumed — and so a
 *               future Pandora outage is a one-line registry entry, not a hunt.
 *   qamf        Conqueror — HeadPinz lanes + FastTrax duckpin (center 11542).
 *   intercard   TPI game-card bridge — Game Zone.
 *
 * Ids are the SAME vocabulary the kiosk availability payload and the activities
 * catalog already speak (shuffly split per building, plus the Experiences-shelf
 * products), so no surface needs a translation table.
 */
import { fasttraxQamfDuckpinEnabled } from "~/features/booking/flags";

export type VendorKey = "bmi" | "bmi-office" | "pandora" | "qamf" | "intercard";

/** Human label for guest-facing copy — deliberately vague. A guest does not need
 *  our vendors' names, only that the problem is not their card. */
export const VENDOR_LABEL: Record<VendorKey, string> = {
  bmi: "one of our booking vendors",
  "bmi-office": "one of our reservation systems",
  pandora: "one of our guest-account systems",
  qamf: "one of our lane systems",
  intercard: "our game-card system",
};

/**
 * Product id → the vendors it needs. ALL of them must be up to offer it.
 *
 * SELLING rail (bmi):
 *   race, ultimate-qualifier  racing heats; the Qualifier is a racing package
 *   race-pack                 prepaid race credits (booking/sell)
 *   gel-blaster, laser-tag    Nexus attractions (HeadPinz FM + Naples)
 *   shuffly-*                 separate BMI products per building (FT / HP side)
 *
 * LOOKUP rail (bmi-office):
 *   waiver    the unified + kiosk waiver flows. The SIGNATURE goes to Pandora
 *             (healthy), but both flows first have to FIND you — the reservation
 *             picker and the returning-guest / licence-scan account lookup are
 *             Office. A guest who cannot be identified cannot be signed, so this
 *             is Office-gated even though Pandora would accept the signature.
 *
 * DELIBERATELY ABSENT — check-in and e-tickets. Both ride Office too, both were
 * verified working through this outage, and the owner ruled them out of scope
 * explicitly (2026-08-03: "dont do anything with eticket or check in. its
 * working"). They are NOT classified here, so nothing in this feature can reach
 * them: an unclassified id fails open by design (see vendorsForProduct). Do not
 * "complete" the map by adding them.
 *
 * BOTH selling + lanes:
 *   race-bowl  Ultimate VIP: race → VIP lane → race.
 *
 * pandora:
 *   contract   group-event contracts. Attributed, NOT blocked during the
 *              2026-08-03 BMI outage: viewing, signing and paying a balance are
 *              Neon + Square + Vercel Blob, the only BMI touch is the planner-
 *              notes panel which already falls back to the DB, and the
 *              phone/waiver pushes go to Pandora. Blocking these would have
 *              stopped us collecting group balances we could still collect.
 *
 * qamf: bowling, kbf, and duck-pin (resolved below).
 * intercard: game-zone — independent of every booking vendor, which is why Game
 * Zone stayed open through the whole outage.
 */
const STATIC_VENDORS_BY_PRODUCT: Record<string, VendorKey[]> = {
  race: ["bmi"],
  "ultimate-qualifier": ["bmi"],
  "race-pack": ["bmi"],
  "gel-blaster": ["bmi"],
  "laser-tag": ["bmi"],
  shuffly: ["bmi"],
  "shuffly-fasttrax": ["bmi"],
  "shuffly-headpinz": ["bmi"],
  "race-bowl": ["bmi", "qamf"],
  waiver: ["bmi-office"],
  contract: ["pandora"],
  bowling: ["qamf"],
  kbf: ["qamf"],
  "game-zone": ["intercard"],
};

/**
 * The vendors a product depends on — empty when we don't classify it (fail-open:
 * never take a product off sale because we forgot to list it).
 *
 * duck-pin runs on QAMF (FastTrax center 11542) since the 2026-07-22 migration,
 * resolved through the SAME kill switch the booking flow reads. Flipping duckpin
 * back to its legacy BMI page therefore also moves it back under a BMI outage,
 * instead of silently staying open while its vendor is dark.
 */
export function vendorsForProduct(id: string): VendorKey[] {
  if (id === "duck-pin") return [fasttraxQamfDuckpinEnabled() ? "qamf" : "bmi"];
  return STATIC_VENDORS_BY_PRODUCT[id] ?? [];
}

/** Every product id this module knows about — used by tests and by the paused
 *  overlay, which has to enumerate keys rather than be asked about one. */
export function allProductIds(): string[] {
  return [...Object.keys(STATIC_VENDORS_BY_PRODUCT), "duck-pin"];
}
