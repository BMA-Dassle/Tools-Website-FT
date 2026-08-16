/**
 * Tier-expectation warnings — "this race is slower than you think".
 *
 * A parent books Junior Starter for a kid who already races karts, then finds
 * out at the track that Starter is our slowest kart speed and everyone starts
 * there regardless of experience. The disappointment lands on Guest Services,
 * and the reservation says nothing about what the guest was told.
 *
 * So: before the heat is held, show the warning, make them tick every box, and
 * offer the package that actually solves it (the Ultimate Qualifier — Starter to
 * qualify, then Intermediate once they level up). If they decline, record that
 * on the bill memo so staff at the counter know the conversation already
 * happened.
 *
 * ── Why this is a REGISTRY and not an `if (category === "junior")` ──────────
 *
 * The same problem exists for adults, and the owner wants the option without
 * shipping it yet (2026-08-16: "build this in a way we might use for adults too
 * but not right now"). So the rule is DATA. Adding adults later is one record
 * here plus its copy in the catalog — no component touched, no wiring changed,
 * because every surface resolves through `raceWarningFor()` and renders whatever
 * comes back.
 *
 * There is deliberately NO disabled adult entry sitting here waiting to be
 * flipped on. House rule: flags are kill switches, never opt-in gates — "not
 * ready to be on = not ready to merge". When adults are wanted, add the record.
 *
 * Display copy lives in the kiosk i18n catalog (EN + ES), NOT in this file, for
 * the same reason `HeightAgeConfirmModal` does it: `useT()` falls back to
 * English outside a LocaleProvider, so one component and one set of keys serve
 * web and kiosk both, and the Spanish can't be forgotten (a missing ES key fails
 * tsc). Only the STAFF-facing bill memo is a literal here — it is English-only
 * by design, never shown to a guest.
 */
import type { MessageKey } from "~/features/kiosk/i18n";
import {
  TIER_QUAL_RANK,
  qualifiedTierForCategory,
  type RaceCategory,
  type RaceProduct,
  type RaceTier,
} from "./race-products";

export interface RaceWarning {
  /** Stable id. Recorded on the booking item when acknowledged, so the memo can
   *  say WHICH warning was shown rather than inferring it from the product. */
  id: string;
  /** Only fires for this racer category. */
  category: RaceCategory;
  /** Only fires when the race being booked is at this tier. */
  tier: RaceTier;
  /**
   * Only fires while the category's racers are qualified at or BELOW this tier.
   * Someone who already holds Intermediate and deliberately books down to
   * Starter knows exactly what Starter is — and the upsell is not offered to
   * them anyway (`maxQualifiedTier` on the package), so warning them would
   * recommend something they cannot buy.
   */
  maxQualifiedTier: RaceTier;
  /**
   * Package id prefixes that still count as "this tier only" and therefore
   * still warn — a bundle whose extra value is a licence and a video, not a
   * faster second heat.
   *
   * A package that bundles a HIGHER-tier heat must never be listed: it is the
   * thing this warning is steering people toward, and it carries its own
   * disclaimer, so listing it would show a guest two modals back to back.
   */
  warnOnPackagePrefixes: readonly string[];
  /** Package family to offer as the way out, or null for a warning with no
   *  upsell. The caller still has to confirm a variant is actually bookable
   *  for the date before offering it — see `RaceWarningModal`. */
  upsellPackagePrefix: string | null;
  /** Catalog keys. Copy never lives in this file — see the header. */
  titleKey: MessageKey;
  bodyKey: MessageKey;
  /** The one line that must survive being skimmed, rendered in the warn colour
   *  rather than body grey. Omit for a warning with no single headline term. */
  emphasisKey?: MessageKey;
  /** Label on the "yes, book this anyway" button. Names the tier, so it reads
   *  as a deliberate choice rather than a generic Continue. */
  continueKey: MessageKey;
  /** Label on the upsell button. Paired with `upsellPackagePrefix` — a family
   *  id can't produce a guest-facing name, so the copy is its own key. */
  upsellKey?: MessageKey;
  ackKeys: readonly MessageKey[];
  /** Staff-facing BMI bill memo, written only when the guest saw this warning
   *  and continued anyway. English — the booking memo is a staff surface (BMI
   *  Booking app "Memo and image" tab) and never reaches the guest. */
  billMemo: string;
}

export const JUNIOR_STARTER_WARNING: RaceWarning = {
  id: "junior-starter-speed",
  category: "junior",
  tier: "starter",
  maxQualifiedTier: "starter",
  // Rookie Pack is a Starter race + licence + POV — still one slow race, so the
  // parent gets the same surprise. Ultimate Qualifier and BOGO both include an
  // Intermediate heat and are deliberately absent.
  warnOnPackagePrefixes: ["rookie-pack"],
  upsellPackagePrefix: "ultimate-qualifier",
  titleKey: "raceWarning.juniorStarter.title",
  bodyKey: "raceWarning.juniorStarter.body",
  emphasisKey: "raceWarning.juniorStarter.permanent",
  continueKey: "raceWarning.juniorStarter.continue",
  upsellKey: "raceWarning.juniorStarter.upsell",
  ackKeys: [
    "raceWarning.juniorStarter.ack.slow",
    "raceWarning.juniorStarter.ack.permanent",
    "raceWarning.juniorStarter.ack.declined",
  ],
  billMemo:
    "** JUNIOR STARTER — UPGRADE DECLINED ** Parent was shown the Junior Starter speed warning at booking and was offered the Ultimate Qualifier. They acknowledged that Junior Starter runs at our slowest speed and that levelling up is automatic and permanent, and chose Junior Starter only. STAFF: if they ask about faster karts, offer the Ultimate Qualifier upgrade.",
};

/** Every warning in play. Add a record to cover another category or tier. */
export const RACE_WARNINGS: readonly RaceWarning[] = [JUNIOR_STARTER_WARNING];

export interface RaceWarningContext {
  /** Which side of a mixed party is being booked right now. */
  category: RaceCategory;
  /** BMI memberships across the racers of that category. */
  memberships: string[];
  /** The single race product being selected, if any. */
  product?: Pick<RaceProduct, "tier" | "category"> | null;
  /** The package being selected, if any. Mutually exclusive with `product` in
   *  every flow, but both are accepted so callers don't have to normalise. */
  packageId?: string | null;
}

/**
 * The warning this selection triggers, or null.
 *
 * Returns the FIRST match — at most one warning should apply to a given
 * category+tier, and showing two stacked modals would be worse than showing
 * neither.
 */
export function raceWarningFor(ctx: RaceWarningContext): RaceWarning | null {
  const { category, memberships, product, packageId } = ctx;
  if (!product && !packageId) return null;

  const qualified = qualifiedTierForCategory(memberships, category);

  return (
    RACE_WARNINGS.find((w) => {
      if (w.category !== category) return false;
      if (TIER_QUAL_RANK[qualified] > TIER_QUAL_RANK[w.maxQualifiedTier]) return false;

      if (packageId) {
        // Prefix match on the package FAMILY, not `.includes()`. Substring
        // matching on tier names is what let a junior pro book adult Pro on
        // 2026-07-30; the same sloppiness here would make "ultimate-qualifier"
        // match a "rookie-pack" rule the moment someone renames a variant.
        return w.warnOnPackagePrefixes.some((p) => packageId.startsWith(p));
      }

      // A product carries its own category. Trust it over the step's, so a
      // mis-wired caller can't warn an adult with junior copy.
      return product!.category === category && product!.tier === w.tier;
    }) ?? null
  );
}

/** Bill-memo line for a warning the guest acknowledged and continued past.
 *  Null when nothing was acknowledged — the memo must never claim an
 *  acknowledgement that did not happen. */
export function raceWarningMemo(warningId: string | null | undefined): string | null {
  if (!warningId) return null;
  return RACE_WARNINGS.find((w) => w.id === warningId)?.billMemo ?? null;
}
