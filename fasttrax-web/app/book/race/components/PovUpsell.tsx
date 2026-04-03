"use client";

import { useState } from "react";

const POV_VIDEO = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/viewpoint-pov-suJzzax08ZbSJpcdNKQvT9nNvWlgFc.mp4";

export interface PovSelection {
  id: string;
  quantity: number;
  price: number;
  billLineId?: string;
}

interface PovUpsellProps {
  racerCount: number;
  onContinue: (pov: PovSelection | null) => void;
  onBack: () => void;
  initial?: PovSelection | null;
}

export default function PovUpsell({ racerCount, onContinue, onBack, initial }: PovUpsellProps) {
  const [qty, setQty] = useState(initial?.quantity ?? 0);
  const price = 5;

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

      {/* Add / Quantity */}
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

      {/* CTA */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => onContinue(qty > 0 ? { id: "30084297", quantity: qty, price } : null)}
          className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
        >
          {qty > 0 ? `Continue with ${qty} Camera${qty !== 1 ? "s" : ""} →` : "Skip — Continue to Checkout →"}
        </button>
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Back to heat selection
      </button>
    </div>
  );
}
