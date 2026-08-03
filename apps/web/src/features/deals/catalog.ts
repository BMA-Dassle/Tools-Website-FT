/**
 * Prepaid deal packs — the product registry.
 *
 * A deal pack is a PREPAID BUNDLE SOLD AS A VOUCHER. The guest pays once and
 * receives one `HPW-…` code per pack carrying a list of independently redeemable
 * items: attraction admissions that get covered in a booking cart, and Game Zone
 * value that gets dispensed or loaded onto a card. Nothing is scheduled at
 * purchase time — scheduling is an optional hop afterwards, so an abandoned
 * booking never costs the guest anything (owner 2026-08-02: "could it just be
 * vouchers always? That way if they don't end up booking it's still available to
 * them").
 *
 * WHY NOT THE PROMO-CODE SYSTEM (the first instinct, and worth recording):
 * `discount_codes` is a discount applied to a booking at checkout — percent or
 * fixed off, scoped by domain. It has no stored value, cannot carry game-card
 * tokens, cannot be sold, and cannot be redeemed in halves on different visits.
 * The voucher rail is already this product; the only thing it lacked was a way
 * to buy one.
 *
 * COMPOSITION LIVES HERE, NEVER IN SQUARE. Square carries one catalog item id
 * per deal (for revenue categorisation) and the price is overridden from
 * `priceCents` — the same doctrine as race packs and token packages. The server
 * always re-derives price and items from the slug; a client-sent amount is
 * ignored.
 *
 * TWO qty:1 ITEMS, NOT ONE qty:2. Claims are unique per `(code, itemIndex)`, so
 * a pack minted as two separate laser-tag items can be redeemed on two separate
 * visits. It also matches how coverage is allocated: `planVoucherCoverage`
 * awards ONE attraction unit per APPLIED SESSION ENTRY, so two items → two
 * covered units. One `qty:2` item would only ever cover a single unit and
 * silently charge for the second.
 */

import { ATTRACTIONS, type AttractionSlug, type LocationKey } from "@/lib/attractions-data";
import { ACTIVATION_FEE_CENTS } from "~/features/game-cards/constants";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";

/** Deals are HeadPinz-only — FastTrax sells neither laser tag nor gel blasters. */
export type DealLocationKey = Extract<LocationKey, "headpinz" | "naples">;

/** Every location a deal can be bought for, in picker order. */
export const DEAL_LOCATIONS: readonly DealLocationKey[] = ["headpinz", "naples"] as const;

export function isDealLocation(v: string): v is DealLocationKey {
  return (DEAL_LOCATIONS as readonly string[]).includes(v);
}

/** Guest-facing venue names + the Intercard center code value loads against. */
export const DEAL_LOCATION_INFO: Record<
  DealLocationKey,
  { label: string; shortLabel: string; address: string; centerCode: number; center: "fort-myers" | "naples" }
> = {
  headpinz: {
    label: "HeadPinz Fort Myers",
    shortLabel: "Fort Myers",
    address: "14513 Global Pkwy, Fort Myers, FL 33913",
    centerCode: 12,
    center: "fort-myers",
  },
  naples: {
    label: "HeadPinz Naples",
    shortLabel: "Naples",
    address: "8525 Radio Ln, Naples, FL 34104",
    centerCode: 6,
    center: "naples",
  },
};

export interface DealFaq {
  q: string;
  a: string;
}

export interface DealCatalogEntry {
  /** URL slug — `headpinz.com/deals/<slug>`. Also the Square line name key. */
  slug: string;
  /** Marketing name, used as the H1 and the Square line item name. */
  name: string;
  /** One-line hook under the H1. */
  tagline: string;
  /** PRE-TAX price for ONE pack, in cents. The charge authority. */
  priceCents: number;
  /**
   * The voucher a single pack mints, verbatim. Order is identity — never
   * reorder or splice this array for a deal that has already sold, or an
   * existing claim would point at different value than it authorised.
   */
  items: VoucherItem[];
  /**
   * The attraction the "pick your time" hand-off books. Drives the
   * `/book/<slug>/v2` link on the confirmation screen.
   */
  scheduleSlug: AttractionSlug;
  /** Locations this deal is sold for. */
  locations: readonly DealLocationKey[];
  /** All-time cap per buyer (matched on email OR phone), per deal. */
  maxPerBuyer: number;
  /** Voucher lifetime, months from purchase. */
  expiresMonths: number;
  /**
   * Square catalog variation id for the sale line. One line per deal so the
   * revenue is countable and separable in QBO. Owner-supplied — see
   * `dealSquareCatalogId()` for the not-yet-configured behaviour.
   */
  squareCatalogId: string | null;
  /** Hero + gallery imagery (Vercel Blob; always render through next/image). */
  media: { hero: string; gallery: { url: string; alt: string }[] };
  /** SEO. `keywords` feeds the metadata export; `faqs` feeds FAQPage JSON-LD. */
  seo: { title: string; description: string; keywords: string[] };
  faqs: DealFaq[];
}

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const ARCADE_PHOTO = `${BLOB}/images/headpinz/gallery-arcade.webp`;
const LASER_PHOTO = `${BLOB}/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg`;
const GEL_PHOTO = `${BLOB}/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg`;

/** One Game Zone item worth `bonusTokens`. Comped value never lands in the
 *  purchased bucket — Intercard tracks the two separately, and a comp must
 *  never read as a sale in revenue reports. */
function gameZone(bonusTokens: number): VoucherItem {
  return { kind: "gamezone", tokens: 0, bonusTokens, bonusCashDollars: 0 };
}

function admission(slug: AttractionSlug): VoucherItem {
  return { kind: "attraction", slug, qty: 1 };
}

/** Dollars of Game Zone play one gamezone item is worth, at 10¢/token. */
export function gameZoneItemDollars(item: VoucherItem): number {
  if (item.kind !== "gamezone") return 0;
  return (item.tokens + item.bonusTokens) / 10;
}

const SHARED_FAQS: DealFaq[] = [
  {
    q: "How do I get my game cards?",
    a: "Scan the QR code on your voucher at any HeadPinz kiosk and it will print your cards with the play value already loaded. If you already have a HeadPinz game card, you can load the value onto it online instead from your voucher page — no need for a new card.",
  },
  {
    q: "Do I have to use everything on the same visit?",
    a: "No. Every item on the voucher is redeemed separately, so you can use one game card today and come back for the rest another day. Whatever you have not used stays on the code.",
  },
  {
    q: "Can I split it with a friend?",
    a: "Yes. The voucher is a bearer code — whoever has it can redeem it. If you are buying several packs, each pack gets its own code so you can forward one to each person.",
  },
  {
    q: "Do I need to book a time?",
    a: "Laser tag and gel blasters run as timed sessions, so we recommend picking a time. You can do that right after checkout, or any time later from your voucher page. Game cards never need a booking.",
  },
  {
    q: "Can I use this at either HeadPinz?",
    a: "Pick the location you plan to visit when you buy, so we load your game card value at the right center.",
  },
];

/**
 * The registry. Add a deal here and the page, the SEO, the Square line and the
 * minted voucher all follow — no new wizard code.
 */
export const DEAL_CATALOG: readonly DealCatalogEntry[] = [
  {
    slug: "laser-tag-game-card-pack",
    name: "Laser Tag + Game Card Pack",
    tagline: "Two rounds of multi-level laser tag and $20 of arcade play.",
    priceCents: 3400,
    items: [admission("laser-tag"), admission("laser-tag"), gameZone(100), gameZone(100)],
    scheduleSlug: "laser-tag",
    locations: DEAL_LOCATIONS,
    maxPerBuyer: 10,
    expiresMonths: 12,
    squareCatalogId: null,
    media: {
      hero: LASER_PHOTO,
      gallery: [
        { url: LASER_PHOTO, alt: "Players in the multi-level Nexus Laser Tag arena at HeadPinz" },
        { url: ARCADE_PHOTO, alt: "The HeadPinz arcade Game Zone" },
      ],
    },
    seo: {
      title: "Laser Tag Deal — 2 Players + $20 Arcade Play for $34",
      description:
        "Two Nexus Laser Tag sessions plus two $10 game cards for $34 at HeadPinz Fort Myers and Naples. A $44 value, and the cards are included — no activation fee.",
      keywords: [
        "laser tag deal fort myers",
        "laser tag fort myers",
        "laser tag naples fl",
        "arcade deal fort myers",
        "things to do with kids fort myers",
        "family fun deal southwest florida",
        "headpinz laser tag",
      ],
    },
    faqs: SHARED_FAQS,
  },
  {
    slug: "gel-blaster-game-card-pack",
    name: "Gel Blaster + Game Card Pack",
    tagline: "Two gel blaster battles and $30 of arcade play.",
    priceCents: 4500,
    items: [admission("gel-blaster"), admission("gel-blaster"), gameZone(150), gameZone(150)],
    scheduleSlug: "gel-blaster",
    locations: DEAL_LOCATIONS,
    maxPerBuyer: 10,
    expiresMonths: 12,
    squareCatalogId: null,
    media: {
      hero: GEL_PHOTO,
      gallery: [
        { url: GEL_PHOTO, alt: "A gel blaster battle in the glowing Nexus arena at HeadPinz" },
        { url: ARCADE_PHOTO, alt: "The HeadPinz arcade Game Zone" },
      ],
    },
    seo: {
      title: "Gel Blaster Deal — 2 Players + $30 Arcade Play for $45",
      description:
        "Two Nexus Gel Blaster sessions plus two $15 game cards for $45 at HeadPinz Fort Myers and Naples. A $58 value, and the cards are included — no activation fee.",
      keywords: [
        "gel blaster fort myers",
        "gel blaster naples fl",
        "gellyball fort myers",
        "arcade deal naples",
        "things to do with kids naples fl",
        "family fun deal southwest florida",
        "headpinz gel blaster",
      ],
    },
    faqs: SHARED_FAQS,
  },
] as const;

export function getDeal(slug: string): DealCatalogEntry | null {
  return DEAL_CATALOG.find((d) => d.slug === slug) ?? null;
}

/** Deals sellable at a location (all of them today; keeps the pages honest if
 *  that ever stops being true). */
export function dealsForLocation(location: DealLocationKey): DealCatalogEntry[] {
  return DEAL_CATALOG.filter((d) => d.locations.includes(location));
}

/**
 * The Square catalog id for a deal's sale line, or `null` while the owner has
 * not supplied one yet. Callers must treat `null` as "not sellable" rather than
 * charging without categorisation — an uncategorised sale is invisible in QBO
 * and there is no way to retro-fit it onto a captured payment.
 */
export function dealSquareCatalogId(deal: DealCatalogEntry): string | null {
  return deal.squareCatalogId;
}

export function dealIsSellable(deal: DealCatalogEntry): boolean {
  return deal.squareCatalogId !== null;
}

/* ─────────────────────────── value comparison ─────────────────────────── */

export interface DealValueLine {
  label: string;
  cents: number;
}

export interface DealValue {
  lines: DealValueLine[];
  /** Á la carte cost of everything in the pack, at this location. */
  compareAtCents: number;
  priceCents: number;
  savingsCents: number;
  /** Whole-number percent off, floored — never round a discount UP. */
  savingsPct: number;
}

/**
 * What the pack would cost à la carte AT THIS LOCATION, derived from the live
 * catalog rather than hardcoded. Two reasons it must be computed:
 *
 *   1. An advertised "$44 value" strikethrough has to be TRUE. Prices differ by
 *      location and change over time; a frozen number becomes a false claim the
 *      moment someone edits `attractions-data.ts`.
 *   2. Attraction prices are per-location (`AttractionProductDef.location`), so
 *      Fort Myers and Naples can legitimately differ.
 *
 * Game Zone value is counted at face ($10 of play = $10) plus the $2 per-card
 * activation fee a walk-in would pay for a brand-new card, which a pack waives.
 */
export function dealValue(deal: DealCatalogEntry, location: DealLocationKey): DealValue {
  const lines: DealValueLine[] = [];

  const admissions = deal.items.filter((i) => i.kind === "attraction");
  if (admissions.length > 0) {
    // Every admission item on a pack is the same slug today; group by slug so a
    // future mixed pack still prices correctly.
    const bySlug = new Map<string, number>();
    for (const item of admissions) {
      if (item.kind !== "attraction") continue;
      bySlug.set(item.slug, (bySlug.get(item.slug) ?? 0) + item.qty);
    }
    for (const [slug, qty] of bySlug) {
      const config = ATTRACTIONS[slug];
      const product = config?.products.find((p) => p.location === location);
      if (!config || !product) {
        // No product at this location => the pack should not have been offered
        // here. Fail loudly rather than quietly under-stating the value.
        throw new Error(`deal ${deal.slug}: no ${slug} product at ${location}`);
      }
      lines.push({
        label: `${qty} × ${config.shortName} (${config.durationLabel ?? "session"})`,
        cents: Math.round(product.price * 100) * qty,
      });
    }
  }

  const cardItems = deal.items.filter((i) => i.kind === "gamezone");
  if (cardItems.length > 0) {
    const playCents = cardItems.reduce((sum, i) => sum + gameZoneItemDollars(i) * 100, 0);
    lines.push({
      label: `${cardItems.length} × game card (${cardItems
        .map((i) => `$${gameZoneItemDollars(i)}`)
        .join(" + ")} of play)`,
      cents: Math.round(playCents),
    });
    lines.push({
      label: `${cardItems.length} × new-card activation fee`,
      cents: ACTIVATION_FEE_CENTS * cardItems.length,
    });
  }

  const compareAtCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const savingsCents = compareAtCents - deal.priceCents;
  return {
    lines,
    compareAtCents,
    priceCents: deal.priceCents,
    savingsCents,
    savingsPct: compareAtCents > 0 ? Math.floor((savingsCents / compareAtCents) * 100) : 0,
  };
}

/** `expires_at` for a pack bought now: N months out, end of that day in ET. */
export function dealExpiryFrom(purchasedAt: Date, months: number): string {
  const d = new Date(purchasedAt);
  d.setMonth(d.getMonth() + months);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  // -05:00 matches comboVoucherExpiry's convention (ET, standard offset) so
  // every voucher in the system expires on the same clock.
  return `${ymd}T23:59:59-05:00`;
}

/** The voucher items for `qty` packs — one voucher PER pack, so this is just
 *  the single-pack list; `mintVouchers({count: qty})` does the repetition. */
export function dealVoucherItems(deal: DealCatalogEntry): VoucherItem[] {
  return deal.items;
}
