"use client";

/**
 * Kiosk Race Sims — "How many races?" (1 Race vs the Race Packs). PLACEHOLDER
 * PHASE 2026-08: everything renders straight from the in-code catalog
 * (features/race-sims/products.ts — placeholder prices, no Square/vendor ids;
 * checkout is fail-closed server-side until the ids are armed).
 *
 * LAYOUT MIRRORS THE KARTING PRODUCT PAGE (owner 2026-08-23: "mirror normal
 * karting with its layout") — RaceProductStep's Option-C tier card, scaled to
 * kiosk canvas px: centered intro header, a tier-rung section header (accent
 * label · hairline · muted meta), then ONE flat card (no photos, colored left
 * accent) whose price COLUMNS are the buttons — tiny uppercase label + amber
 * "Save $X" on packs, extrabold white price with the per-racer suffix, muted
 * per-race math underneath. Selection is the house cyan (#00E2E5) with the
 * floating "Selected" pill, exactly like karting; the racesim coral (#ff6b6b)
 * stays the UNSELECTED left-accent color, like a tier accent.
 *
 * Writes ONLY item.productSlug + item.productKind — the track and people
 * steps own the rest of the item.
 */
import type { StepDef, RaceSimItem } from "~/features/booking";
import {
  RACE_SIM_PRODUCTS,
  raceSimPriceFor,
  type RaceSimProduct,
} from "~/features/race-sims/products";
import { todayYmd } from "../service/first-available";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

/** Catalog slug → display-name key (data-borne copy localizes via the message
 *  catalog; the catalog's own `name` is the EN source of truth + fallback). */
const PRODUCT_NAME_KEYS: Record<string, MessageKey> = {
  "sim-single": "racesim.product.sim-single",
  "sim-3-pack": "racesim.product.sim-3-pack",
  "sim-5-pack": "racesim.product.sim-5-pack",
};

/** Racesim's tier-accent color (the karting ladder uses one per tier). */
const ACCENT = "#ff6b6b";
/** House selection cyan — same as karting's selected cards/columns. */
const SELECTED = "#00E2E5";

const KioskRaceSimProductStepComponent: StepDef<RaceSimItem>["Component"] = ({
  item,
  onChange,
}) => {
  const t = useT();
  const single = RACE_SIM_PRODUCTS.find((p) => p.kind === "single");
  const isSelected = item.productSlug != null;
  // Kiosk = walk-up: every price shown is TODAY's rate ($14 Mon–Thu / $16
  // Fri–Sun — raceSimPriceFor owns the split; the charge reads the same
  // helper off item.date, so displayed == charged).
  const today = todayYmd();

  // Mirror of RaceProductStep's column button factory (`col(on)`), at canvas
  // px. k-tap owns the transition (its unlayered rule out-cascades Tailwind's
  // transition utilities — see the KioskFlow k-glass note), and hover states
  // are dropped on the touch kiosk.
  const col = (on: boolean) =>
    `k-tap rounded-[16px] border p-[24px] text-left ${
      on ? "border-[#00E2E5]/70 bg-[#00E2E5]/5" : "border-white/10 bg-white/[0.03]"
    }`;

  const column = (product: RaceSimProduct) => {
    const on = item.productSlug === product.slug;
    const nameKey = PRODUCT_NAME_KEYS[product.slug];
    const name = nameKey ? t(nameKey) : product.name;
    const price = raceSimPriceFor(product, today);
    // Not-yet-sellable (pack keys unminted): karting's LockedTierRung
    // treatment scaled to a column — dimmed, no price quote ("quoting money
    // for something unbuyable invites a 'why can't I pick it' tap"), no tap.
    if (!product.bookable) {
      return (
        <div
          key={product.slug}
          aria-disabled
          className="rounded-[16px] border border-dashed border-white/15 bg-white/[0.02] p-[24px] text-left opacity-45"
        >
          <div className="text-[20px] font-extrabold uppercase tracking-[0.14em] text-white/40">
            {name}
          </div>
          <div className="mt-[8px] text-[24px] font-bold text-white/70">
            {t("racesim.tile.comingSoon")}
          </div>
          <div className="mt-[6px] text-[20px] leading-snug text-white/45">
            {t("racesim.product.pack.sub")}
          </div>
        </div>
      );
    }
    // Save chip = what N singles would cost minus the pack price, whole
    // dollars — same math as karting's `saveDollars`, at today's rate.
    const saveDollars = single
      ? Math.round(raceSimPriceFor(single, today) * product.raceCount - price)
      : 0;
    const perRace = price / Math.max(1, product.raceCount);
    return (
      <button
        key={product.slug}
        type="button"
        onClick={() => onChange({ productSlug: product.slug, productKind: product.kind })}
        className={col(on)}
      >
        <div className="text-[20px] font-extrabold uppercase tracking-[0.14em] text-white/40">
          {name}
          {product.kind === "pack" && saveDollars >= 1 && (
            <span className="ml-[10px] text-amber-400">
              {t("racesim.product.save", { amount: `$${saveDollars}` })}
            </span>
          )}
        </div>
        <div className="mt-[8px] text-[34px] font-extrabold tabular-nums text-white">
          ${price.toFixed(2)}{" "}
          <span className="text-[22px] font-medium text-white/40">
            / {t("racesim.product.perRacer")}
          </span>
        </div>
        <div className="mt-[6px] text-[20px] leading-snug text-white/50">
          {product.kind === "single"
            ? t("racesim.product.single.sub")
            : t("racesim.product.perRace", {
                price: `$${perRace.toFixed(2)}`,
                count: product.raceCount,
              })}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-[36px]">
      {/* Intro header — karting's centered display heading + muted helper. */}
      <div className="space-y-[10px] text-center">
        <h3 className="k-display text-[40px] text-white">{t("racesim.product.intro")}</h3>
        <p className="mx-auto max-w-[720px] text-[24px] text-white/45">
          {t("racesim.product.introHelp")}
        </p>
      </div>

      <div>
        {/* Tier-rung section header — accent label · hairline · muted meta. */}
        <div className="mb-[14px] flex items-center gap-[16px]">
          <span
            className="text-[22px] font-bold uppercase tracking-[0.16em]"
            style={{ color: ACCENT }}
          >
            {t("racesim.tile.name")}
          </span>
          <div className="h-px flex-1 bg-white/10" />
          <span className="whitespace-nowrap text-[22px] text-white/35">
            {t("racesim.product.sectionMeta")}
          </span>
        </div>

        {/* The tier card — flat, no photo, colored left accent; the price
            columns inside are the tap targets (karting Option C). */}
        <div
          className={`relative w-full rounded-[24px] border-2 p-[32px] transition-all duration-200 ${
            isSelected ? "border-[#00E2E5] bg-[#00E2E5]/5" : "border-white/10 bg-white/5"
          }`}
          style={{ borderLeftWidth: 6, borderLeftColor: isSelected ? SELECTED : ACCENT }}
        >
          {isSelected && (
            <span className="absolute -top-[16px] right-[28px] rounded-full bg-[#00E2E5] px-[18px] py-[6px] text-[17px] font-extrabold uppercase tracking-[0.12em] text-[#000418]">
              {t("racesim.product.selected")}
            </span>
          )}
          <div className="text-[30px] font-bold text-white">{t("racesim.tile.name")}</div>
          <p className="mt-[6px] text-[24px] leading-relaxed text-white/50">
            {t("racesim.tile.blurb")}
          </p>
          {/* Track line — karting's colored-dot "Runs on …" row. */}
          <div className="mt-[14px] flex items-center gap-[12px] text-[22px] text-white/35">
            <span
              className="inline-block h-[16px] w-[16px] shrink-0 rounded-full"
              style={{ backgroundColor: ACCENT }}
            />
            <span>{t("racesim.product.trackLine")}</span>
          </div>
          <div className="mt-[24px] grid grid-cols-3 gap-[16px]">
            {RACE_SIM_PRODUCTS.map((p) => column(p))}
          </div>
        </div>
      </div>
    </div>
  );
};

// TODO(i18n): `title` + the canAdvance `reason` are static StepDef metadata
// rendered by the flow shell — KioskFlow's STEP_TITLE_KEYS / STEP_REASON_KEYS
// maps localize them at the render site (same pattern as every kiosk step).
export const KioskRaceSimProductStep: StepDef<RaceSimItem> = {
  id: "racesim-product",
  title: "Race Options",
  Component: KioskRaceSimProductStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.productSlug ? true : { reason: "Pick 1 Race or a Race Pack." }),
};
