"use client";

import { useState } from "react";

const POV_VIDEO = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/viewpoint-pov-suJzzax08ZbSJpcdNKQvT9nNvWlgFc.mp4";

/**
 * Rookie Pack — staged feature behind NEXT_PUBLIC_ROOKIE_PACK_ENABLED.
 * When enabled AND the racer is new (no existing license), shows a
 * radio at the top:
 *   ◉ Rookie Pack (default) — license + POV + free appetizer code
 *   ○ License only           — license only, no POV
 * The license is already auto-sold for new racers in app/book/race/page.tsx
 * regardless of this flag, so the bundle adds zero new BMI SKUs — it's
 * purely a UX framing + a flag on the booking record that drives the
 * appetizer-code display on the confirmation page.
 *
 * Flip the env var off to revert to the original POV-only upsell.
 */
const ROOKIE_PACK_ENABLED = process.env.NEXT_PUBLIC_ROOKIE_PACK_ENABLED === "1";
const LICENSE_PRICE = 4.99;

export interface PovSelection {
  id: string;
  quantity: number;
  price: number;
  billLineId?: string;
  /** True when the new-racer chose the Rookie Pack option. Drives
   *  the appetizer-code card on the booking confirmation page. */
  rookiePack?: boolean;
}

interface PovUpsellProps {
  racerCount: number;
  onContinue: (pov: PovSelection | null) => void;
  onBack: () => void;
  initial?: PovSelection | null;
  /** "new" first-time racers see the Rookie Pack chooser (when the
   *  feature flag is on). "existing" returning racers see the
   *  classic per-racer POV upsell unchanged. */
  racerType?: "new" | "existing" | null;
}

type RookieChoice = "pack" | "license-only";

export default function PovUpsell({ racerCount, onContinue, onBack, initial, racerType }: PovUpsellProps) {
  const showRookieFlow = ROOKIE_PACK_ENABLED && racerType === "new";
  // Default to "pack" so opt-out behavior gives us the higher conversion
  // path. Initial selection from a prior step honors whatever they
  // picked last time — including resurfacing "license-only" if quantity
  // was 0 on a new-racer flow.
  const [rookieChoice, setRookieChoice] = useState<RookieChoice>(() => {
    if (!showRookieFlow) return "pack";
    if (initial && initial.quantity > 0) return "pack";
    if (initial && initial.quantity === 0 && initial.rookiePack === false) return "license-only";
    return "pack";
  });
  const [qty, setQty] = useState(initial?.quantity ?? (showRookieFlow ? racerCount : 0));
  const price = 5;
  // Effective quantity to forward when continuing. In the rookie flow,
  // "pack" forces qty == racerCount (each new racer gets POV); "license-
  // only" forces 0 regardless of any stale state.
  const effectiveQty = showRookieFlow
    ? (rookieChoice === "pack" ? racerCount : 0)
    : qty;

  return (
    <div className="space-y-8 max-w-xl mx-auto">
      {/* Header */}
      <div className="text-center space-y-2">
        <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest">Exclusive Online Add-On</p>
        <h2 className="text-3xl font-display uppercase tracking-widest text-white">
          Elevate Your<br />Racing Experience
        </h2>
        <p className="text-white/40 text-sm">
          Save $2 per camera when you pre-pay online
        </p>
      </div>

      {/* Rookie Pack chooser — staged, first-timers only. Feature-flag
          gated; flip NEXT_PUBLIC_ROOKIE_PACK_ENABLED off to disable. */}
      {showRookieFlow && (
        <div className="space-y-3">
          <div className="text-center space-y-1">
            <p className="text-amber-400 text-[11px] font-bold uppercase tracking-widest">First-Time Racer</p>
            <h3 className="text-xl font-display uppercase tracking-widest text-white">
              Choose Your Welcome
            </h3>
            <p className="text-white/40 text-xs">
              A racing license is required for all new racers ($4.99). Bundle and save.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setRookieChoice("pack")}
            aria-label="Select Rookie Pack — license, POV video, and free appetizer"
            aria-pressed={rookieChoice === "pack"}
            className={`w-full text-left rounded-xl border-2 p-5 transition-colors ${
              rookieChoice === "pack"
                ? "border-[#00E2E5] bg-[#00E2E5]/10"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  rookieChoice === "pack" ? "border-[#00E2E5]" : "border-white/30"
                }`}
              >
                {rookieChoice === "pack" && <span className="w-2.5 h-2.5 rounded-full bg-[#00E2E5]" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="font-bold text-white text-base">
                    Rookie Pack
                  </span>
                  <span className="font-bold text-[#00E2E5] text-base whitespace-nowrap">
                    ${(LICENSE_PRICE + price).toFixed(2)}
                    <span className="text-white/30 text-xs font-normal ml-1">/racer</span>
                  </span>
                </div>
                <p className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-2">Most Popular · Recommended</p>
                <ul className="space-y-1 text-sm text-white/70">
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>Racing License <span className="text-white/40">(required, ${LICENSE_PRICE} per racer)</span></span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>POV Race Video <span className="text-white/40">(per racer · $7 at check-in)</span></span>
                  </li>
                  <li className="flex items-baseline gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>Free Appetizer at Nemo&apos;s <span className="text-white/40">(1 per group · dine-in, day-of)</span></span>
                  </li>
                </ul>
                <p className="text-[11px] text-amber-400/80 mt-2">
                  Save up to $20 vs paying separately
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setRookieChoice("license-only")}
            aria-label="Select License only — skip POV and appetizer"
            aria-pressed={rookieChoice === "license-only"}
            className={`w-full text-left rounded-xl border-2 p-4 transition-colors ${
              rookieChoice === "license-only"
                ? "border-white/40 bg-white/[0.05]"
                : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  rookieChoice === "license-only" ? "border-white/60" : "border-white/30"
                }`}
              >
                {rookieChoice === "license-only" && <span className="w-2.5 h-2.5 rounded-full bg-white/80" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-0.5">
                  <span className="font-semibold text-white/80 text-sm">License only</span>
                  <span className="font-semibold text-white/70 text-sm whitespace-nowrap">
                    ${LICENSE_PRICE.toFixed(2)}
                    <span className="text-white/30 text-xs font-normal ml-1">/racer</span>
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

      {/* Video */}
      <div className="rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-[#00E2E5]/10">
        <video
          src={POV_VIDEO}
          autoPlay
          loop
          muted
          playsInline
          className="w-full aspect-video object-cover"
        />
      </div>

      {/* Description */}
      <div className="text-center space-y-3">
        <h3 className="text-white font-bold text-lg">ViewPoint POV Camera</h3>
        <p className="text-white/50 text-sm leading-relaxed max-w-md mx-auto">
          Relive every turn, overtake, and adrenaline-fueled moment from your kart&apos;s perspective.
          Your footage is ready to download after your race — perfect for sharing on social media.
        </p>
        <div className="flex items-center justify-center gap-3">
          <span className="text-[#00E2E5] font-bold text-2xl">${price}</span>
          <span className="text-white/30 text-sm">/person</span>
          <span className="text-white/20">|</span>
          <span className="text-red-400/60 text-sm line-through">$7 at check-in</span>
        </div>
      </div>

      {/* Add / Quantity — hidden during the Rookie Pack flow because
          the pack/license-only radio already controls quantity. */}
      {!showRookieFlow && (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
        {qty === 0 ? (
          /* Primary: "Add for all X racers" */
          <button
            onClick={() => setQty(racerCount)}
            className="w-full py-3.5 rounded-xl text-sm font-bold bg-[#00E2E5]/15 text-[#00E2E5] border border-[#00E2E5]/30 hover:bg-[#00E2E5]/25 transition-colors"
          >
            Add for all {racerCount} racer{racerCount !== 1 ? "s" : ""} — ${(price * racerCount).toFixed(2)}
          </button>
        ) : (
          /* Added state: total + small adjuster */
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQty(Math.max(0, qty - 1))}
                  className="w-8 h-8 rounded-lg border border-white/20 text-white/50 hover:border-white/40 hover:text-white transition-colors flex items-center justify-center text-lg"
                >
                  -
                </button>
                <span className="w-6 text-center text-white font-bold text-sm">{qty}</span>
                <button
                  onClick={() => setQty(qty + 1)}
                  className="w-8 h-8 rounded-lg border border-white/20 text-white/50 hover:border-white/40 hover:text-white transition-colors flex items-center justify-center text-lg"
                >
                  +
                </button>
                <span className="text-white/30 text-xs">{qty} camera{qty !== 1 ? "s" : ""}</span>
              </div>
              <span className="text-[#00E2E5] font-bold text-lg">${(price * qty).toFixed(2)}</span>
            </div>
            {qty !== racerCount && (
              <button
                onClick={() => setQty(racerCount)}
                className="w-full py-2 rounded-lg text-xs font-semibold text-[#00E2E5]/70 hover:text-[#00E2E5] transition-colors"
              >
                Set to all {racerCount} racers
              </button>
            )}
          </>
        )}
      </div>
      )}

      {/* CTA */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => {
            // In the rookie flow, "pack" sells POV for every racer +
            // tags the booking record with rookiePack: true (drives
            // the appetizer card on the confirmation page). "License
            // only" returns null POV but still tags the booking with
            // rookiePack: false — so we know the customer was offered
            // the pack and explicitly opted out, useful for analytics.
            if (showRookieFlow) {
              if (rookieChoice === "pack") {
                onContinue({ id: "43746981", quantity: racerCount, price, rookiePack: true });
              } else {
                onContinue({ id: "43746981", quantity: 0, price, rookiePack: false });
              }
              return;
            }
            onContinue(qty > 0 ? { id: "43746981", quantity: qty, price } : null);
          }}
          className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
        >
          {showRookieFlow
            ? rookieChoice === "pack"
              ? `Continue with Rookie Pack — $${((LICENSE_PRICE + price) * racerCount).toFixed(2)} →`
              : "Continue with License Only →"
            : effectiveQty > 0
              ? `Continue with ${effectiveQty} Camera${effectiveQty !== 1 ? "s" : ""} →`
              : "Skip — Continue to Checkout →"}
        </button>
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Back to heat selection
      </button>
    </div>
  );
}
