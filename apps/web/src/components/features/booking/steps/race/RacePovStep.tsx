"use client";

import { useState } from "react";
import type { RaceItem, StepDef } from "~/features/booking";

/**
 * Race step — POV camera upsell + Rookie Pack chooser.
 *
 * v1 parity: strict port of `apps/web/app/book/race/components/PovUpsell.tsx`.
 *
 * Two flows in one step (same gating as v1):
 *
 * 1. **Rookie Pack flow** — when ALL of:
 *    - `NEXT_PUBLIC_ROOKIE_PACK_ENABLED === "1"`
 *    - session.party has at least one new racer
 *    Two radio cards: "Rookie Pack" (default, recommended) bundles license +
 *    POV + free Nemo's appetizer code; "License only" opts out of POV.
 *    Pack picks POV for every new racer in the party.
 *
 * 2. **Per-racer qty stepper** — existing-racer flow (no Rookie chooser).
 *    qty=0 state: "Add for all N racers — $X" primary button.
 *    qty>0 state: -/+ stepper + count + total + "Set to all" helper.
 *    Identical UI to v1 PovUpsell:235-283.
 *
 * State written to RaceItem:
 *   - `povQuantity: number` — number of POV cameras (BMI sells qty, not per-racer)
 *   - `rookiePack: boolean | null` — true (pack), false (opted out), null (n/a)
 *
 * BMI product id `43746981` (per v1 PovUpsell:297) — commit 10's checkout
 * sells a single line with quantity = povQuantity.
 */

// POV video preview URL — verbatim from v1 PovUpsell:6.
const POV_VIDEO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/viewpoint-pov-suJzzax08ZbSJpcdNKQvT9nNvWlgFc.mp4";
const LICENSE_PRICE = 4.99;
const POV_PRICE = 5;
const POV_CHECKIN_PRICE = 7;

function isRookiePackEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ROOKIE_PACK_ENABLED === "1";
}

const RacePovStepComponent: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  const racerCount = Math.max(1, session.party.length);
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  const showRookieFlow = isRookiePackEnabled() && newRacerCount > 0;

  type RookieChoice = "pack" | "license-only";
  const initialRookieChoice: RookieChoice = item.rookiePack === false ? "license-only" : "pack";
  const [rookieChoice, setRookieChoice] = useState<RookieChoice>(initialRookieChoice);

  const handlePackChoice = (choice: RookieChoice) => {
    setRookieChoice(choice);
    if (choice === "pack") {
      onChange({ povQuantity: newRacerCount, rookiePack: true });
    } else {
      onChange({ povQuantity: 0, rookiePack: false });
    }
  };

  const setQty = (next: number) => {
    onChange({ povQuantity: Math.max(0, next) });
  };

  const qty = item.povQuantity;

  return (
    <div className="mx-auto max-w-xl space-y-8">
      {/* Header — v1 PovUpsell:75-85 */}
      <div className="space-y-2 text-center">
        <p className="text-xs font-bold tracking-widest text-[#00E2E5] uppercase">
          Exclusive Online Add-On
        </p>
        <h2 className="font-display text-3xl tracking-widest text-white uppercase">
          Elevate Your
          <br />
          Racing Experience
        </h2>
        <p className="text-sm text-white/40">Save $2 per camera when you pre-pay online</p>
      </div>

      {/* Rookie Pack chooser — v1 PovUpsell:89-203 */}
      {showRookieFlow && (
        <div className="space-y-3">
          <div className="space-y-1 text-center">
            <p className="text-[11px] font-bold tracking-widest text-amber-400 uppercase">
              First-Time Racer
            </p>
            <h3 className="font-display text-xl tracking-widest text-white uppercase">
              Choose Your Welcome
            </h3>
            <p className="text-xs text-white/40">
              A racing license is required for all new racers (${LICENSE_PRICE.toFixed(2)}). Bundle
              and save.
            </p>
          </div>

          <button
            type="button"
            onClick={() => handlePackChoice("pack")}
            aria-pressed={rookieChoice === "pack"}
            aria-label="Select Rookie Pack — license, POV video, and free appetizer"
            className={`w-full rounded-xl border-2 p-5 text-left transition-colors ${
              rookieChoice === "pack"
                ? "border-[#00E2E5] bg-[#00E2E5]/10"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  rookieChoice === "pack" ? "border-[#00E2E5]" : "border-white/30"
                }`}
              >
                {rookieChoice === "pack" && (
                  <span className="h-2.5 w-2.5 rounded-full bg-[#00E2E5]" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-base font-bold text-white">Rookie Pack</span>
                  <span className="text-base font-bold whitespace-nowrap text-[#00E2E5]">
                    ${(LICENSE_PRICE + POV_PRICE).toFixed(2)}
                    <span className="ml-1 text-xs font-normal text-white/30">/racer</span>
                  </span>
                </div>
                <p className="mb-2 text-[10px] font-bold tracking-wider text-amber-400 uppercase">
                  Most Popular · Recommended
                </p>
                <ul className="space-y-1 text-sm text-white/70">
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>
                      Racing License{" "}
                      <span className="text-white/40">(required, ${LICENSE_PRICE} per racer)</span>
                    </span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>
                      POV Race Video{" "}
                      <span className="text-white/40">
                        (per racer · ${POV_CHECKIN_PRICE} at check-in)
                      </span>
                    </span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>
                      Free Appetizer at Nemo&apos;s{" "}
                      <span className="text-white/40">
                        (1 per 3 purchases · dine-in · race day only)
                      </span>
                    </span>
                  </li>
                </ul>
                <p className="mt-2 text-[11px] text-amber-400/80">
                  Save up to $20 vs paying separately
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => handlePackChoice("license-only")}
            aria-pressed={rookieChoice === "license-only"}
            aria-label="Select License only — skip POV and appetizer"
            className={`w-full rounded-xl border-2 p-4 text-left transition-colors ${
              rookieChoice === "license-only"
                ? "border-white/40 bg-white/[0.05]"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  rookieChoice === "license-only" ? "border-white/60" : "border-white/30"
                }`}
              >
                {rookieChoice === "license-only" && (
                  <span className="h-2.5 w-2.5 rounded-full bg-white/80" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-white/80">License only</span>
                  <span className="text-sm font-semibold whitespace-nowrap text-white/70">
                    ${LICENSE_PRICE.toFixed(2)}
                    <span className="ml-1 text-xs font-normal text-white/30">/racer</span>
                  </span>
                </div>
                <p className="text-xs text-white/40">
                  Required race license. Skip the video + appetizer.
                </p>
              </div>
            </div>
          </button>
        </div>
      )}

      {/* Video — v1 PovUpsell:206-215 */}
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

      {/* Description — v1 PovUpsell:218-231 */}
      <div className="space-y-3 text-center">
        <h3 className="text-lg font-bold text-white">ViewPoint POV Camera</h3>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-white/50">
          Relive every turn, overtake, and adrenaline-fueled moment from your kart&apos;s
          perspective. Your footage is ready to download after your race — perfect for sharing on
          social media.
        </p>
        <div className="flex items-center justify-center gap-3">
          <span className="text-2xl font-bold text-[#00E2E5]">${POV_PRICE}</span>
          <span className="text-sm text-white/30">/person</span>
          <span className="text-white/20">|</span>
          <span className="text-sm text-red-400/60 line-through">
            ${POV_CHECKIN_PRICE} at check-in
          </span>
        </div>
      </div>

      {/* Add / Qty stepper — v1 PovUpsell:235-283 (hidden in Rookie flow) */}
      {!showRookieFlow && (
        <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-5">
          {qty === 0 ? (
            <button
              type="button"
              onClick={() => setQty(racerCount)}
              className="w-full rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/15 py-3.5 text-sm font-bold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/25"
            >
              Add for all {racerCount} racer{racerCount !== 1 ? "s" : ""} — $
              {(POV_PRICE * racerCount).toFixed(2)}
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setQty(qty - 1)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white"
                  >
                    -
                  </button>
                  <span className="w-6 text-center text-sm font-bold text-white">{qty}</span>
                  <button
                    type="button"
                    onClick={() => setQty(qty + 1)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white"
                  >
                    +
                  </button>
                  <span className="text-xs text-white/30">
                    {qty} camera{qty !== 1 ? "s" : ""}
                  </span>
                </div>
                <span className="text-lg font-bold text-[#00E2E5]">
                  ${(POV_PRICE * qty).toFixed(2)}
                </span>
              </div>
              {qty !== racerCount && (
                <button
                  type="button"
                  onClick={() => setQty(racerCount)}
                  className="w-full rounded-lg py-2 text-xs font-semibold text-[#00E2E5]/70 transition-colors hover:text-[#00E2E5]"
                >
                  Set to all {racerCount} racers
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const RacePovStep: StepDef<RaceItem> = {
  id: "race-pov",
  title: "POV & Pack",
  Component: RacePovStepComponent,
  isVisible: (item, session) => {
    if (session.party.length === 0) return false;
    // Packages bundle license + POV + appetizer — skip this step entirely
    if (item.packageId) return false;
    return true;
  },
  canAdvance: () => true,
};
