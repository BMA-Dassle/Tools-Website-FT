"use client";

import { useLicenceOffer } from "./useLicenceOffer";

/**
 * "This changed" notice at the top of the confirmation.
 *
 * NOT AN OFFER — AN INSTRUCTION. The QR below used to be a per-heat check-in
 * code and is now the racer's permanent licence, doing both jobs. A guest who
 * skims past that arrives at Race Check-In looking for something that is no
 * longer there, so this states the change plainly and tells them what to do
 * with it.
 *
 * EXPRESS LANE GETS THE STRONGER WORDING because those guests bypass Guest
 * Services and walk straight to Karting — the code in their hand is the entire
 * check-in, and there is no counter to catch a mistake.
 *
 * Renders only when the card it refers to will also render (both read the same
 * shared, deduped fetch), so it can never announce something that is not on the
 * page.
 */
export default function LicenceOfferBanner({
  billId,
  expressLane = false,
}: {
  billId: string;
  expressLane?: boolean;
}) {
  const racers = useLicenceOffer(billId);
  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

  return (
    <div className="md:col-span-2 w-full max-w-2xl mx-auto mb-6 rounded-2xl border border-[#00E2E5]/40 bg-[#00E2E5]/[0.08] px-5 py-4">
      <div className="flex items-center gap-2.5 mb-2">
        <span className="rounded-full bg-[#00E2E5] px-2.5 py-[3px] text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#04252b]">
          New
        </span>
        <p className="font-display text-[13px] uppercase tracking-[0.16em] text-[#00E2E5]">
          Your check-in code has changed
        </p>
      </div>

      <p className="text-white/85 text-sm leading-relaxed">
        The QR below is now <strong className="text-white">both your e-ticket and your FastTrax
        Racing Licence</strong> — one code for check-in, the kiosks and the register.{" "}
        {expressLane ? (
          <>
            You’re on Express Check-In, so{" "}
            <strong className="text-white">please have it ready when you arrive</strong> — or add it
            to Apple or Google Wallet so it’s always on your phone.
          </>
        ) : (
          <>
            Please have it ready at Race Check-In, or add it to Apple or Google Wallet so it’s
            always on your phone.
          </>
        )}
      </p>
    </div>
  );
}
