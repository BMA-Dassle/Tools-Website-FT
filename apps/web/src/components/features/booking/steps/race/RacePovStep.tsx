"use client";

import { POV_CHECKIN_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import type { RaceItem, StepDef } from "~/features/booking";
import { raceItemFullyPackaged } from "~/features/booking";
import { povUncoveredRacerCount } from "~/features/booking/service/race";
import { useT } from "~/features/kiosk/i18n";

/**
 * Race step — the POV camera upsell, and ONLY that (owner 2026-08-10: the
 * in-step "Rookie Pack" license+POV pseudo-product is gone — the real Rookie
 * Pack is a registry package on the pay-mode page, and the license is
 * surfaced on the roster step and charged via racerNeedsLicense, so this
 * screen never mentions it).
 *
 * qty=0 state: "Add for all N racers — $X" primary button + a "No thanks"
 * ghost that advances without adding (staff 2026-07-21: the kiosk footer
 * reads "Add to my visit" on this last step, which guests misread as
 * adding the camera — an explicit decline removes the ambiguity).
 * qty>0 state: -/+ stepper + count + total + "Set to all" helper.
 *
 * N is the UNCOVERED racer count (povUncoveredRacerCount): a racer whose
 * category's package already includes the video is never offered a second
 * one, and the step hides entirely when every racer is covered.
 *
 * State written to RaceItem:
 *   - `povQuantity: number` — number of POV cameras (BMI sells qty, not per-racer)
 *
 * BMI product id `43746981` — checkout sells a single line with
 * quantity = povQuantity (suppressed when the party is fully packaged; same
 * raceItemFullyPackaged seam as this step's visibility).
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
  const uncovered = povUncoveredRacerCount(item, session.party);
  const offerCount = Math.max(1, uncovered);
  const coveredCount = session.party.length - uncovered;

  const setQty = (next: number) => {
    onChange({ povQuantity: Math.max(0, next) });
  };

  const qty = item.povQuantity;

  return (
    <div className="mx-auto max-w-xl space-y-8">
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

      {/* Add / Qty stepper */}
      <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        {qty === 0 ? (
          <>
            <button
              type="button"
              onClick={() => setQty(offerCount)}
              className="w-full rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/15 py-3.5 text-sm font-bold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/25"
            >
              {t("pov.addForAll", {
                count: offerCount,
                amount: `$${(POV_PRICE * offerCount).toFixed(2)}`,
              })}
            </button>
            {/* Explicit decline — advances without adding, so the guest never
                has to work out that the footer button won't add the camera. */}
            {requestAdvance && (
              <button
                type="button"
                onClick={requestAdvance}
                className="w-full rounded-xl border border-white/15 py-3 text-sm font-semibold text-white/50 transition-colors hover:border-white/30 hover:text-white/80"
              >
                {t("pov.noThanks")}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setQty(qty - 1)}
                  aria-label={t("pov.decrementAria")}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white"
                >
                  -
                </button>
                <span className="w-6 text-center text-sm font-bold text-white">{qty}</span>
                <button
                  type="button"
                  onClick={() => setQty(qty + 1)}
                  aria-label={t("pov.incrementAria")}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white"
                >
                  +
                </button>
                <span className="text-xs text-white/30">
                  {t("pov.cameraCount", { count: qty })}
                </span>
              </div>
              <span className="text-lg font-bold text-[#00E2E5]">
                ${(POV_PRICE * qty).toFixed(2)}
              </span>
            </div>
            {qty !== offerCount && (
              <button
                type="button"
                onClick={() => setQty(offerCount)}
                className="w-full rounded-lg py-2 text-xs font-semibold text-[#00E2E5]/70 transition-colors hover:text-[#00E2E5]"
              >
                {t("pov.setToAll", { count: offerCount })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export const RacePovStep: StepDef<RaceItem> = {
  id: "race-pov",
  title: "Race Video",
  Component: RacePovStepComponent,
  isVisible: (item, session) => {
    if (session.party.length === 0) return false;
    // Packages bundle the POV video — hide when EVERY category in the party is
    // packaged (raceItemFullyPackaged is ALSO the charge-suppression seam:
    // checkout ignores povQuantity on a fully-packaged item, so showing the
    // step there would sell a camera that never charges). The uncovered-count
    // clause states the same intent per racer and future-proofs a package
    // without includesPov.
    if (raceItemFullyPackaged(item, session.party)) return false;
    if (povUncoveredRacerCount(item, session.party) === 0) return false;
    return true;
  },
  canAdvance: () => true,
};
