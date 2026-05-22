"use client";

import { useMemo, useState } from "react";
import type { PartyMember, RaceItem, StepDef } from "~/features/booking";

/**
 * Race step — POV camera upsell + Rookie Pack chooser.
 *
 * v1 parity: full port of `apps/web/app/book/race/components/PovUpsell.tsx`.
 *
 * Two flows in one step:
 *
 * 1. **Rookie Pack flow** — when ALL of:
 *    - feature flag `NEXT_PUBLIC_ROOKIE_PACK_ENABLED === "1"`
 *    - session.party has at least one new racer
 *    The customer sees two radio cards: "Rookie Pack" (default, recommended)
 *    bundles license + POV + free Nemo's appetizer code; "License only"
 *    opts out of POV/appetizer. Pack picks POV for EVERY new racer.
 *
 * 2. **Per-racer POV picker** — existing-racer flow (no Rookie chooser).
 *    Each racer in the party gets a checkbox; "Add for all" + "Clear"
 *    helpers. $5/racer pre-pay vs $7 at check-in.
 *
 * State written to RaceItem:
 *   - `povRacerIds: string[]` — party member ids who get POV
 *   - `rookiePack: boolean | null` — true (pack), false (opted out of pack),
 *     null (not asked / no new racers)
 *
 * BMI product id `43746981` is the POV camera SKU (per v1 PovUpsell.tsx:297);
 * commit 10's checkout orchestrator sells one line per id in povRacerIds.
 */

// POV video preview — verbatim Vercel blob URL from v1 PovUpsell:6.
const POV_VIDEO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/viewpoint-pov-suJzzax08ZbSJpcdNKQvT9nNvWlgFc.mp4";
const LICENSE_PRICE = 4.99;
const POV_PRICE = 5;
const POV_CHECKIN_PRICE = 7;

function isRookiePackEnabled(): boolean {
  // Same env-var key + truthy check v1 uses (PovUpsell:21).
  return process.env.NEXT_PUBLIC_ROOKIE_PACK_ENABLED === "1";
}

function newRacersInParty(party: PartyMember[]): PartyMember[] {
  return party.filter((m) => m.isNewRacer);
}

const RacePovStepComponent: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  const allRacers = session.party;
  const racerCount = allRacers.length;
  const newRacers = useMemo(() => newRacersInParty(allRacers), [allRacers]);
  const showRookieFlow = isRookiePackEnabled() && newRacers.length > 0;

  // Local UI mirror — write-through to RaceItem so back-nav rehydrates.
  type RookieChoice = "pack" | "license-only";
  const initialRookieChoice: RookieChoice = item.rookiePack === false ? "license-only" : "pack";
  const [rookieChoice, setRookieChoice] = useState<RookieChoice>(initialRookieChoice);

  const handlePackChoice = (choice: RookieChoice) => {
    setRookieChoice(choice);
    if (choice === "pack") {
      // Every new racer gets POV; preserve any existing-racer POV picks too.
      const existingRacerWithPov = item.povRacerIds.filter(
        (id) => !newRacers.some((n) => n.id === id),
      );
      const newRacerIds = newRacers.map((r) => r.id);
      onChange({
        povRacerIds: [...new Set([...newRacerIds, ...existingRacerWithPov])],
        rookiePack: true,
      });
    } else {
      // Strip POV for new racers; keep any existing-racer POV picks.
      const keep = item.povRacerIds.filter((id) => !newRacers.some((n) => n.id === id));
      onChange({ povRacerIds: keep, rookiePack: false });
    }
  };

  const toggleRacerPov = (racerId: string) => {
    const has = item.povRacerIds.includes(racerId);
    const next = has
      ? item.povRacerIds.filter((id) => id !== racerId)
      : [...item.povRacerIds, racerId];
    onChange({ povRacerIds: next });
  };

  const addPovForAll = () => onChange({ povRacerIds: allRacers.map((r) => r.id) });
  const clearAllPov = () =>
    onChange({
      povRacerIds: showRookieFlow ? newRacers.map((r) => r.id) : [],
    });

  const totalPovCount = item.povRacerIds.length;
  const newRacerCount = newRacers.length;

  return (
    <div className="mx-auto max-w-xl space-y-8">
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

          {/* Rookie Pack option */}
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
                      <span className="text-white/40">
                        (required, ${LICENSE_PRICE.toFixed(2)} per racer)
                      </span>
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
                      <span className="text-white/40">(1 per group · dine-in · race day only)</span>
                    </span>
                  </li>
                </ul>
                <p className="mt-2 text-[11px] text-amber-400/80">
                  Save up to $20 vs paying separately
                </p>
              </div>
            </div>
          </button>

          {/* License-only option */}
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

      {!showRookieFlow && racerCount > 0 && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold tracking-wider text-white/60 uppercase">
              Pick who gets a POV
            </p>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={addPovForAll}
                className="rounded-lg border border-white/15 px-2.5 py-1 text-white/60 transition-colors hover:border-white/30 hover:text-white"
              >
                All {racerCount}
              </button>
              <button
                type="button"
                onClick={clearAllPov}
                className="rounded-lg border border-white/15 px-2.5 py-1 text-white/60 transition-colors hover:border-white/30 hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>
          <ul className="space-y-2">
            {allRacers.map((r) => {
              const has = item.povRacerIds.includes(r.id);
              return (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 transition-colors hover:bg-white/[0.05]">
                    <input
                      type="checkbox"
                      checked={has}
                      onChange={() => toggleRacerPov(r.id)}
                      className="h-4 w-4 rounded border-white/30 bg-white/5 accent-[#00E2E5]"
                    />
                    <span className="flex-1 text-sm text-white/80">
                      {r.firstName}
                      {r.lastName ? ` ${r.lastName}` : ""}
                    </span>
                    <span className="text-xs text-white/40">${POV_PRICE.toFixed(2)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-white/10 pt-3 text-sm">
            <span className="text-white/60">
              {totalPovCount} camera{totalPovCount === 1 ? "" : "s"} · ${POV_PRICE} each
            </span>
            <span className="font-bold text-[#00E2E5]">
              ${(POV_PRICE * totalPovCount).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {showRookieFlow && (
        <p className="text-center text-xs text-white/40">
          {rookieChoice === "pack"
            ? `Rookie Pack applied to ${newRacerCount} first-time racer${newRacerCount === 1 ? "" : "s"} · $${((LICENSE_PRICE + POV_PRICE) * newRacerCount).toFixed(2)} total`
            : `License only for ${newRacerCount} first-time racer${newRacerCount === 1 ? "" : "s"} · $${(LICENSE_PRICE * newRacerCount).toFixed(2)} total`}
        </p>
      )}
    </div>
  );
};

export const RacePovStep: StepDef<RaceItem> = {
  id: "race-pov",
  title: "POV & Pack",
  Component: RacePovStepComponent,
  isVisible: (_item, session) => session.party.length > 0,
  // POV is always optional — customer can skip with zero cameras. The
  // rookie chooser starts on "pack" by default so the state is never
  // stuck; canAdvance is unconditional.
  canAdvance: () => true,
};
