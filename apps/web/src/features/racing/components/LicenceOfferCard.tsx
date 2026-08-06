"use client";

import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";
import { useLicenceOffer, type OfferRacer } from "./useLicenceOffer";

/**
 * The racing licence on the confirmation page — one row per racer.
 *
 * THE PHONE BELONGS TO WHOEVER BOOKED. The booker's row carries everything at
 * once: their licence QR inline, a wallet badge, and a link to their permanent
 * page. Everyone else gets a link to their OWN page, where they can do the same
 * on their own phone — handing the booker four "add" buttons would just stack
 * four licences onto one device.
 *
 * NAMED ROWS, NEVER A BARE GRID OF CODES. This replaces a wall of per-heat
 * check-in QRs; a row of unlabelled codes is exactly how a parent's licence ends
 * up on a child's phone, and it is the ambiguity the kiosk roster had to fix too.
 *
 * NOTHING IS BILLED BY RENDERING THIS. A licence is created only when a racer
 * taps or scans and the wallet route runs on their device, so a party of four
 * costs nothing until they each opt in.
 *
 * No login codes reach the browser: both links are server-resolved hops, and the
 * QR is rendered server-side.
 */
export default function LicenceOfferCard({ billId }: { billId: string }) {
  const racers = useLicenceOffer(billId);

  // Computed during render, not held in state: nothing paints until `racers`
  // resolves (client-only), so server and client both render null through
  // hydration and there is no mismatch to guard against.
  const platform: WalletPlatform | null =
    typeof navigator === "undefined" ? null : walletPlatformFromUserAgent(navigator.userAgent);

  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

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
        One code that signs you in at the kiosk, checks you into your race and logs you in at the
        register — and shows your next race, updating itself if your heat moves.
      </p>

      <div className="flex flex-col divide-y divide-white/10">
        {you && <BookerRow racer={you} platform={platform} />}
        {others.map((r) => (
          <OtherRow key={r.personId} racer={r} />
        ))}
      </div>
    </div>
  );
}

/** The person holding the phone gets all three affordances at once. */
function BookerRow({ racer, platform }: { racer: OfferRacer; platform: WalletPlatform | null }) {
  // Desktop resolves to null, which is the right answer there: no wallet to add
  // to, so the QR below is the whole point. On a phone both are useful — the
  // badge for this device, the code for the desk.
  const badge =
    platform === "apple"
      ? { src: "/brand/wallet/apple-wallet-en.svg", w: 158, label: "Add to Apple Wallet" }
      : platform === "google"
        ? { src: "/brand/wallet/google-wallet-en.svg", w: 181, label: "Add to Google Wallet" }
        : null;

  return (
    <div className="py-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-white text-[15px] font-bold truncate">{racer.name}</span>
        <span className="shrink-0 rounded-full border border-[#00E2E5]/45 px-2 py-[1px] text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#00E2E5]">
          You
        </span>
      </div>

      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-white p-2 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
          <img src={racer.qr ?? ""} alt="" width={112} height={112} className="block" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-white/55 text-xs leading-relaxed">
            Scan at the kiosk, check-in desk or register.
          </p>
          {badge && racer.addUrl && (
            // White plate: Apple's badge is drawn for light backgrounds and
            // Google only ships #1F1F1F. Restyling vendor artwork is not
            // allowed; giving it a light host surface is.
            <div className="mt-2.5 rounded-xl bg-white p-2.5 inline-flex">
              <a href={`${racer.addUrl}&platform=${platform}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- vendor artwork must ship byte-for-byte */}
                <img src={badge.src} alt={badge.label} width={badge.w} height={50} />
              </a>
            </div>
          )}
          {racer.hubUrl && (
            <a
              href={racer.hubUrl}
              className="mt-2.5 block text-[#00E2E5] text-xs font-semibold"
            >
              View my page ›
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Everyone else: a link to their own page, where the licence lands on THEIR phone. */
function OtherRow({ racer }: { racer: OfferRacer }) {
  if (!racer.hubUrl) return null;
  return (
    <a
      href={racer.hubUrl}
      className="flex items-center justify-between gap-3 py-3 text-white"
      aria-label={`Open ${racer.name}'s racing licence page`}
    >
      <span className="text-[15px] font-bold truncate">{racer.name}</span>
      <span className="shrink-0 text-[#00E2E5] text-xs font-semibold">View page ›</span>
    </a>
  );
}
