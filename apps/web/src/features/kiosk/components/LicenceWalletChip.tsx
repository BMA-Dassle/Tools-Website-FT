"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * "Add licence to phone" — the wallet racing licence, offered on a racer's own
 * roster card during kiosk sign-in.
 *
 * A KIOSK IS A SHARED SCREEN, so the pass cannot land on it. The bridge is a QR
 * the racer scans with their own phone camera, which opens `/r/{code}/wallet`
 * on THEIR device and adds it there.
 *
 * PER-CARD, NOT ONE SHARED PANEL. With a family of four, a row of QR codes
 * under the roster leaves it ambiguous which code belongs to whom, and scanning
 * the wrong one puts a parent's licence on a child's phone. Anchoring each QR
 * to the racer's own card removes the ambiguity entirely.
 *
 * NON-BLOCKING. The racer is mid-booking, so this is an affordance that expands
 * IN PLACE on tap — never a modal, never a step they have to dismiss.
 *
 * NOTHING IS ISSUED BY RENDERING THIS. A licence is a PassKit member record and
 * bills every month it exists; the pass is only created when the racer actually
 * scans and `/r/{code}/wallet` runs on their phone (owner rule 2026-08-05:
 * "don't build it till they scan").
 */
export default function LicenceWalletChip({
  loginCode,
  brand,
  label,
  scanHint,
  closeLabel,
  ariaLabel,
}: {
  loginCode: string;
  brand?: string;
  label: string;
  scanHint: string;
  closeLabel: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  // Generated only once the racer asks — a roster of six would otherwise
  // encode six QRs nobody looked at.
  useEffect(() => {
    if (!open || qr) return;
    const domain = brand === "headpinz" ? "https://headpinz.com" : "https://fasttraxent.com";
    let cancelled = false;
    QRCode.toDataURL(`${domain}/r/${loginCode}/wallet`, {
      width: 360,
      margin: 1,
      color: { dark: "#04252b", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, qr, loginCode, brand]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        className="mt-[10px] inline-flex items-center gap-[10px] rounded-full border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-[18px] py-[8px] text-[20px] font-semibold text-[#00e2e5]"
      >
        <span aria-hidden="true">▣</span>
        {label}
      </button>
    );
  }

  return (
    <div className="mt-[10px] flex items-center gap-[20px] rounded-2xl border border-[#00e2e5]/30 bg-[#00e2e5]/5 p-[16px]">
      {/* White plate: a QR needs a light quiet zone to scan reliably off a
          dark kiosk panel. */}
      <div className="rounded-xl bg-white p-[8px]">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URI, no loader
          <img src={qr} alt="" width={140} height={140} className="block" />
        ) : (
          <div className="h-[140px] w-[140px]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[22px] font-semibold leading-tight text-white">{scanHint}</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-[12px] rounded-full border border-white/20 px-[18px] py-[6px] text-[20px] font-semibold text-white/70"
        >
          {closeLabel}
        </button>
      </div>
    </div>
  );
}
