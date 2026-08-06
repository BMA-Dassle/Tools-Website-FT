"use client";

import { useEffect, useState } from "react";

/**
 * "Racing licences" on the confirmation page — one row per racer on the booking.
 *
 * THE PHONE BELONGS TO WHOEVER BOOKED. A parent booking for three kids can only
 * add their OWN licence to the device in their hand; everyone else needs it on
 * their own phone. So the booker gets a direct Add button and every other racer
 * gets a QR they scan themselves.
 *
 * PER-RACER ROWS, NAMED. A row of unlabelled QR codes is exactly how a parent's
 * licence ends up on a child's phone — the same ambiguity the kiosk roster had,
 * fixed the same way.
 *
 * NOTHING IS BILLED BY SHOWING THIS. A licence is created only when a racer taps
 * or scans and `/r/{code}/wallet` runs on their device, so a party of four costs
 * nothing until they each opt in.
 *
 * Renders nothing at all when no one on the booking holds a BMI tag — a
 * first-timers-only booking has no licences to offer and should not see a card
 * explaining that.
 */
interface OfferRacer {
  personId: string;
  name: string;
  qr: string | null;
  isYou: boolean;
}

export default function LicenceOfferCard({ billId }: { billId: string }) {
  const [racers, setRacers] = useState<OfferRacer[] | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!billId) return;
    let cancelled = false;
    fetch(`/api/racing/licence-offer?billId=${encodeURIComponent(billId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && Array.isArray(j?.racers)) setRacers(j.racers as OfferRacer[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [billId]);

  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

  // Racers with no tag yet are listed only when they are in the minority — in a
  // party where most people can get one, a silently missing name reads as a bug.
  const pending = racers.filter((r) => !r.qr);
  const showPending = pending.length > 0 && pending.length < racers.length;
  const you = eligible.find((r) => r.isYou) ?? null;
  const others = eligible.filter((r) => !r.isYou);

  return (
    <div className="mt-6 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/[0.06] p-5">
      <p className="font-display text-[11px] uppercase tracking-[0.2em] text-[#00E2E5] mb-1.5">
        Wallet instead of texts
      </p>
      <h3 className="text-white text-lg font-bold leading-snug mb-1">
        Get your FastTrax licence in your phone’s wallet
      </h3>
      <p className="text-white/50 text-sm mb-4 max-w-md">
        Choose the wallet pass instead of a text before every race. Your next race appears on it
        automatically and updates itself if your heat moves — and it signs you in at the kiosk, the
        check-in desk and the register. Scan the code with your phone camera.
      </p>

      <div className="flex flex-col divide-y divide-white/10">
        {you && (
          <Row racer={you} open={openFor === you.personId} onToggle={setOpenFor} direct />
        )}
        {others.map((r) => (
          <Row key={r.personId} racer={r} open={openFor === r.personId} onToggle={setOpenFor} />
        ))}
        {showPending &&
          pending.map((r) => (
            <div key={r.personId} className="py-3">
              <p className="text-white/40 text-sm font-semibold">{r.name}</p>
              <p className="text-white/30 text-xs mt-0.5">
                First visit — their licence is ready after they race.
              </p>
            </div>
          ))}
      </div>
    </div>
  );
}

function Row({
  racer,
  open,
  onToggle,
  direct = false,
}: {
  racer: OfferRacer;
  open: boolean;
  onToggle: (id: string | null) => void;
  direct?: boolean;
}) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white text-[15px] font-bold truncate">{racer.name}</span>
          {direct && (
            <span className="shrink-0 rounded-full border border-[#00E2E5]/45 px-2 py-[1px] text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#00E2E5]">
              You
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onToggle(open ? null : racer.personId)}
          aria-expanded={open}
          aria-label={`Show the licence QR code for ${racer.name}`}
          className="shrink-0 rounded-lg border border-white/25 bg-black px-3 py-2 text-[11px] font-semibold text-white"
        >
          {open ? "Hide" : "Scan the code"}
        </button>
      </div>

      {open && (
        <div className="mt-3 flex items-center gap-4">
          <div className="rounded-xl bg-white p-2 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
            <img src={racer.qr ?? ""} alt="" width={104} height={104} className="block" />
          </div>
          <p className="text-white/55 text-xs leading-relaxed">
            {direct
              ? "Scan with your phone camera to add your licence."
              : `Scan with ${racer.name.split(/\s+/)[0]}’s own phone camera — their licence goes on their phone, not yours.`}
          </p>
        </div>
      )}
    </div>
  );
}
