"use client";

import { useLicenceOffer } from "./useLicenceOffer";

/**
 * Express-lane banner pointing down at the licence card.
 *
 * Only renders when that card will actually render — it says "below", and a
 * banner promising something that isn't on the page is worse than no banner.
 * Both read the same shared fetch, so they cannot disagree.
 *
 * Deliberately quiet next to the express-lane card above it: that one is the
 * thing the guest needs tonight and carries the animated emerald border. This
 * is an offer, not an instruction, and must not compete with it.
 */
export default function LicenceOfferBanner({ billId }: { billId: string }) {
  const racers = useLicenceOffer(billId);
  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

  return (
    <div className="md:col-span-2 w-full max-w-2xl mx-auto mb-6 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/[0.06] px-5 py-3.5 flex items-center gap-3">
      <svg
        className="w-5 h-5 shrink-0 text-[#00E2E5]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path strokeLinecap="round" d="M2 10h20" />
      </svg>
      <p className="text-white/85 text-sm leading-snug">
        <span className="font-bold text-white">Race a lot?</span> Add your licence to Apple or
        Google Wallet below — and never need an email or text again.
      </p>
    </div>
  );
}
