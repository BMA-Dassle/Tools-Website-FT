"use client";

import { useEffect } from "react";
import { POV_CHECKIN_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import type { RaceItem, StepDef } from "~/features/booking";
import { raceItemFullyPackaged } from "~/features/booking";
import { povUncoveredRacerCount } from "~/features/booking/service/race";
import { offerableAddons } from "~/features/booking/data/addon-catalog";
import { useT } from "~/features/kiosk/i18n";
import { AddonCard } from "./AddonCard";

/**
 * Race step — "Race Video & Extras" (owner 2026-08-10): the POV camera upsell
 * on top, plus one AddonCard per retail add-on from data/addon-catalog.ts
 * (v1: the $3 replacement headsock) below it. The POV CARD hides on its old
 * seams (fully packaged / no uncovered racers) while the STEP stays visible
 * as long as an add-on is offerable — so a fully-packaged party still gets
 * the extras.
 *
 * POV controls are a CAPPED STEPPER, always visible (owner 2026-08-10, second
 * round: "didn't do the qty here" — the one-tap "Add for all N" is gone).
 * 0..uncovered-racer-count; + disables at the cap with a "Max N — one per
 * racer" hint; a stale persisted qty above the cap normalizes on mount. At
 * qty=0 a "No thanks" ghost advances explicitly (staff 2026-07-21: the kiosk
 * footer reads "Add to my visit" on this last step, which guests misread as
 * adding the camera). Combos (which legitimately set povQuantity above party
 * size) never render this step — hiddenInCombo.
 *
 * TWO LAYOUTS, one component (RacePayModeStep's kiosk/web pattern): the kiosk
 * is a fixed canvas and this step must fit WITHOUT scrolling (owner
 * 2026-08-10, screenshot: the hero video pushed the headsock card below the
 * fold) — so kiosk gets a compact media-row card (thumbnail beside the pitch)
 * while web keeps the full-bleed hero.
 *
 * Interaction is OPTIONAL by design (owner picked mockup variant A): every
 * control is always live and Continue always advances. The rejected variant
 * B ("answer each card") would gate in THIS step's canAdvance — a selection
 * of `memberIds: []` vs `undefined` distinguishes declined from unanswered.
 *
 * State written to RaceItem:
 *   - `povQuantity: number` — number of POV cameras (BMI sells qty, not per-racer)
 *   - `addonSelections` — add-on pointers, written by AddonCard
 *
 * BMI product id `43746981` — checkout sells a single line with
 * quantity = povQuantity (suppressed when the party is fully packaged; same
 * raceItemFullyPackaged seam as the POV card's visibility). Add-on money is
 * built by service/addon-charge.ts inside the same buildRaceChargeLines.
 */

// POV video preview URL — verbatim from v1 PovUpsell:6.
const POV_VIDEO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/viewpoint-pov-suJzzax08ZbSJpcdNKQvT9nNvWlgFc.mp4";
// Prices imported, never re-declared: local copies of these drifted from the
// charge (this file held POV at $5 after the constant moved to $4.99).

const RacePovStepComponent: StepDef<RaceItem>["Component"] = ({
  item,
  session,
  onChange,
  requestAdvance,
}) => {
  const t = useT();
  const kiosk = !!session.context?.kiosk;
  const uncovered = povUncoveredRacerCount(item, session.party);
  const showPov = !raceItemFullyPackaged(item, session.party) && uncovered > 0;
  const offerCount = Math.max(1, uncovered);
  const coveredCount = session.party.length - uncovered;
  const addons = offerableAddons("race", item);

  const setQty = (next: number) => {
    onChange({ povQuantity: Math.min(offerCount, Math.max(0, next)) });
  };

  const qty = item.povQuantity;
  const atMax = qty >= offerCount;

  // A session persisted before the cap (or whose party shrank) can hold a qty
  // above today's max — normalize once so display, stepper, and charge agree.
  useEffect(() => {
    // Settles in one pass: after the clamp, qty <= offerCount and the effect
    // no-ops, so onChange in the deps can't loop.
    if (showPov && qty > offerCount) onChange({ povQuantity: offerCount });
  }, [showPov, qty, offerCount, onChange]);

  // Shared capped stepper — identical controls on both layouts so the kiosk
  // and web can't drift on the qty behavior.
  const stepper = (
    <div className={kiosk ? "space-y-2" : "space-y-3"}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQty(qty - 1)}
            disabled={qty === 0}
            aria-label={t("pov.decrementAria")}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/20 disabled:hover:text-white/50"
          >
            -
          </button>
          <span className="w-6 text-center text-base font-bold text-white">{qty}</span>
          <button
            type="button"
            onClick={() => setQty(qty + 1)}
            disabled={atMax}
            aria-label={t("pov.incrementAria")}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#00E2E5]/40 bg-[#00E2E5]/10 text-lg text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/20 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-[#00E2E5]/10"
          >
            +
          </button>
          <span className="text-xs text-white/30">{t("pov.cameraCount", { count: qty })}</span>
        </div>
        {qty > 0 && (
          <span className="text-lg font-bold text-[#00E2E5]">${(POV_PRICE * qty).toFixed(2)}</span>
        )}
      </div>
      {atMax && <p className="text-xs text-white/30">{t("pov.maxHint", { count: offerCount })}</p>}
      {/* Explicit decline — advances without adding, so the guest never has
          to work out that the footer button won't add the camera. */}
      {qty === 0 && requestAdvance && (
        <button
          type="button"
          onClick={requestAdvance}
          className="w-full rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-white/50 transition-colors hover:border-white/30 hover:text-white/80"
        >
          {t("pov.noThanks")}
        </button>
      )}
    </div>
  );

  return (
    <div className={`mx-auto max-w-xl ${kiosk ? "space-y-4" : "space-y-8"}`}>
      {showPov &&
        (kiosk ? (
          /* KIOSK: compact media-row card — thumbnail beside the pitch, the
             stepper below. Everything (POV + extras) must fit the fixed
             canvas with no scroll. */
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex gap-4">
              <video
                src={POV_VIDEO}
                autoPlay
                loop
                muted
                playsInline
                className="aspect-video w-44 shrink-0 self-start rounded-lg border border-white/10 object-cover"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-base font-bold text-white">{t("pov.productName")}</h3>
                <p className="text-xs text-[#00E2E5]/80">
                  {t("pov.save", { amount: `$${(POV_CHECKIN_PRICE - POV_PRICE).toFixed(2)}` })}
                </p>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xl font-bold text-[#00E2E5]">${POV_PRICE.toFixed(2)}</span>
                  <span className="text-xs text-white/30">{t("pov.perPerson")}</span>
                  <span className="text-xs text-red-400/60 line-through">
                    {t("pov.atCheckin", { price: `$${POV_CHECKIN_PRICE}` })}
                  </span>
                </div>
                {coveredCount > 0 && (
                  <p className="text-xs text-emerald-400/80">
                    {t("pov.coveredNote", { count: coveredCount })}
                  </p>
                )}
              </div>
            </div>
            {stepper}
          </div>
        ) : (
          /* WEB: full-bleed hero — the page scrolls freely. */
          <>
            {/* Header */}
            <div className="space-y-2 text-center">
              <p className="text-xs font-bold tracking-widest text-[#00E2E5] uppercase">
                {t("pov.eyebrow")}
              </p>
              <h2 className="font-display text-3xl tracking-widest text-white uppercase">
                {t("pov.title")}
              </h2>
              <p className="text-sm text-white/40">
                {t("pov.save", { amount: `$${(POV_CHECKIN_PRICE - POV_PRICE).toFixed(2)}` })}
              </p>
            </div>

            {/* Video */}
            <div className="overflow-hidden rounded-2xl border border-white/10 shadow-2xl shadow-[#00E2E5]/10">
              <video
                src={POV_VIDEO}
                autoPlay
                loop
                muted
                playsInline
                className="aspect-video w-full object-cover"
              />
            </div>

            {/* Description */}
            <div className="space-y-3 text-center">
              <h3 className="text-lg font-bold text-white">{t("pov.productName")}</h3>
              <p className="mx-auto max-w-md text-sm leading-relaxed text-white/50">
                {t("pov.description")}
              </p>
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl font-bold text-[#00E2E5]">${POV_PRICE.toFixed(2)}</span>
                <span className="text-sm text-white/30">{t("pov.perPerson")}</span>
                <span className="text-white/20">|</span>
                <span className="text-sm text-red-400/60 line-through">
                  {t("pov.atCheckin", { price: `$${POV_CHECKIN_PRICE}` })}
                </span>
              </div>
              {coveredCount > 0 && (
                <p className="text-xs text-emerald-400/80">
                  {t("pov.coveredNote", { count: coveredCount })}
                </p>
              )}
            </div>

            {/* Qty stepper */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">{stepper}</div>
          </>
        ))}

      {/* Retail add-ons (v1: replacement headsock). Optional — no gate. */}
      {addons.length > 0 && session.party.length > 0 && (
        <div className={kiosk ? "space-y-2" : "space-y-4"}>
          {showPov ? (
            <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
              {t("addons.sectionTitle")}
            </p>
          ) : (
            <div className="space-y-2 text-center">
              <h2 className="font-display text-3xl tracking-widest text-white uppercase">
                {t("addons.sectionTitle")}
              </h2>
            </div>
          )}
          {addons.map((addon) => (
            <AddonCard
              key={addon.slug}
              addon={addon}
              item={item}
              session={session}
              onChange={onChange}
              compact={kiosk}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const RacePovStep: StepDef<RaceItem> = {
  id: "race-pov",
  title: "Race Video & Extras",
  Component: RacePovStepComponent,
  isVisible: (item, session) => {
    if (session.party.length === 0) return false;
    // POV's old whole-step rule is now the POV CARD's rule; the step itself
    // shows when EITHER the camera or any catalog add-on can be offered.
    // raceItemFullyPackaged is ALSO the charge-suppression seam: checkout
    // ignores povQuantity on a fully-packaged item, so the card never sells
    // a camera that wouldn't charge — while the headsock (never
    // package-covered today) keeps the step alive for packaged parties.
    const povVisible =
      !raceItemFullyPackaged(item, session.party) &&
      povUncoveredRacerCount(item, session.party) > 0;
    return povVisible || offerableAddons("race", item).length > 0;
  },
  canAdvance: () => true,
};
