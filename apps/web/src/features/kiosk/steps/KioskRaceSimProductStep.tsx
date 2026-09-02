"use client";

/**
 * Kiosk Race Sims — "Choose Your Race": the karting KIOSK product page, on a
 * sim item (owner 2026-08-26: "I need it to match karting kiosk").
 *
 * What karting's kiosk actually renders (RaceProductStep with the kiosk's
 * booked-pack columns hidden — `hideBookedPacks`): the centered display
 * heading + muted helper, then per tier a section header (accent label ·
 * hairline · muted meta) over ONE SIMPLE FULL-CARD BUTTON — name and price on
 * the header row ("Starter Race … $20.99 / racer"), blurb, the track-dot
 * "Runs on …" line, and the group-math footer ("$20.99 × 3 racers = $62.97
 * total") because the party is already known. Selected = cyan border/fill +
 * the floating "Selected" pill. No Single|3-Pack columns (that is the WEB
 * layout), no locked options.
 *
 * Sims have one tier and one sellable (1 Race) — so exactly one card. Packs
 * are deferred (owner: ignore pack keys) and do not appear on this screen
 * at all, exactly as karting's kiosk page carries no booked-pack UI; when
 * sim packs get keys they join through a pay-mode-style step like racing's.
 *
 * Rendered THROUGH THE KIOSK ZOOM like karting (this id is deliberately NOT
 * in KioskFlow's NATIVE_STEP_IDS) and authored in karting's own web rem
 * classes and palette (Starter-tier cyan accent, TRACK_DOT hues), so the two
 * pages are pixel-identical on the canvas. Karting facts left out on
 * purpose: the new-racer licence breakdown + note (no sim licence), the
 * returning-racer "qualified for" helper (no sim tiers), pack/credit coverage
 * chips and the membership-discount banner (no sim packs, credits or
 * membership pricing), locked tier rungs (one tier).
 *
 * Writes ONLY item.productSlug + item.productKind.
 */
import type { StepDef, RaceSimItem } from "~/features/booking";
import {
  RACE_SIM_PRODUCTS,
  raceSimPriceFor,
  type RaceSimProduct,
} from "~/features/race-sims/products";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

/** Catalog slug → display-name key (data-borne copy localizes via the message
 *  catalog; the catalog's own `name` is the EN source of truth + fallback).
 *  Also read by the Time step's header line. */
export const PRODUCT_NAME_KEYS: Record<string, MessageKey> = {
  "sim-single": "racesim.product.sim-single",
};

/** Sims are a one-tier ladder, so they take karting's STARTER tier colors
 *  (TIER_ACCENT / TIER_HEADING starter = #00E2E5): the left accent, like a
 *  Starter card, stays cyan whether or not the card is selected. Karting's
 *  palette only — no sim-specific hue (owner: design identical). */
const ACCENT = "#00E2E5";
const ACCENT_TEXT = "#00E2E5";
/** House selection cyan — karting's selected card/pill. */
const SELECTED = "#00E2E5";
/** Karting's TrackLine dots (TRACK_DOT: Red / Blue / Mega) — sims run on
 *  three rotating tracks, so the line carries one dot per track, exactly as
 *  karting's combined Red+Blue card carries two. */
const TRACK_DOTS = ["#E53935", "#2196F3", "#A855F7"];

const KioskRaceSimProductStepComponent: StepDef<RaceSimItem>["Component"] = ({
  item,
  session,
  onChange,
}) => {
  const t = useT();
  // One flat rate every day (owner 2026-09-01), and the charge reads the same
  // helper, so displayed == charged without the step knowing today's date.
  const racers = session.party.length;
  const sellable = RACE_SIM_PRODUCTS.filter((p) => p.bookable);

  const card = (product: RaceSimProduct) => {
    const isSelected = item.productSlug === product.slug;
    const nameKey = PRODUCT_NAME_KEYS[product.slug];
    const name = nameKey ? t(nameKey) : product.name;
    const price = raceSimPriceFor(product);
    return (
      <button
        key={product.slug}
        type="button"
        onClick={() => onChange({ productSlug: product.slug, productKind: product.kind })}
        className={`relative w-full rounded-xl border p-4 text-left transition-all duration-200 ${
          isSelected
            ? "border-[#00E2E5] bg-[#00E2E5]/5"
            : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
        }`}
        style={{ borderLeftWidth: 3, borderLeftColor: isSelected ? SELECTED : ACCENT }}
      >
        {isSelected && (
          <span className="absolute -top-2.5 right-3.5 rounded-full bg-[#00E2E5] px-2.5 py-0.5 text-[10px] font-extrabold tracking-[0.12em] text-[#000418] uppercase">
            {t("racesim.product.selected")}
          </span>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[15px] font-bold text-white">{name}</span>
          <span className="text-[15px] font-extrabold whitespace-nowrap text-white tabular-nums">
            ${price.toFixed(2)}
            <span className="text-xs font-medium text-white/40">
              {" "}
              / {t("racesim.product.perRacer")}
            </span>
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-white/50">
          {t("racesim.product.single.sub")}
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-white/35">
          {TRACK_DOTS.map((dot) => (
            <span
              key={dot}
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: dot }}
            />
          ))}
          <span className="ml-0.5">{t("racesim.product.trackLine")}</span>
        </div>
        {racers > 1 && (
          <div className="mt-2 text-xs text-white/50">
            {t("racesim.product.groupTotal", {
              unit: `$${price.toFixed(2)}`,
              count: racers,
              total: `$${(price * racers).toFixed(2)}`,
            })}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h3 className="font-display text-2xl tracking-widest text-white uppercase">
          {t("racesim.product.heading")}
        </h3>
        <p className="mx-auto max-w-md text-sm text-white/40">{t("racesim.product.helper")}</p>
      </div>

      <div className="space-y-6">
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <span
              className="text-xs font-bold tracking-[0.16em] uppercase"
              style={{ color: ACCENT_TEXT }}
            >
              {t("racesim.tile.name")}
            </span>
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-xs whitespace-nowrap text-white/35">
              {t("racesim.product.sectionMeta")}
            </span>
          </div>
          <div className="grid gap-3">{sellable.map((p) => card(p))}</div>
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
  canAdvance: (item) => (item.productSlug ? true : { reason: "Pick a race to continue." }),
};
