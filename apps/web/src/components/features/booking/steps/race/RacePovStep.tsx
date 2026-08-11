"use client";

import { useEffect, useState } from "react";
import { POV_CHECKIN_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { modalBackdropProps } from "@/lib/a11y";
import type { RaceItem, StepDef } from "~/features/booking";
import { raceItemFullyPackaged } from "~/features/booking";
import { povUncoveredRacerCount, povUncoveredRacers } from "~/features/booking/service/race";
import { offerableAddons } from "~/features/booking/data/addon-catalog";
import { useT } from "~/features/kiosk/i18n";
import { AddonCard, NameChipPicker } from "./AddonCard";

/**
 * Race step — "Race Video & Extras" (owner 2026-08-10): the POV camera upsell
 * on top, plus one AddonCard per retail add-on from data/addon-catalog.ts
 * (v1: the $3 replacement headsock) below it. The POV CARD hides on its old
 * seams (fully packaged / no uncovered racers) while the STEP stays visible
 * as long as an add-on is offerable — so a fully-packaged party still gets
 * the extras.
 *
 * The video card picks PEOPLE, not a number (owner 2026-08-10 round 3: "add
 * people to video regardless if we don't apply per person, I'd like these to
 * look similar to each other") — the same NameChipPicker the headsock card
 * uses. WHO is UI attribution only (`povMemberIds`); the MONEY stays
 * `povQuantity` (BMI sells qty) and is kept = the selection's length, so the
 * charge line, cart estimate, and POV-code claiming are untouched. Chips list
 * only package-UNCOVERED racers (povUncoveredRacers — a racer whose bundle
 * includes the video is never offered a second one), which also makes the
 * one-per-racer cap structural. At zero selected, a "No thanks" ghost
 * advances explicitly (staff 2026-07-21: the kiosk footer reads "Add to my
 * visit" on this last step, which guests misread as adding the camera).
 * Combos set povQuantity programmatically (no member ids) and never render
 * this step — hiddenInCombo.
 *
 * TWO LAYOUTS, one component (RacePayModeStep's kiosk/web pattern): the kiosk
 * is a fixed canvas and this step must fit WITHOUT scrolling (owner
 * 2026-08-10, screenshot: the hero video pushed the headsock card below the
 * fold) — so kiosk gets a compact media-row card shaped like the AddonCard
 * while web keeps the full-bleed hero.
 *
 * Interaction is OPTIONAL by design (owner picked mockup variant A): every
 * control is always live and Continue always advances. The rejected variant
 * B ("answer each card") would gate in THIS step's canAdvance — a selection
 * of `memberIds: []` vs `undefined` distinguishes declined from unanswered.
 *
 * State written to RaceItem:
 *   - `povQuantity: number` — number of POV cameras (the money field)
 *   - `povMemberIds?: string[]` — who they're for (display only)
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
  // Kiosk thumbnail → full-size video overlay (owner 2026-08-10: "option to
  // view bigger video like expand that pops up and can be closed").
  const [videoOpen, setVideoOpen] = useState(false);
  const eligible = povUncoveredRacers(item, session.party);
  const showPov = !raceItemFullyPackaged(item, session.party) && eligible.length > 0;
  const coveredCount = session.party.length - eligible.length;
  const addons = offerableAddons("race", item);

  const eligibleIds = new Set(eligible.map((m) => m.id));
  const selected = new Set((item.povMemberIds ?? []).filter((id) => eligibleIds.has(id)));
  const qty = item.povQuantity;

  const togglePov = (memberId: string) => {
    const next = new Set(selected);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    // Party order for a stable list; qty (the money) tracks the selection.
    const povMemberIds = eligible.map((m) => m.id).filter((id) => next.has(id));
    onChange({ povMemberIds, povQuantity: povMemberIds.length });
  };

  // Back-fill/normalize once on mount: a session persisted before povMemberIds
  // existed (or whose party/packages changed) can hold a qty with no/stale
  // attribution — assign the first N uncovered racers so the chips, the qty,
  // and the charge agree. Settles in one pass (after it, qty === selection
  // length), so onChange in the deps can't loop.
  useEffect(() => {
    if (!showPov) return;
    if (qty === selected.size) return;
    const povMemberIds = eligible.slice(0, Math.min(qty, eligible.length)).map((m) => m.id);
    onChange({ povMemberIds, povQuantity: povMemberIds.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPov, qty, selected.size]);

  // Shared picker block — identical on both layouts (and shaped exactly like
  // the AddonCard body) so the two cards read as one system.
  const picker = (
    <div className="space-y-2">
      <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
        {t("pov.pickerLabel")}
      </p>
      <NameChipPicker members={eligible} selected={selected} onToggle={togglePov} />
      {selected.size > 0 ? (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-white/30">{t("pov.perRacerHint")}</span>
          <span className="text-lg font-bold text-[#00E2E5]">
            ${(POV_PRICE * selected.size).toFixed(2)}
          </span>
        </div>
      ) : (
        <p className="text-xs text-white/30">{t("pov.perRacerHint")}</p>
      )}
      {/* Explicit decline — advances without adding, so the guest never has
          to work out that the footer button won't add the camera. */}
      {selected.size === 0 && requestAdvance && (
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
          /* KIOSK: compact card mirroring the AddonCard shape — title + price
             header, save line, media row, chip picker. Everything (POV +
             extras) must fit the fixed canvas with no scroll. */
          <div
            className={`space-y-3 rounded-xl border p-4 transition-colors ${
              selected.size > 0
                ? "border-[#00E2E5]/30 bg-[#00E2E5]/5"
                : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-bold text-white">{t("pov.productName")}</h3>
                <span className="text-lg font-bold whitespace-nowrap text-[#00E2E5]">
                  {t("pov.priceEach", { price: `$${POV_PRICE.toFixed(2)}` })}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-white/50">
                {t("pov.save", { amount: `$${(POV_CHECKIN_PRICE - POV_PRICE).toFixed(2)}` })}{" "}
                <span className="text-red-400/60 line-through">
                  {t("pov.atCheckin", { price: `$${POV_CHECKIN_PRICE}` })}
                </span>
              </p>
            </div>
            <div className="flex gap-4">
              {/* Tappable thumbnail → full-size overlay below. */}
              <button
                type="button"
                onClick={() => setVideoOpen(true)}
                aria-label={t("pov.expandVideo")}
                className="relative w-40 shrink-0 self-start overflow-hidden rounded-lg border border-white/10 transition-colors hover:border-[#00E2E5]/40"
              >
                <video
                  src={POV_VIDEO}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="aspect-video w-full object-cover"
                />
                <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white/80">
                  ⤢ {t("pov.expandVideo")}
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-relaxed text-white/50">{t("pov.description")}</p>
                {coveredCount > 0 && (
                  <p className="mt-1 text-xs text-emerald-400/80">
                    {t("pov.coveredNote", { count: coveredCount })}
                  </p>
                )}
              </div>
            </div>
            {picker}
            {videoOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
                {...modalBackdropProps(() => setVideoOpen(false))}
              >
                <div className="w-full max-w-3xl space-y-4">
                  <video
                    src={POV_VIDEO}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="aspect-video w-full rounded-2xl border border-white/15 object-cover shadow-2xl shadow-[#00E2E5]/10"
                  />
                  <button
                    type="button"
                    onClick={() => setVideoOpen(false)}
                    className="mx-auto flex items-center gap-2 rounded-xl border border-white/25 px-8 py-3 text-sm font-bold text-white/80 transition-colors hover:border-white/50 hover:text-white"
                  >
                    <span aria-hidden>✕</span>
                    {t("pov.closeVideo")}
                  </button>
                </div>
              </div>
            )}
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

            {/* Who's it for */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">{picker}</div>
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
