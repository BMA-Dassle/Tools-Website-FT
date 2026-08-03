/**
 * VENDOR OUTAGE REGISTRY — the one switch that takes a vendor's products off
 * sale everywhere (web + kiosk) with a guest-readable reason.
 *
 * Declared here rather than in a DB so turning it on is a deploy, not a schema:
 * during an outage the fastest safe change is the one that needs no admin UI and
 * no migration. An entry in OUTAGES *is* an active outage — declared means on —
 * and each is cleared by an env var when its vendor recovers. No redeploy: these
 * are runtime, server-only vars, NOT build-baked NEXT_PUBLIC_*.
 *
 * HOUSE RULE COMPLIANCE (CLAUDE.md "FLAGS ARE KILL SWITCHES ONLY"): every flag
 * here defaults ON (`!== "false"`) and only ever turns something OFF. What it
 * turns off is the outage guard, so the guard is live the moment it merges
 * (owner 2026-08-03: "need this on by default asap we can do with flags later").
 *
 * ── 2026-08-03 incident scope, as established with the owner ────────────────
 * DOWN: the BMI PUBLIC BOOKING API (api.bmileisure.com/public-booking) — the
 *       selling rail. Racing, laser tag, gel blasters, Shuffle Showdown, race
 *       packs, the Ultimate Qualifier, and the Ultimate VIP combo (BMI legs).
 * UP:   BMI Office (reservation + account lookup, so CHECK-IN works), Pandora
 *       (person records, deposits, waiver signing — so WAIVERS work), QAMF
 *       (bowling, duckpin, KBF), Intercard (Game Zone), Square, Neon.
 *
 * Group-event CONTRACTS are deliberately not blocked: viewing, signing and
 * paying a balance are Neon + Square + Blob, the planner-notes panel already
 * falls back to the DB, and the phone/waiver pushes go to Pandora. Blocking them
 * would stop us collecting group balances we can still collect.
 *
 * `checkin` and `waiver` ARE attributed to bmi-office in vendors.ts and their
 * guards are wired and tested — they are ARMED, not active. If Office drops (it
 * did 01:46–06:15 this same morning), one entry below or one env var takes both
 * surfaces down with the right copy.
 *
 * ── TO CLEAR AN OUTAGE (BMI booking back up) ───────────────────────────────
 *   Vercel → Settings → Environment Variables → MAINTENANCE_VENDOR_BMI = "false"
 *   Effective on the next request; kiosk tiles unlock within one
 *   /api/kiosk/availability TTL (≤3 min). Then delete the entry below in a
 *   follow-up PR so the registry stays honest.
 *
 * ── TO DECLARE A NEW OUTAGE WITHOUT A DEPLOY ────────────────────────────────
 *   MAINTENANCE_VENDORS_DOWN = "bmi-office"   (comma-separated)
 *   Uses generic copy built from VENDOR_LABEL. Good enough to stop the bleeding
 *   mid-incident; follow up with a real entry here for tailored wording.
 */
import { VENDOR_LABEL, vendorsForProduct, type VendorKey } from "./vendors";

export interface VendorOutage {
  vendor: VendorKey;
  /** When we started blocking (ET) — read by ops, never shown to guests. */
  since: string;
  /** Guest copy for the WEB notice page. */
  web: {
    heading: string;
    /** Why they can't do the thing. */
    body: string;
    /** The phone answer, because the first thing a blocked guest does is call
     *  and the front desk is on the same vendor (owner 2026-08-03). */
    phoneNote: string;
  };
  /** Guest copy for the KIOSK lock — EN + ES in the same commit (CLAUDE.md kiosk
   *  i18n rule). Beside the web copy so one incident reads as one message. */
  kiosk: { en: string; es: string };
}

const OUTAGES: VendorOutage[] = [
  {
    vendor: "bmi",
    since: "2026-08-03",
    web: {
      heading: "We can’t book this online right now",
      body:
        "One of our vendors is having a system outage, so racing, laser tag, gel blasters and Shuffle Showdown can’t be booked online at the moment. Nothing was charged and no reservation was made.",
      phoneNote:
        "Our team can’t book these over the phone either while the outage lasts — please check back a little later. Already have a reservation? It’s safe, your confirmation still applies, and you can check in as normal when you arrive.",
    },
    kiosk: {
      en: "Temporarily unavailable — one of our vendors is having a system issue. Please see Guest Services.",
      es: "No disponible temporalmente — uno de nuestros proveedores tiene un problema en su sistema. Por favor, visita Servicio al Cliente.",
    },
  },
];

/**
 * Is this vendor's DECLARED entry still switched on?
 *
 * Static per-vendor reads (not `process.env[\`…${vendor}\`]`) so each value is
 * greppable and adding a vendor is a deliberate edit here rather than an env var
 * someone guesses the name of. Read at CALL time so tests can stub process.env.
 */
function outageEnabled(vendor: VendorKey): boolean {
  switch (vendor) {
    case "bmi":
      return process.env.MAINTENANCE_VENDOR_BMI !== "false";
    case "bmi-office":
      return process.env.MAINTENANCE_VENDOR_BMI_OFFICE !== "false";
    case "pandora":
      return process.env.MAINTENANCE_VENDOR_PANDORA !== "false";
    case "qamf":
      return process.env.MAINTENANCE_VENDOR_QAMF !== "false";
    case "intercard":
      return process.env.MAINTENANCE_VENDOR_INTERCARD !== "false";
  }
}

/** Vendors declared down via the no-deploy escape hatch. */
function adHocVendorsDown(): VendorKey[] {
  const raw = process.env.MAINTENANCE_VENDORS_DOWN;
  if (!raw) return [];
  const known = Object.keys(VENDOR_LABEL) as VendorKey[];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is VendorKey => (known as string[]).includes(s));
}

/** A generic outage for a vendor declared through MAINTENANCE_VENDORS_DOWN.
 *  Copy is assembled from the vendor label — correct and calm, just not tailored.
 *  Add a real OUTAGES entry when there's time to write the specific wording. */
function genericOutage(vendor: VendorKey): VendorOutage {
  const who = VENDOR_LABEL[vendor];
  return {
    vendor,
    since: "ad-hoc",
    web: {
      heading: "This isn’t available online right now",
      body: `${who[0].toUpperCase()}${who.slice(1)} is having a system outage, so this can’t be completed online at the moment. Nothing was charged.`,
      phoneNote:
        "Our team is on the same system while the outage lasts — please check back a little later, or see Guest Services if you’re already here.",
    },
    kiosk: {
      en: "Temporarily unavailable — one of our vendors is having a system issue. Please see Guest Services.",
      es: "No disponible temporalmente — uno de nuestros proveedores tiene un problema en su sistema. Por favor, visita Servicio al Cliente.",
    },
  };
}

/**
 * Outages that are in force right now: declared entries whose switch is still on,
 * plus any vendor named in MAINTENANCE_VENDORS_DOWN. A declared entry wins, so
 * naming a vendor in both keeps the tailored copy.
 */
export function activeOutages(): VendorOutage[] {
  const declared = OUTAGES.filter((o) => outageEnabled(o.vendor));
  const seen = new Set(declared.map((o) => o.vendor));
  const adHoc = adHocVendorsDown()
    .filter((v) => !seen.has(v))
    .map(genericOutage);
  return [...declared, ...adHoc];
}

/** Is this vendor down (declared + switch on, or named ad-hoc)? */
export function isVendorDown(vendor: VendorKey): boolean {
  return activeOutages().some((o) => o.vendor === vendor);
}

/**
 * The active outage covering a product, or null when it's still available.
 *
 * A product needs EVERY vendor it depends on, so one down vendor is enough (the
 * VIP combo spans BMI + QAMF). When more than one is down the first wins the
 * copy — the guest gets one clear reason, not a vendor audit.
 */
export function outageForProduct(id: string): VendorOutage | null {
  const vendors = vendorsForProduct(id);
  if (vendors.length === 0) return null;
  return activeOutages().find((o) => vendors.includes(o.vendor)) ?? null;
}

/** Is this product unavailable right now? */
export function isProductPaused(id: string): boolean {
  return outageForProduct(id) !== null;
}

/** Guest-facing vendor phrase for a heading ("one of our booking vendors"). */
export function vendorPhrase(vendor: VendorKey): string {
  return VENDOR_LABEL[vendor];
}
