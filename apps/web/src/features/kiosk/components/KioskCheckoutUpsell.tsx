"use client";

/**
 * Checkout upsell page (owner 2026-07-21) — full-screen interstitial between
 * "Review & Pay" and the pay screen, shown ONLY when no Game Zone cards ride
 * the cart (KioskFlow gates eligibility: merged flow + reader rail +
 * dispenser + once per session). First offer: the discounted token card —
 * "100 tokens for $5, 50% off" (50 reg + 50 bonus, activation fee waived —
 * see TokenPackage.upsell). Quantity is capped at one card per person on the
 * transaction; the reserve rails enforce the same cap server-side.
 *
 * Accept dispatches a normal `setGameCardPurchase` — pricing, the deposit
 * order line, the ledger rows, and the dispense/load fulfillment all ride
 * the existing Game Zone cart rail untouched.
 */

import { useState } from "react";
import type { TokenPackage } from "~/features/game-cards/constants";

export function KioskCheckoutUpsell({
  pack,
  partySize,
  onAdd,
  onSkip,
}: {
  pack: TokenPackage;
  /** People on the transaction — the quantity ceiling (min 1). */
  partySize: number;
  onAdd: (packageId: string, quantity: number) => void;
  onSkip: () => void;
}) {
  const maxQty = Math.max(1, partySize);
  const [qty, setQty] = useState(1);
  const totalTokens = pack.tokens + pack.bonusTokens;
  const priceDollars = (pack.priceCents * qty) / 100;
  const compareAt = pack.upsell ? (pack.upsell.compareAtCents * qty) / 100 : null;
  const pctOff = pack.upsell
    ? Math.round((1 - pack.priceCents / pack.upsell.compareAtCents) * 100)
    : 0;

  return (
    <div className="k-flow-body flex flex-col items-center justify-center">
      <div className="w-full max-w-[880px] space-y-[32px]">
        <div>
          <div className="k-eyebrow text-[#f0b341]">One more thing…</div>
          <div className="k-display mt-[10px] text-[64px] leading-[1.02]">
            Add Game Zone tokens?
          </div>
        </div>

        <div className="k-glass space-y-[28px] p-[44px]">
          <div className="flex items-end justify-between gap-[24px]">
            <div>
              <div className="k-eyebrow" style={{ color: "#f800c6" }}>
                Game Zone token card
              </div>
              <div className="k-display mt-[8px] text-[84px] leading-none text-white">
                {totalTokens} tokens
              </div>
            </div>
            <div className="text-right">
              {compareAt != null && (
                <div className="k-num text-[34px] text-white/35 line-through">
                  ${compareAt.toFixed(2)}
                </div>
              )}
              <div className="k-num k-display text-[72px] leading-none text-[#00e2e5]">
                ${priceDollars.toFixed(2)}
              </div>
              {pctOff > 0 && (
                <div className="mt-[6px] inline-block rounded-full bg-[#f0b341]/15 px-[18px] py-[6px] text-[24px] font-extrabold uppercase tracking-wider text-[#f0b341]">
                  {pctOff}% off today
                </div>
              )}
            </div>
          </div>

          <p className="text-[27px] leading-snug text-white/60">
            Rides your booking payment — the card{qty > 1 ? "s print" : " prints"} right here when
            you&apos;re done.
          </p>

          {maxQty > 1 && (
            <div className="flex items-center justify-between gap-[20px] border-t border-white/10 pt-[24px]">
              <div>
                <div className="text-[28px] font-bold text-white">How many cards?</div>
                <div className="text-[23px] text-white/45">One per player (up to {maxQty})</div>
              </div>
              <div className="flex items-center gap-[18px]">
                <button
                  type="button"
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  disabled={qty <= 1}
                  aria-label="Fewer cards"
                  className="k-tap h-[92px] w-[92px] rounded-full border-2 border-white/15 text-[44px] font-bold text-white disabled:opacity-30"
                >
                  −
                </button>
                <span className="k-num w-[80px] text-center text-[52px] font-extrabold text-white">
                  {qty}
                </span>
                <button
                  type="button"
                  onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
                  disabled={qty >= maxQty}
                  aria-label="More cards"
                  className="k-tap h-[92px] w-[92px] rounded-full border-2 border-white/15 text-[44px] font-bold text-white disabled:opacity-30"
                >
                  +
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-[16px]">
          <button
            type="button"
            onClick={() => onAdd(pack.id, qty)}
            className="k-btn-primary k-tap"
            style={{ flex: "0 0 auto" }}
          >
            Add {qty > 1 ? `${qty} cards` : "to order"} — ${priceDollars.toFixed(2)} →
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="k-btn-ghost k-tap"
            style={{ flex: "0 0 auto" }}
          >
            No thanks, continue
          </button>
        </div>
      </div>
    </div>
  );
}
