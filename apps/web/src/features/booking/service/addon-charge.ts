/**
 * Booking add-on CHARGE lines — the single money source for retail extras
 * (v1: replacement headsock). Consumed by `buildRaceChargeLines` (charge,
 * quote, review — all derive from it) AND by CartView's estimate via
 * `estimateAddonsTotal`, so displayed == charged by construction.
 *
 * Line shape rules:
 *   - One line PER SELECTED RACER for per-racer add-ons — the cart/receipt
 *     must read "Replacement Headsock · Dana" (owner 2026-08-10) and the
 *     grant rail needs per-person rows anyway.
 *   - `bmiProductId` carries the synthetic chargeLineKey ("addon-headsock")
 *     which SQUARE_CATALOG_MAP resolves to the real Square variation.
 *   - NO `domain` and NO `visitDate` — the promo engine fails closed on
 *     unscoped lines and membership racing discounts never see them, so a
 *     25%-off race code can't discount a headsock.
 */
import type { BillLine } from "./checkout";
import type { AddonPurchaseIntent } from "../data/addon-purchases-db";
import type { BookingSession, PartyMember, RaceItem } from "../state/types";
import { racerNeedsLicense } from "./license";
import {
  bookingAddonsEnabled,
  getBookingAddon,
  offerableAddons,
  type BookingAddon,
} from "../data/addon-catalog";

/**
 * The party members an add-on may be sold FOR — the ONE eligibility seam the
 * offer UI (AddonCard chips, step visibility, cart teaser), the charge lines,
 * the grant intents, and the $0 BMI plan all share, so a racer the card never
 * offered can never be charged (and vice versa).
 *
 * "has-license" (the headsock): a racer who OWES a license with this booking
 * (racerNeedsLicense — brand-new, or lapsed and renewing) gets a fresh
 * headsock included with that license, so the $3 "replacement" is never
 * offered to them (owner 2026-08-10). Active licence holders and race-pack
 * prepaid racers qualify.
 */
export function addonEligibleMembers(addon: BookingAddon, party: PartyMember[]): PartyMember[] {
  if (addon.eligibility === "has-license") return party.filter((m) => !racerNeedsLicense(m));
  return party;
}

/** The add-ons a surface can offer THIS party right now — offerableAddons
 *  narrowed to entries with at least one eligible racer. Drives the extras
 *  step's visibility and the cart teaser (an all-new-racer party must not see
 *  a headsock card it can't buy — web AND kiosk). */
export function offerableAddonsForParty(
  surface: "race",
  item: RaceItem,
  party: PartyMember[],
): BookingAddon[] {
  return offerableAddons(surface, item).filter((a) => addonEligibleMembers(a, party).length > 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One resolved unit: which addon, for whom (per-racer) or how many (qty). */
export interface ResolvedAddonSelection {
  addon: BookingAddon;
  /** Deduped across race items; order = party order for stable line output. */
  memberIds: string[];
}

/**
 * Walk the session's race items and resolve every valid addon selection
 * against the catalog. Invalid slugs and members no longer in the party drop
 * silently (server-authoritative rederivation — the pointer is not money).
 * memberIds dedupe ACROSS race items so a multi-race-item session can never
 * double-charge one racer for the same addon.
 */
export function resolveAddonSelections(session: BookingSession): ResolvedAddonSelection[] {
  if (!bookingAddonsEnabled()) return [];
  const bySlug = new Map<string, Set<string>>();
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    // Legacy BMI-priced items never run buildRaceChargeLines — their
    // selections must not resolve either (offer side blocks them too).
    if (offerableAddons("race", item).length === 0) continue;
    for (const sel of item.addonSelections ?? []) {
      const addon = getBookingAddon(sel.slug);
      if (!addon) continue;
      // Same eligibility filter the offer UI applies — a pointer for an
      // ineligible racer (stale session, doctored client) never charges.
      const eligibleIds = new Set(addonEligibleMembers(addon, session.party).map((m) => m.id));
      let set = bySlug.get(sel.slug);
      if (!set) {
        set = new Set<string>();
        bySlug.set(sel.slug, set);
      }
      for (const id of sel.memberIds) if (eligibleIds.has(id)) set.add(id);
    }
  }
  const out: ResolvedAddonSelection[] = [];
  for (const [slug, ids] of bySlug) {
    const addon = getBookingAddon(slug)!;
    if (ids.size === 0) continue;
    // Party order, not insertion order — stable across re-renders/retries
    // (Square idempotency rejects a changed order body).
    const ordered = session.party.map((m) => m.id).filter((id) => ids.has(id));
    out.push({ addon, memberIds: ordered });
  }
  return out;
}

/** Charge lines for every resolved add-on selection in the session. */
export function addonChargeLines(session: BookingSession): BillLine[] {
  const lines: BillLine[] = [];
  for (const { addon, memberIds } of resolveAddonSelections(session)) {
    if (addon.attribution === "per-racer") {
      for (const memberId of memberIds) {
        const racer = session.party.find((m) => m.id === memberId);
        // Full-name suffix — same convention as the race-pack line
        // ("Race Pack — {label} · {memberName}", race-pack-kiosk.ts).
        const label = racer ? `${racer.firstName} ${racer.lastName ?? ""}`.trim() : "";
        lines.push({
          name: label ? `${addon.name} · ${label}` : addon.name,
          quantity: 1,
          amount: round2(addon.priceCents / 100),
          bmiProductId: addon.chargeLineKey,
        });
      }
    }
    // "qty" attribution has no v1 entry; when merch adds one, emit a single
    // line with quantity = capped count here.
  }
  return lines;
}

/**
 * Grant-obligation intents for the reserve rail — one per (addon, racer),
 * from the SAME resolution walk as the charge lines, so the ledger can never
 * hold an obligation the guest wasn't charged for (or vice versa).
 * personId = the racer's raw BMI id when they have one (race-pack parity —
 * NEVER Number() it); null parks the row as awaiting-person at grant time.
 */
export function addonPurchaseIntents(session: BookingSession): AddonPurchaseIntent[] {
  return resolveAddonSelections(session).flatMap(({ addon, memberIds }) =>
    memberIds.map((memberId) => {
      const m = session.party.find((p) => p.id === memberId);
      return {
        memberId,
        addonSlug: addon.slug,
        personId: m?.bmiPersonId ?? null,
        memberName: m ? `${m.firstName} ${m.lastName ?? ""}`.trim() : null,
        depositKindId: addon.grant?.depositKindId ?? null,
        grantAmount: addon.grant?.amountPerUnit ?? 0,
        priceCents: addon.priceCents,
      };
    }),
  );
}

/**
 * Cart-estimate mirror for ONE race item (CartView's estimateCartItemTotal is
 * per-item). Same walk, restricted to the item, deduped against nothing —
 * add-ons are offered only on the first race item so per-item == session.
 */
export function estimateAddonsTotal(item: RaceItem, session: BookingSession): number {
  if (!bookingAddonsEnabled()) return 0;
  if (offerableAddons("race", item).length === 0) return 0;
  let total = 0;
  for (const sel of item.addonSelections ?? []) {
    const addon = getBookingAddon(sel.slug);
    if (!addon) continue;
    const eligibleIds = new Set(addonEligibleMembers(addon, session.party).map((m) => m.id));
    const count = new Set(sel.memberIds.filter((id) => eligibleIds.has(id))).size;
    total += (addon.priceCents / 100) * count;
  }
  return round2(total);
}
