"use client";

import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";
import { useLicenceOffer, type OfferRacer } from "./useLicenceOffer";

/**
 * The racing licence on the confirmation page — one QR per racer, all rendered.
 *
 * THIS IS THE CHECK-IN CODE, not a marketing offer, and the copy has to say so.
 * It replaced a grid labelled "Check-In QR", so anything vaguer than "scan this
 * to check into your race" loses the guest the thing they actually came here
 * for. That it is ALSO a permanent licence — kiosk sign-in, register login,
 * next race on the pass — is the second sentence, never the first.
 *
 * EVERY RACER'S QR IS SHOWN. The old grid rendered all of them and people used
 * it; hiding three behind links would be a regression dressed as tidiness. Each
 * is named, which is what the old grid got wrong — a row of unlabelled codes is
 * how a parent's licence ends up on a child's phone.
 *
 * The booker additionally gets a wallet badge, because theirs is the only phone
 * this page can put a pass on. Everyone else gets a link to their own page,
 * where they can do the same on their own device.
 *
 * NOTHING IS BILLED BY RENDERING THIS. A pass is created only when a racer taps
 * or scans and the wallet route runs on their device.
 *
 * No login codes reach the browser: links are server-resolved hops and every QR
 * is rendered server-side.
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

  // Booker first — theirs is the phone in front of this page.
  const ordered = [...eligible].sort((a, b) => Number(b.isYou) - Number(a.isYou));

  return (
    <div className="mt-6 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/[0.06] p-5">
      <p className="font-display text-[11px] uppercase tracking-[0.2em] text-[#00E2E5] mb-1.5">
        Race check-in · FastTrax Licence
      </p>
      <h3 className="text-white text-lg font-bold leading-snug mb-1">
        Scan this to check into your race
      </h3>
      <p className="text-white/55 text-sm mb-5 max-w-md leading-relaxed">
        It’s your FastTrax Racing Licence too — the same code signs you in at any kiosk and at the
        register, and it never expires. Add it to your phone’s wallet and it shows your next race
        automatically, instead of a text before every visit.
      </p>

      <div className="flex flex-col divide-y divide-white/10">
        {ordered.map((r) => (
          <RacerQr key={r.personId} racer={r} platform={r.isYou ? platform : null} />
        ))}
      </div>
    </div>
  );
}

function RacerQr({ racer, platform }: { racer: OfferRacer; platform: WalletPlatform | null }) {
  const badge =
    platform === "apple"
      ? { src: "/brand/wallet/apple-wallet-en.svg", w: 158, label: "Add to Apple Wallet" }
      : platform === "google"
        ? { src: "/brand/wallet/google-wallet-en.svg", w: 181, label: "Add to Google Wallet" }
        : null;

  return (
    <div className="py-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-white text-[15px] font-bold truncate">{racer.name}</span>
        {racer.isYou && (
          <span className="shrink-0 rounded-full border border-[#00E2E5]/45 px-2 py-[1px] text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#00E2E5]">
            You
          </span>
        )}
      </div>

      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-white p-2 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
          <img src={racer.qr ?? ""} alt="" width={128} height={128} className="block" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-white/55 text-xs leading-relaxed">
            Scan at the check-in desk, any kiosk, or the register.
          </p>

          {/* Only the booker's row: this is the one phone the page can reach. */}
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
            <a href={racer.hubUrl} className="mt-2.5 block text-[#00E2E5] text-xs font-semibold">
              {racer.isYou ? "View my page ›" : `Open ${racer.name.split(/\s+/)[0]}’s page ›`}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
