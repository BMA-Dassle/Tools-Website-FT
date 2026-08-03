/**
 * VENDOR OUTAGE STATE — which upstream vendors are down right now.
 *
 * ONE environment variable controls everything:
 *
 *   MAINTENANCE_VENDORS_DOWN = "bmi"              one vendor down
 *   MAINTENANCE_VENDORS_DOWN = "bmi,bmi-office"   several
 *   (unset or empty)                              nothing down, everything on sale
 *
 * Nothing is down by default. Declaring an outage is adding a name to that list;
 * clearing it is removing the name. That is the whole model (owner 2026-08-03:
 * "have everything as off by default then tell me what to flip on"), and it
 * replaced a shape where outages were declared in CODE and then *cleared* by
 * per-vendor `MAINTENANCE_VENDOR_<X>=false` switches. Two concepts pointing in
 * opposite directions — declared-means-on plus a false-means-off override — was
 * not something the owner could reason about mid-incident, and being able to
 * reason about it at 11pm is worth more than what the old default-on shape bought.
 *
 * HOUSE-RULE NOTE (CLAUDE.md "FLAGS ARE KILL SWITCHES ONLY — never opt-in
 * gates"): this variable is NOT a feature gate. The maintenance FEATURE — this
 * registry, the notice page, the kiosk locks, the BMI proxy guard — is
 * unconditional code that always ships on. This is operational INPUT: which
 * vendor is broken today, a fact only a human knows. The genuine cost is that a
 * missing or mistyped value fails OPEN (we keep selling something we cannot
 * fulfil), so parseVendorsDown LOGS anything it doesn't recognize instead of
 * dropping it silently — a typo is the likeliest failure and the log line is what
 * makes it findable.
 *
 * Which products each vendor takes down lives in ./vendors.ts.
 */
import { VENDOR_LABEL, vendorsForProduct, type VendorKey } from "./vendors";

export interface VendorOutage {
  vendor: VendorKey;
  /** Guest copy for the WEB notice page. */
  web: {
    heading: string;
    /** Why they can't do the thing. */
    body: string;
    /** The phone answer, because the first thing a blocked guest does is call
     *  and the front desk is usually on the same vendor. */
    phoneNote: string;
    /**
     * ONE line for a locked CARD on the booking landing, under a "Temporarily
     * unavailable" label. A locked card has to explain itself standalone: the
     * banner at the top of the page carries the full story, but a guest scrolling
     * a grid of tiles may never read it, and "Temporarily unavailable" alone reads
     * like the product was discontinued rather than a passing outage (owner
     * 2026-08-03, looking at the live VIP card: "could say a bit more like system
     * issue, check back later today").
     *
     * Keep it to one sentence — it renders inside a button-sized box.
     */
    shortNote: string;
  };
  /** Guest copy for the KIOSK lock — EN + ES together (CLAUDE.md kiosk i18n
   *  rule), so one incident reads as one message in both languages. */
  kiosk: { en: string; es: string };
}

/**
 * Tailored guest copy per vendor. CONTENT, not state — it says nothing about
 * whether a vendor is down, only what to tell a guest if it is. A vendor with no
 * entry falls back to genericCopy, so adding a name to the env list always
 * produces a sensible page even before anyone writes wording for it.
 */
const VENDOR_COPY: Partial<Record<VendorKey, Omit<VendorOutage, "vendor">>> = {
  // BMI public-booking API — the SELLING rail: racing, laser tag, gel blasters,
  // Shuffle Showdown, race packs, Ultimate Qualifier, the VIP combo's race legs.
  bmi: {
    web: {
      heading: "We can’t book this online right now",
      body:
        "One of our vendors is having a system outage, so racing, laser tag, gel blasters and Shuffle Showdown can’t be booked online at the moment. Nothing was charged and no reservation was made.",
      phoneNote:
        "Our team can’t book these over the phone either while the outage lasts — please check back a little later. Already have a reservation? It’s safe, your confirmation still applies, and you can check in as normal when you arrive.",
      shortNote: "System issue with one of our vendors — please check back later today.",
    },
    kiosk: {
      en: "Temporarily unavailable — one of our vendors is having a system issue. Please see Guest Services.",
      es: "No disponible temporalmente — uno de nuestros proveedores tiene un problema en su sistema. Por favor, visita Servicio al Cliente.",
    },
  },
  // BMI Office API — the LOOKUP rail (reservation + guest-account search). Takes
  // the waiver flows down, because both have to FIND you before you can sign.
  "bmi-office": {
    web: {
      heading: "We can’t look up reservations right now",
      body:
        "One of our vendors is having a system outage, so we can’t pull up existing reservations or guest accounts at the moment. Your reservation itself is safe — we just can’t read it back to you online.",
      phoneNote:
        "Please see our team at Guest Services when you arrive — they can get you sorted without this. Bring your confirmation email or text if you have it.",
      shortNote: "System issue with one of our vendors — please check back later today.",
    },
    kiosk: {
      en: "Temporarily unavailable — one of our vendors is having a system issue. Please see Guest Services.",
      es: "No disponible temporalmente — uno de nuestros proveedores tiene un problema en su sistema. Por favor, visita Servicio al Cliente.",
    },
  },
};

/** Fallback wording for a vendor with no tailored entry — calm and correct, just
 *  not specific. Built from the vendor's own guest-facing label. */
function genericCopy(vendor: VendorKey): Omit<VendorOutage, "vendor"> {
  const who = VENDOR_LABEL[vendor];
  return {
    web: {
      heading: "This isn’t available online right now",
      body: `${who[0].toUpperCase()}${who.slice(1)} is having a system outage, so this can’t be completed online at the moment. Nothing was charged.`,
      phoneNote:
        "Our team is on the same system while the outage lasts — please check back a little later, or see Guest Services if you’re already here.",
      shortNote: "System issue with one of our vendors — please check back later today.",
    },
    kiosk: {
      en: "Temporarily unavailable — one of our vendors is having a system issue. Please see Guest Services.",
      es: "No disponible temporalmente — uno de nuestros proveedores tiene un problema en su sistema. Por favor, visita Servicio al Cliente.",
    },
  };
}

/**
 * Parse MAINTENANCE_VENDORS_DOWN into vendor keys. Read at CALL time (never
 * module scope) so a Vercel env change takes effect without a redeploy, and so
 * tests can stub process.env.
 *
 * Forgiving about SHAPE — case, surrounding spaces, and underscores-for-hyphens
 * all work, so "BMI_OFFICE" and " bmi-office " both land. The cost of rejecting a
 * value here is that we keep selling something we cannot fulfil, so the parser
 * should not be the thing that fails.
 *
 * An unrecognized name is LOGGED at error level, not silently dropped. Failing
 * open is the one real weakness of env-driven activation and a typo is by far the
 * likeliest cause; this is what turns a silent non-event into a findable line in
 * Vercel's runtime logs.
 */
function parseVendorsDown(): VendorKey[] {
  const raw = process.env.MAINTENANCE_VENDORS_DOWN;
  if (!raw || !raw.trim()) return [];
  const known = Object.keys(VENDOR_LABEL) as VendorKey[];
  const out: VendorKey[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim().toLowerCase().replace(/_/g, "-");
    if (!t) continue;
    const hit = known.find((k) => k === t);
    if (!hit) {
      console.error(
        `[maintenance] MAINTENANCE_VENDORS_DOWN: ignoring unknown vendor "${token.trim()}" — ` +
          `valid values are ${known.join(", ")}. NOTHING was taken off sale for it.`,
      );
      continue;
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Every vendor currently down, with the copy to show for it. */
export function activeOutages(): VendorOutage[] {
  return parseVendorsDown().map((vendor) => ({
    vendor,
    ...(VENDOR_COPY[vendor] ?? genericCopy(vendor)),
  }));
}

/** Is this vendor down right now? */
export function isVendorDown(vendor: VendorKey): boolean {
  return parseVendorsDown().includes(vendor);
}

/**
 * The active outage covering a product, or null when it's still available.
 *
 * A product needs EVERY vendor it depends on, so one down vendor is enough (the
 * VIP combo spans BMI + QAMF). When more than one is down, the one listed first
 * wins the copy — the guest gets one clear reason, not a vendor audit.
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
