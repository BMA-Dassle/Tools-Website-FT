/**
 * Static BMI product ID → Square catalog variation ID mapping.
 *
 * Sourced from Square catalog export 2026-05-27. The reserve API uses this
 * to build catalog-backed day-of order line items so Square is the financial
 * source of truth.
 *
 * All entries use overridePrice: true — the BMI price is passed as
 * base_price_money so the charge always matches what the customer saw.
 * The catalog ID is for Square Dashboard categorization, not pricing.
 *
 * Products not in this map fall back to ad-hoc line items (name + price,
 * no catalogObjectId). A warning is logged so we can backfill.
 */

// ── Square location IDs ──────────────────────────────────────────────────
export const SQUARE_LOCATIONS = {
  FASTTRAX_FM: "LAB52GY480CJF",
  HEADPINZ_FM: "TXBSQN0FEKQ11",
  HEADPINZ_NAP: "PPTR5G2N0QXF7",
} as const;

// ── Tax catalog object IDs (reused from bowling-orders) ──────────────────
export const LOCATION_TAX: Record<string, string> = {
  [SQUARE_LOCATIONS.FASTTRAX_FM]: "UBPQTR3W6ZKVRYFC7DXN2SJN", // Lee County 6.5%
  [SQUARE_LOCATIONS.HEADPINZ_FM]: "UBPQTR3W6ZKVRYFC7DXN2SJN", // Lee County 6.5%
  [SQUARE_LOCATIONS.HEADPINZ_NAP]: "BQNVIEEZQO2PX2FI72U6FEC4", // Collier County 6.0%
};

// ── Catalog variation IDs ────────────────────────────────────────────────
const SQ = {
  KARTING: "5FINJYYPPELXTERF2THUDCPT",
  JR_MON_THU: "2QZKX6UJRJKODZFILOLJGCT2",
  JR_FRI_SUN: "FGTYWX2J3YGF7C5XT7B4BZDP",
  MINI_KARTS: "BIVKDY5Y2QCWGQRDDWZR5BG7",
  LICENSE: "7GUST7MZ25TOBOB4UXPDYPV4",
  HEADSOCK: "IRKUPTF2ITBTTDPHMOIIIQVE",
  RACE_PACK: "YYOV5QCHQSJKZS7DDIALGU7Z",
  GEL_BLASTER: "IPAKRTMOYX37ATF7UBJCXQSP",
  LASER_TAG: "TXNWQI43HNMX2EHP72ZPUVXU",
  DUCKPIN: "EXW7E74IRPYJAQFA4YIIEW3G",
  SHUFFLY_30: "J2FGLI7X4FSO4X35W4ZXI52L",
  SHUFFLY_1HR: "47RPZJOQU3VSIDFRFBPNZPED",
  SHUFFLY_BEER: "ZIGCPLUWE5KIZQYWAWDVYO4G",
  ATTR_REVENUE: "2PJWP7YOVO5QG6ZCJW62LMV7",
} as const;

export { SQ as SQUARE_CATALOG_IDS };

/**
 * BMI productId → Square catalog variation ID.
 *
 * All entries override price with the BMI amount. The catalog ID provides
 * Square Dashboard categorization only.
 */
export const SQUARE_CATALOG_MAP: Record<string, string> = {
  // ── Adult races → Karting (all tiers, all tracks, all schedules) ────
  // New racers — weekday
  "24960859": SQ.KARTING, // Starter Red
  "24960393": SQ.KARTING, // Starter Blue
  "24960650": SQ.KARTING, // Intermediate Red
  "24958077": SQ.KARTING, // Intermediate Blue
  "24963023": SQ.KARTING, // Pro Red
  "24963136": SQ.KARTING, // Pro Blue
  // New racers — weekend
  "24953280": SQ.KARTING, // Starter Red
  "24952964": SQ.KARTING, // Starter Blue
  "24964317": SQ.KARTING, // Intermediate Red
  "24952410": SQ.KARTING, // Intermediate Blue
  // New racers — mega
  "24965505": SQ.KARTING, // Starter Mega
  "24965707": SQ.KARTING, // Intermediate Mega
  "24965768": SQ.KARTING, // Pro Mega
  // Existing racers — weekday
  "43734325": SQ.KARTING, // Starter Blue
  "43734615": SQ.KARTING, // Starter Red
  "43726976": SQ.KARTING, // Intermediate Blue
  "43727363": SQ.KARTING, // Intermediate Red
  "43733371": SQ.KARTING, // Pro Blue
  "43733839": SQ.KARTING, // Pro Red
  // Existing racers — weekend
  "43734229": SQ.KARTING, // Starter Blue
  "43734485": SQ.KARTING, // Starter Red
  "43726940": SQ.KARTING, // Intermediate Blue
  "43727216": SQ.KARTING, // Intermediate Red
  // Existing racers — mega
  "43734407": SQ.KARTING, // Starter Mega
  "43727015": SQ.KARTING, // Intermediate Mega
  "43733733": SQ.KARTING, // Pro Mega
  // Combo packs (3-heat day-of)
  "45094787": SQ.KARTING, // Pro Mega 3-Pack
  "45094734": SQ.KARTING, // Int Mega 3-Pack
  "45094857": SQ.KARTING, // Int Weekday 3-Pack Red
  "45094906": SQ.KARTING, // Int Weekday 3-Pack Blue
  "45094954": SQ.KARTING, // Pro Weekday 3-Pack Red
  "45095003": SQ.KARTING, // Pro Weekday 3-Pack Blue
  "45095096": SQ.KARTING, // Int Weekend 3-Pack Red
  "45095051": SQ.KARTING, // Int Weekend 3-Pack Blue

  // ── Junior races — weekday/mega → Junior Racing Mon-Thur ───────────
  "24960106": SQ.JR_MON_THU, // New Starter Blue
  "24958587": SQ.JR_MON_THU, // New Intermediate Blue
  "24963258": SQ.JR_MON_THU, // New Pro Blue
  "24966320": SQ.JR_MON_THU, // New Int Mega
  "24966863": SQ.JR_MON_THU, // New Pro Mega
  "43733263": SQ.JR_MON_THU, // Existing Starter Blue
  "43732159": SQ.JR_MON_THU, // Existing Int Blue
  "43732593": SQ.JR_MON_THU, // Existing Pro Blue
  "43732358": SQ.JR_MON_THU, // Existing Int Mega
  "43732675": SQ.JR_MON_THU, // Existing Pro Mega

  // ── Junior races — weekend → Junior Racing Fri-Sun ─────────────────
  "24953399": SQ.JR_FRI_SUN, // New Starter Blue
  "24954302": SQ.JR_FRI_SUN, // New Int Blue
  "43733133": SQ.JR_FRI_SUN, // Existing Starter Blue
  "43729633": SQ.JR_FRI_SUN, // Existing Int Blue

  // ── Gel Blaster ────────────────────────────────────────────────────
  "8976680": SQ.GEL_BLASTER, // HeadPinz FM
  "7565025": SQ.GEL_BLASTER, // Naples

  // ── Laser Tag ──────────────────────────────────────────────────────
  "8976685": SQ.LASER_TAG, // HeadPinz FM
  "7565567": SQ.LASER_TAG, // Naples

  // ── Duck Pin Bowling ───────────────────────────────────────────────
  "24711034": SQ.DUCKPIN, // 30 min
  "23345635": SQ.DUCKPIN, // 1 hour

  // ── Shuffly (FastTrax) ────────────────────────────────────────────
  "24709515": SQ.SHUFFLY_30, // 30 min
  "23345625": SQ.SHUFFLY_1HR, // 1 hour
  "24731238": SQ.SHUFFLY_BEER, // 1hr + beer bucket
  // 25769498: Shuffly 1HR + Pizza — no Square catalog item yet, falls back to ad-hoc

  // ── Shuffly (HeadPinz) ────────────────────────────────────────────
  "24709632": SQ.SHUFFLY_30, // 30 min
  "24408105": SQ.SHUFFLY_1HR, // 1 hour
  "25609182": SQ.SHUFFLY_BEER, // 1hr + beer bucket
  // 25769534: Shuffly 1HR + Pizza — no Square catalog item yet, falls back to ad-hoc
};

/**
 * Well-known line item names → catalog ID. Used for bill overview items
 * that don't have a BMI product ID (auto-added by BMI, e.g. license).
 */
export const NAME_CATALOG_MAP: Record<string, string> = {
  "License Fee": SQ.LICENSE,
  "FastTrax License": SQ.LICENSE,
  Headsock: SQ.HEADSOCK,
};

/**
 * Look up the Square catalog variation ID for a BMI product.
 * Returns null for unmapped products (which use ad-hoc line items).
 */
export function lookupCatalogId(bmiProductId: string): string | null {
  return SQUARE_CATALOG_MAP[bmiProductId] ?? null;
}

/**
 * Look up catalog ID by bill line item name (fallback for auto-added items).
 */
export function lookupCatalogIdByName(name: string): string | null {
  for (const [key, val] of Object.entries(NAME_CATALOG_MAP)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return null;
}
