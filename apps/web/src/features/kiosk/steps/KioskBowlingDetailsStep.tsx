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

/** Canonical category value → sizes, mirroring the web confirmation editor so
 *  the saved label ("Male 9") matches what the players API + KDS expect. */
const SHOE_SIZES: Record<string, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
    "12.5",
    "13",
    "13.5",
    "14",
    "14.5",
    "15",
  ],
  Female: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
  ],
};

/** Family-friendly labels over the canonical stored values. */
const SHOE_CATEGORIES: Array<{ value: keyof typeof SHOE_SIZES; label: string }> = [
  { value: "Toddler", label: "Toddler" },
  { value: "Male", label: "Men's" },
  { value: "Female", label: "Women's" },
];

/** "Own shoes" sentinel — an explicit answer that isn't a rental size.
 *  Encoded as "" in players.shoeSize; the reserve mappings normalize "" → null
 *  so Neon/QAMF only ever see a real size or nothing. */
const OWN_SHOES = "";

/** Category part of a stored "Male 9" value ("" for own shoes / null / unknown). */
function categoryOf(shoeSize: string | null): string | null {
  if (shoeSize === null) return null;
  if (shoeSize === OWN_SHOES) return OWN_SHOES;
  const cat = shoeSize.split(" ")[0];
  return cat in SHOE_SIZES ? cat : null;
}

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
          {hasShoes
            ? "Names, shoes and bumpers — so your lane is ready the moment you are."
            : "Names and bumpers — so your lane is ready the moment you are."}
        </p>
        <span className="k-eyebrow shrink-0 text-[#00e2e5] tabular-nums">
          {readyCount} of {roster.length} ready
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
                <span className="k-display text-[34px]">Bowler {i + 1}</span>
                {complete && <span className="k-eyebrow text-[#46d68c]">Ready</span>}
              </div>

              <label
                htmlFor={`kiosk-bowler-name-${i}`}
                className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40"
              >
                Name
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
                placeholder={`Bowler ${i + 1}`}
                autoComplete="off"
                className="mb-[20px] w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />

              {hasShoes && (
                <span className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40">
                  Shoe size
                  {chargeShoes && shoeProduct && (
                    <span className="ml-[10px] normal-case tracking-normal text-[#46d68c]">
                      rental ${(shoeProduct.priceCents / 100).toFixed(2)}/pair · own shoes free
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
                          Own shoes
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
                            {cat.label}
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
                  Bumpers
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
                      {v ? "Yes" : "No"}
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
            {rentalCount} shoe rental{rentalCount === 1 ? "" : "s"} · $
            {(shoeProduct.priceCents / 100).toFixed(2)}/pair
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
