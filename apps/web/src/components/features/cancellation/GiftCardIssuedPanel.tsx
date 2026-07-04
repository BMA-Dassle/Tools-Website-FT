"use client";

import { useState } from "react";
import { IconCheck, IconCopy, IconGiftCard } from "@tabler/icons-react";

/** "1234-5678-9012-3456" display grouping — value itself is never altered. */
function ganDisplay(gan: string): string {
  return gan.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * Success block after a store-credit cancellation: the guest's new gift card
 * number (Square-generated GAN), copy button, balance link, and the rebook
 * CTA. Shared by the v2 confirmation page and BowlingConfirmation. Dark-theme
 * styling matches the confirmation pages' rounded-2xl card language.
 */
export default function GiftCardIssuedPanel({
  gan,
  giftCardId,
  amountCents,
  rebookHref,
  sentToGuest = true,
}: {
  gan: string;
  giftCardId?: string | null;
  amountCents: number;
  rebookHref: string;
  /** false = delivery failed; the panel tells the guest to save the number. */
  sentToGuest?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const balanceUrl = giftCardId
    ? `https://squareup.com/gift/balance/${giftCardId.replace(/^gftc:/, "")}`
    : null;

  return (
    <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-emerald-400/15 flex items-center justify-center shrink-0">
          <IconGiftCard className="w-6 h-6 text-emerald-400" />
        </div>
        <div>
          <h2 className="font-display text-lg uppercase tracking-widest text-white">
            Your HeadPinz FastTrax Gift Card is ready
          </h2>
          <p className="text-white/50 text-xs">
            Booking cancelled — the full ${(amountCents / 100).toFixed(2)} you paid is on this card.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-center">
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-bold">
          HeadPinz FastTrax Gift Card
        </p>
        <div className="mt-1.5 flex items-center justify-center gap-2 flex-wrap">
          <span className="font-mono text-lg sm:text-xl font-bold text-white tracking-wide">
            {ganDisplay(gan)}
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(gan).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70 hover:text-white hover:border-white/30"
          >
            {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-white/40 text-xs mt-2">
          {sentToGuest
            ? "We also emailed and texted it to you."
            : "Save this number — we could not deliver it by email or text."}
        </p>
      </div>

      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <a
          href={rebookHref}
          className="flex-1 text-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold uppercase tracking-wider text-sm px-4 py-3"
        >
          Rebook Now
        </a>
        {balanceUrl && (
          <a
            href={balanceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-center rounded-xl border border-white/15 text-white/80 hover:text-white hover:border-white/30 font-semibold uppercase tracking-wider text-sm px-4 py-3"
          >
            Check Balance
          </a>
        )}
      </div>
      <p className="text-white/40 text-xs mt-3 leading-relaxed">
        Use it online at checkout for any date — if your new visit is priced differently, the card
        simply covers its value toward the total. It never expires.
      </p>
    </div>
  );
}
