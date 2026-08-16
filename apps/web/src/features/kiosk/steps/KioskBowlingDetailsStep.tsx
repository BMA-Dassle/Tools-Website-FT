"use client";

/**
 * Kiosk bowler roster — REQUIRED on the kiosk (owner 2026-07-17): every
 * bowler's name, shoe size, and bumpers choice is collected in-flow, so the
 * lane is fully set up the moment the reservation lands (web collects these
 * post-booking, optionally). Writes BowlingCommon.players; the reserve paths
 * push real names/sizes/bumpers to QAMF and persist the roster to Neon.
 *
 * Shoe size is picked the SAME cascading way as the web confirmation editor
 * (BowlingPlayersEditor): choose a CATEGORY (Toddler / Men's / Women's) first,
 * then a size within it — never one giant undifferentiated list (owner 2026-07-19).
 * The stored value uses the canonical "Male 9" / "Female 8" / "Toddler 10"
 * vocabulary the players API + KDS parser expect (formatShoeSize maps
 * male/female/toddler). "Own shoes" records "" (normalized to null at reserve);
 * the CHOICE is required for everyone, a rental SIZE only for renters.
 */
import { useEffect, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type { BowlingSquareProduct } from "@/lib/bowling-db";
import { formatPersonName } from "~/lib/helpers/name-format";
import {
  centerHasShoeRental,
  FASTTRAX_QAMF_CENTER_ID,
  FASTTRAX_CENTER_CODE,
} from "@/lib/qamf-centers";
import { useT } from "../i18n";
import { SHOE_SIZES, SHOE_CATEGORIES, OWN_SHOES, categoryOf } from "../shoe-catalog";

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

/** Experiences where shoes are bundled in the price — never charge separately
 *  (mirrors BowlingShoesStep). Sizes are still collected for lane setup. */
const SHOES_INCLUDED_SLUGS = ["fun-4-all", "fun-4-all-vip", "pizza-bowl", "pizza-bowl-vip"];

type RosterPlayer = {
  name: string;
  shoeSize: string | null;
  bumpers: boolean | null;
  /** Party linkage from the people step (signed-in carry-over) — preserved
   *  through this step's rewrites so back-navigation keeps toggles honest. */
  memberId?: string;
};
type BowlItem = BowlingItem | KbfItem;

// SHOE_SIZES / SHOE_CATEGORIES / OWN_SHOES / categoryOf moved to
// ../shoe-catalog.ts — shared with the check-in flow's bowler-details screen
// so the kiosk never grows a second copy of the canonical "Male 9" vocabulary.

function playerCountOf(item: BowlItem): number {
  return item.kind === "bowling" ? item.playerCount : item.bowlers.length + item.paidAdults;
}

/**
 * Roster encoding: shoeSize null = UNANSWERED, "" = explicit "own shoes"
 * (normalized to null at the reserve mappings), "Mens 9" = rental size.
 * bumpers null = unanswered.
 */
function rosterOf(item: BowlItem): RosterPlayer[] {
  const count = playerCountOf(item);
  const existing = item.players ?? [];
  return Array.from({ length: count }, (_, i) => ({
    ...existing[i],
    name: existing[i]?.name ?? "",
    shoeSize: existing[i] ? existing[i].shoeSize : null,
    bumpers: existing[i] ? existing[i].bumpers : null,
  }));
}

function playerComplete(p: RosterPlayer, hasShoes: boolean): boolean {
  const shoeOk = !hasShoes || p.shoeSize !== null;
  return p.name.trim().length > 0 && shoeOk && p.bumpers !== null;
}

const KioskBowlingDetailsStepComponent: StepDef<BowlItem>["Component"] = ({ item, onChange }) => {
  const t = useT();
  const roster = rosterOf(item);
  // FastTrax duckpin (center 11542) has no shoes — collect name + bumpers only.
  const hasShoes = centerHasShoeRental(item.qamfCenterId);
  const shoesIncluded = SHOES_INCLUDED_SLUGS.includes((item as BowlingItem).experienceSlug ?? "");
  // Shoes are CHARGED (not just collected) when the center rents them and this
  // experience doesn't bundle them into the price.
  const chargeShoes = hasShoes && !shoesIncluded;
  const centerCode = QAMF_CENTER_CODES[item.qamfCenterId ?? 9172] ?? "TXBSQN0FEKQ11";
  // Which shoe category is expanded per bowler. Undefined → derive from the
  // stored size (so a saved "Male 9" reopens on Men's with 9 selected).
  const [openCat, setOpenCat] = useState<Record<number, string>>({});
  const [shoeProducts, setShoeProducts] = useState<BowlingSquareProduct[]>([]);
  const shoeProduct = shoeProducts[0] ?? null;

  // Fetch the rental-shoe product (id + price) so the shoe line items can be
  // DERIVED from the sizes people pick — no separate "how many pairs" step.
  useEffect(() => {
    if (!chargeShoes) {
      setShoeProducts([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${centerCode}&kind=addon_shoe`,
        );
        const data = await res.json();
        if (alive) setShoeProducts(Array.isArray(data) ? data : []);
      } catch {
        if (alive) setShoeProducts([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [centerCode, chargeShoes]);

  // One rental pair per bowler who picked a rental SIZE (own-shoes "" and
  // unanswered null don't count) — the count can never disagree with the sizes.
  const rentalCountFor = (r: RosterPlayer[]) =>
    r.filter((p) => p.shoeSize !== null && p.shoeSize !== OWN_SHOES).length;

  const shoePatchFor = (nextRoster: RosterPlayer[]): Partial<BowlItem> => {
    // Idempotent recompute: strip any prior shoe line items, then re-add.
    const nonShoe = item.lineItems.filter(
      (li) => !shoeProducts.some((p) => p.id === li.squareProductId),
    );
    const count = rentalCountFor(nextRoster);
    if (!shoeProduct || count === 0) {
      return {
        lineItems: nonShoe,
        shoeSelections: {},
        shoeProducts: undefined,
      } as Partial<BowlItem>;
    }
    return {
      shoeSelections: { [shoeProduct.id]: count },
      shoeProducts: [
        {
          id: shoeProduct.id,
          label: shoeProduct.label,
          priceCents: shoeProduct.priceCents,
          depositPct: shoeProduct.depositPct,
          squareCatalogObjectId: shoeProduct.squareCatalogObjectId,
        },
      ],
      lineItems: [
        ...nonShoe,
        {
          squareProductId: shoeProduct.id,
          quantity: count,
          label: shoeProduct.label,
          priceCents: shoeProduct.priceCents,
          depositPct: shoeProduct.depositPct,
          squareCatalogObjectId: shoeProduct.squareCatalogObjectId,
        },
      ],
    } as Partial<BowlItem>;
  };

  const update = (index: number, patch: Partial<RosterPlayer>) => {
    const next = roster.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange({ players: next, ...(chargeShoes ? shoePatchFor(next) : {}) } as Partial<BowlItem>);
  };

  // Once the shoe product loads, reconcile the line items to the current sizes
  // (0 pairs until someone picks a rental size; back-nav keeps prior picks).
  useEffect(() => {
    if (chargeShoes && shoeProducts.length > 0) onChange(shoePatchFor(roster));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shoeProducts.length]);

  const readyCount = roster.filter((p) => playerComplete(p, hasShoes)).length;
  const rentalCount = rentalCountFor(roster);
  const shoeTotalCents = shoeProduct ? rentalCount * shoeProduct.priceCents : 0;

  return (
    <div className="space-y-[24px]">
      <div className="flex items-center justify-between gap-[16px]">
        <p className="text-[26px] text-white/55">
          {t(hasShoes ? "bowlingDetails.intro.shoes" : "bowlingDetails.intro.noShoes")}
        </p>
        <span className="k-eyebrow shrink-0 text-[#00e2e5] tabular-nums">
          {t("bowlingDetails.readyCount", { ready: readyCount, total: roster.length })}
        </span>
      </div>

      <div className="space-y-[20px]">
        {roster.map((p, i) => {
          const complete = playerComplete(p, hasShoes);
          return (
            <div
              key={i}
              className="k-glass p-[28px]"
              style={{ borderLeft: `8px solid ${complete ? "#46d68c" : "rgba(255,255,255,0.15)"}` }}
            >
              <div className="mb-[16px] flex items-center justify-between">
                <span className="k-display text-[34px]">
                  {t("bowlingDetails.bowlerN", { num: i + 1 })}
                </span>
                {complete && (
                  <span className="k-eyebrow text-[#46d68c]">{t("bowlingDetails.ready")}</span>
                )}
              </div>

              <label
                htmlFor={`kiosk-bowler-name-${i}`}
                className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40"
              >
                {t("bowlingDetails.name")}
              </label>
              <input
                id={`kiosk-bowler-name-${i}`}
                type="text"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                // Case-normalize on blur, never per keystroke (an ALL-CAPS
                // stream reads as mixed case two chars in and gets preserved —
                // "SaRA"); the reserve payload formats once more as backstop.
                onBlur={(e) => update(i, { name: formatPersonName(e.target.value) })}
                placeholder={t("bowlingDetails.bowlerN", { num: i + 1 })}
                autoComplete="off"
                className="mb-[20px] w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />

              {hasShoes && (
                <span className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40">
                  {t("bowlingDetails.shoeSize")}
                  {chargeShoes && shoeProduct && (
                    <span className="ml-[10px] normal-case tracking-normal text-[#46d68c]">
                      {t("bowlingDetails.shoeRentalNote", {
                        price: `$${(shoeProduct.priceCents / 100).toFixed(2)}`,
                      })}
                    </span>
                  )}
                </span>
              )}
              {/* Category first (Own shoes / Toddler / Men's / Women's), then a
                  short size grid for that category — never one giant list.
                  Hidden entirely for FastTrax duckpin (no shoes). */}
              {hasShoes &&
                (() => {
                  const selCat = openCat[i] !== undefined ? openCat[i] : categoryOf(p.shoeSize);
                  return (
                    <>
                      <div className="mb-[12px] flex flex-wrap gap-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenCat((c) => ({ ...c, [i]: OWN_SHOES }));
                            update(i, { shoeSize: OWN_SHOES });
                          }}
                          className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold ${
                            p.shoeSize === OWN_SHOES
                              ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                              : "border-white/10 text-white/50"
                          }`}
                        >
                          {t("bowlingDetails.ownShoes")}
                        </button>
                        {SHOE_CATEGORIES.map((cat) => (
                          <button
                            key={cat.value}
                            type="button"
                            onClick={() => {
                              setOpenCat((c) => ({ ...c, [i]: cat.value }));
                              // Switching category clears a stale cross-category size.
                              if (categoryOf(p.shoeSize) !== cat.value)
                                update(i, { shoeSize: null });
                            }}
                            className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold ${
                              selCat === cat.value
                                ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                : "border-white/10 text-white/50"
                            }`}
                          >
                            {t(cat.labelKey)}
                          </button>
                        ))}
                      </div>
                      {selCat && selCat !== OWN_SHOES && SHOE_SIZES[selCat] && (
                        <div className="mb-[20px] flex flex-wrap gap-[10px]">
                          {SHOE_SIZES[selCat].map((size) => {
                            const value = `${selCat} ${size}`;
                            return (
                              <button
                                key={size}
                                type="button"
                                onClick={() => update(i, { shoeSize: value })}
                                className={`min-w-[74px] rounded-2xl border-2 px-[18px] py-[16px] text-center text-[24px] font-semibold tabular-nums ${
                                  p.shoeSize === value
                                    ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                    : "border-white/10 text-white/50"
                                }`}
                              >
                                {size}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}

              <div className="flex items-center gap-[20px]">
                <span className="text-[22px] font-semibold uppercase tracking-widest text-white/40">
                  {t("bowlingDetails.bumpers")}
                </span>
                <div className="inline-flex overflow-hidden rounded-2xl border-2 border-white/15">
                  {([true, false] as const).map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      onClick={() => update(i, { bumpers: v })}
                      className={`px-[36px] py-[14px] text-[26px] font-bold ${
                        p.bumpers === v ? "bg-[#00E2E5] text-[#04252b]" : "text-white/55"
                      }`}
                    >
                      {t(v ? "bowlingDetails.yes" : "bowlingDetails.no")}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Rental total DERIVED from the sizes picked — no separate count to get
          out of sync. Own-shoes bowlers add nothing. */}
      {chargeShoes && shoeProduct && rentalCount > 0 && (
        <div className="k-glass flex items-center justify-between px-[28px] py-[20px]">
          <span className="text-[24px] text-white/70">
            {t("bowlingDetails.rentalSummary", {
              count: rentalCount,
              price: `$${(shoeProduct.priceCents / 100).toFixed(2)}`,
            })}
          </span>
          <span className="k-display text-[32px] tabular-nums text-[#46d68c]">
            ${(shoeTotalCents / 100).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
};

export const KioskBowlingDetailsStep: StepDef<BowlItem> = {
  id: "kiosk-bowling-details",
  // TODO(i18n): `title` and the `canAdvance` reasons below run at module scope
  // (outside React) so they can't reach useT(). They stay English until step
  // titles + validation reasons are threaded through the active locale — a
  // cross-cutting change tracked in tasks/kiosk-i18n-spanish-plan.md.
  title: "Bowlers",
  Component: KioskBowlingDetailsStepComponent,
  isVisible: () => true,
  canAdvance: (item) => {
    const roster = rosterOf(item);
    if (roster.length === 0) return { reason: "Add at least one bowler first." };
    const hasShoes = centerHasShoeRental(item.qamfCenterId);
    const incomplete = roster.findIndex((p) => !playerComplete(p, hasShoes));
    if (incomplete >= 0) {
      return {
        reason: hasShoes
          ? `Bowler ${incomplete + 1} still needs a name, shoe choice, and bumpers answer.`
          : `Bowler ${incomplete + 1} still needs a name and bumpers answer.`,
      };
    }
    return true;
  },
};

export { OWN_SHOES };
