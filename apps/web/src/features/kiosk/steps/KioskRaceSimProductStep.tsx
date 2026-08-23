"use client";

/**
 * Kiosk Race Sims — "How many races?" (1 Race vs the Race Packs). PLACEHOLDER
 * PHASE 2026-08: cards render straight from the in-code catalog
 * (features/race-sims/products.ts — placeholder prices, no Square/vendor ids;
 * checkout is fail-closed server-side until the ids are armed). Structure
 * follows KioskBowlingTierStep's glass photo cards, minus its fetch: the
 * catalog is static, so there is nothing to load.
 *
 * Writes ONLY item.productSlug + item.productKind — the track and people
 * steps own the rest of the item.
 */
import type { StepDef, RaceSimItem } from "~/features/booking";
import { RACE_SIM_PRODUCTS, type RaceSimProduct } from "~/features/race-sims/products";
import { KIOSK_PHOTOS } from "../assets";
import { useResilientImages } from "../hooks/useResilientImage";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

/** Catalog slug → display-name key (data-borne copy localizes via the message
 *  catalog; the catalog's own `name` is the EN source of truth + fallback). */
const PRODUCT_NAME_KEYS: Record<string, MessageKey> = {
  "sim-single": "racesim.product.sim-single",
  "sim-3-pack": "racesim.product.sim-3-pack",
  "sim-5-pack": "racesim.product.sim-5-pack",
};

/** Card art per product — reuses existing racing photography until sims get
 *  their own shots (placeholder phase). */
const PRODUCT_PHOTOS: Record<string, string> = {
  "sim-single": KIOSK_PHOTOS.raceCar,
  "sim-3-pack": KIOSK_PHOTOS.race,
  "sim-5-pack": KIOSK_PHOTOS.raceAction,
};

const ACCENT = "#ff6b6b";

const KioskRaceSimProductStepComponent: StepDef<RaceSimItem>["Component"] = ({
  item,
  onChange,
}) => {
  const t = useT();
  const resolvePhoto = useResilientImages(Object.values(PRODUCT_PHOTOS));

  const card = (product: RaceSimProduct) => {
    const selected = item.productSlug === product.slug;
    const nameKey = PRODUCT_NAME_KEYS[product.slug];
    const name = nameKey ? t(nameKey) : product.name;
    const sub =
      product.kind === "single" ? t("racesim.product.single.sub") : t("racesim.product.pack.sub");
    return (
      <button
        key={product.slug}
        type="button"
        onClick={() => onChange({ productSlug: product.slug, productKind: product.kind })}
        aria-label={name}
        className="k-ph k-tap relative flex h-[400px] flex-col justify-end overflow-hidden rounded-[28px] border-2 text-left"
        style={
          {
            ["--k-img"]: `url(${resolvePhoto(PRODUCT_PHOTOS[product.slug] ?? KIOSK_PHOTOS.race)})`,
            borderColor: selected ? ACCENT : "rgba(255,255,255,0.12)",
            boxShadow: selected ? "0 0 44px rgba(255,107,107,0.25)" : "none",
          } as React.CSSProperties
        }
      >
        {selected && (
          <div
            className="absolute right-[24px] top-[24px] z-[2] grid h-[56px] w-[56px] place-items-center rounded-full text-[32px] font-bold text-[#2b0404]"
            style={{ background: ACCENT }}
          >
            ✓
          </div>
        )}
        <div className="relative z-[1] min-w-0 p-[32px]">
          <div className="k-display break-words text-[48px] leading-none">{name}</div>
          <div className="mt-[10px] break-words text-[26px] leading-snug text-white/65">{sub}</div>
          <div className="mt-[14px] text-[30px] font-extrabold tabular-nums">
            ${product.price.toFixed(2)}
            <span className="text-[22px] font-semibold text-white/55">
              {" "}
              {t("racesim.product.perRacer")}
            </span>
          </div>
        </div>
        <div className="relative z-[1] h-[8px] w-full shrink-0" style={{ background: ACCENT }} />
      </button>
    );
  };

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">{t("racesim.product.intro")}</p>
      <div className="grid grid-cols-2 gap-[24px]">{RACE_SIM_PRODUCTS.map((p) => card(p))}</div>
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
