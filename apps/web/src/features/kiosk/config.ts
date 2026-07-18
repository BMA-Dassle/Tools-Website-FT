/**
 * Per-device kiosk configuration.
 *
 * A kiosk is provisioned ONCE by opening
 *   /kiosk?center=fasttrax&reader=DEVICE_ID(&variant=podium)
 * — the params are merged over localStorage and persisted, so every
 * subsequent boot of the pinned browser profile (and every in-flow reset)
 * reads the saved config with a clean /kiosk URL. This is deliberately
 * localStorage (not sessionStorage, not URL threading): it must survive
 * browser restarts on the dedicated PC and be immune to the booking-session
 * wipes that happen between guests.
 *
 * - `center` in the URL is a VENUE slug that DETERMINES THE BRAND (owner
 *   decision 2026-07-17): "fasttrax" → FastTrax @ Fort Myers,
 *   "headpinz" / "headpinz-fm" → HeadPinz @ Fort Myers, "naples" →
 *   HeadPinz @ Naples. Internally we store the booking CenterCode + Brand
 *   pair. REQUIRED — without it the attract screen shows a one-time setup
 *   card instead of the attract loop.
 * - `readerId` is the Square Terminal/reader device id for this kiosk.
 *   Stored and plumbed, consumed only by the payment-method seam.
 * - `variant` picks the presentation set — "podium" (cinematic, default) or
 *   "pitcrew" (one-question-per-screen). Both render the same flows.
 */
import type { Brand, CenterCode } from "~/features/booking";

export type KioskVariant = "podium" | "pitcrew";

export interface KioskConfig {
  center: CenterCode;
  brand: Brand;
  /** Square Terminal/reader device id for card-present checkouts (Devices API). */
  readerId: string | null;
  variant: KioskVariant;
  /** Staff-assigned kiosk number at this location (e.g. 1, 2). */
  kioskNumber?: number | null;
  /**
   * Connected Game Zone card DISPENSER device id (null = none). A dispenser
   * reads AND writes cards, so it enables BOTH buying a new card and reloading.
   */
  dispenserId?: string | null;
  /**
   * Whether a Game Zone card MSR (magnetic-stripe reader) is attached. An MSR
   * reads/writes an EXISTING card but can't dispense a new one, so it enables
   * RELOAD ONLY (owner 2026-07-19). Ignored when a dispenser is present.
   */
  msrEnabled?: boolean;
  /** Whether a keyboard-wedge QR/barcode scanner is attached (login codes + vouchers). */
  scannerEnabled?: boolean;
  /**
   * How the guest pays.
   *  - "reader"  — paired Square Terminal/reader (readerId), card-present.
   *  - "swipe"   — attached USB magstripe swipe (keyboard-wedge/HID).
   *  - "manual"  — typed into the Square Web Payments card iframe (default; the
   *                Windows touch keyboard handles it).
   * PCI note: raw magstripe track data must never be parsed in our JS — a
   * "swipe" device is fed into Square's own card entry / manual-entry path.
   */
  cardInputMethod?: "reader" | "swipe" | "manual";
  /** Whether a USB card swipe is attached (enables the "swipe" method). */
  swipeEnabled?: boolean;
}

/** Stable per-device id used to pull the saved setup back from Neon. */
export function kioskId(cfg: Pick<KioskConfig, "center" | "kioskNumber">): string {
  return `${cfg.center}:${cfg.kioskNumber ?? 1}`;
}

const STORAGE_KEY = "kiosk_config";

/** Bump when the persisted SHAPE changes — older envelopes are discarded. */
const CONFIG_VERSION = 2;

interface PersistedEnvelope {
  v: number;
  config: KioskConfig;
}

/**
 * Venue slug → (CenterCode, Brand). The URL's `center` names the physical
 * kiosk location, which determines the brand. Legacy CenterCode values are
 * still accepted for the two unambiguous cases.
 */
function normalizeVenue(raw: string | undefined): { center: CenterCode; brand: Brand } | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "naples" || v === "hpn" || v === "headpinz-naples") {
    return { center: "naples", brand: "headpinz" };
  }
  if (v === "fasttrax" || v === "ft" || v === "fasttrax-fm") {
    return { center: "fort-myers", brand: "fasttrax" };
  }
  if (v === "headpinz" || v === "hp" || v === "headpinz-fm" || v === "hpfm") {
    return { center: "fort-myers", brand: "headpinz" };
  }
  // Legacy CenterCode value — FastTrax side by default (brand param can override).
  if (v === "fort-myers" || v === "fortmyers" || v === "fort_myers" || v === "fm") {
    return { center: "fort-myers", brand: "fasttrax" };
  }
  return null;
}

function normalizeBrand(raw: string | undefined): Brand | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "headpinz" || v === "hp") return "headpinz";
  if (v === "fasttrax" || v === "ft") return "fasttrax";
  return null;
}

function normalizeVariant(raw: string | undefined): KioskVariant | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "podium" || v === "pitcrew") return v;
  return null;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parse the provisioning URL params (all optional). */
export function parseKioskConfigFromSearchParams(
  sp: Record<string, string | string[] | undefined>,
): Partial<KioskConfig> {
  const out: Partial<KioskConfig> = {};
  const venue = normalizeVenue(first(sp.center) ?? first(sp.location));
  if (venue) {
    out.center = venue.center;
    out.brand = venue.brand;
  }
  // Explicit brand override (rarely needed — venue slug already implies it).
  const brand = normalizeBrand(first(sp.brand));
  if (brand) out.brand = brand;
  const variant = normalizeVariant(first(sp.variant));
  if (variant) out.variant = variant;
  const reader = first(sp.reader);
  if (typeof reader === "string" && reader.trim()) out.readerId = reader.trim();
  // Kiosk number — lets a fresh/re-imaged device (or a new deploy URL, where
  // localStorage doesn't carry over) recover its EXACT saved config from Neon by
  // kioskId (`<center>:<kioskNumber>`). Without this the cloud fallback always
  // assumed #1 and couldn't find e.g. fort-myers:4. Accept ?kiosk= or ?kioskNumber=.
  const kioskNumRaw = first(sp.kiosk) ?? first(sp.kioskNumber);
  const kioskNum = kioskNumRaw != null ? parseInt(kioskNumRaw, 10) : NaN;
  if (Number.isFinite(kioskNum) && kioskNum > 0) out.kioskNumber = kioskNum;
  return out;
}

/**
 * Fill defaults + enforce invariants over a partial. Returns null when the
 * partial can't make a full config (no center) — caller shows the setup card.
 * Naples forces HeadPinz: there is no FastTrax venue at Naples.
 */
export function resolveKioskConfig(partial: Partial<KioskConfig>): KioskConfig | null {
  if (!partial.center) return null;
  const brand: Brand = partial.center === "naples" ? "headpinz" : (partial.brand ?? "fasttrax");
  return {
    center: partial.center,
    brand,
    readerId: partial.readerId ?? null,
    variant: partial.variant ?? "podium",
    kioskNumber: partial.kioskNumber ?? 1,
    dispenserId: partial.dispenserId ?? null,
    msrEnabled: partial.msrEnabled ?? false,
    scannerEnabled: partial.scannerEnabled ?? false,
    cardInputMethod: partial.cardInputMethod ?? (partial.readerId ? "reader" : "manual"),
    swipeEnabled: partial.swipeEnabled ?? false,
  };
}

/**
 * What Game Zone card actions this kiosk's hardware supports (owner 2026-07-19):
 *  - "full"   — a card DISPENSER is connected (reads + writes): buy new + reload.
 *  - "reload" — only an MSR reader is attached (reads/writes an existing card): reload only.
 *  - "none"   — no card hardware: Game Zone cards unavailable on this kiosk.
 */
export function gameZoneCapability(cfg: KioskConfig | null): "full" | "reload" | "none" {
  if (!cfg) return "none";
  if (cfg.dispenserId) return "full";
  if (cfg.msrEnabled) return "reload";
  return "none";
}

/** URL params win over stored values field-by-field. */
export function mergeKioskConfig(
  stored: KioskConfig | null,
  url: Partial<KioskConfig>,
): KioskConfig | null {
  return resolveKioskConfig({ ...(stored ?? {}), ...url });
}

/* ------------------------------------------------------------------ */
/* Tiny external store so React reads config via useSyncExternalStore  */
/* (avoids setState-in-effect hydration patterns the lint rules flag).  */
/* ------------------------------------------------------------------ */

let cache: KioskConfig | null | undefined; // undefined = localStorage not read yet
const listeners = new Set<() => void>();

function readStorage(): KioskConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (parsed?.v !== CONFIG_VERSION || !parsed.config) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // Re-resolve so invariants (Naples→HeadPinz, defaults) self-heal.
    return resolveKioskConfig(parsed.config);
  } catch {
    return null;
  }
}

export function loadKioskConfig(): KioskConfig | null {
  if (cache === undefined) cache = typeof window === "undefined" ? null : readStorage();
  return cache;
}

export function saveKioskConfig(config: KioskConfig): void {
  cache = config;
  try {
    const envelope: PersistedEnvelope = { v: CONFIG_VERSION, config };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    /* storage disabled — config lives for this tab only */
  }
  listeners.forEach((l) => l());
}

export function subscribeKioskConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** SSR snapshot — the server never knows a device config. */
export function serverKioskConfig(): KioskConfig | null {
  return null;
}

/** Test-only: reset the module cache between cases. */
export function __resetKioskConfigForTests(): void {
  cache = undefined;
  listeners.clear();
}
