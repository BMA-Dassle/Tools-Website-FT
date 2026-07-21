"use client";

/**
 * "Join from your phone" on the people step — a compact tile that expands
 * into a focused QR sheet on tap (owner 2026-07-20: the always-open panel
 * read as clutter). While a phone is mid sign-in the tile wears an amber
 * breathing glow (k-join-signing) + a live count line, so the group sees the
 * kiosk is waiting on someone even with the sheet closed. The no-split-payment
 * warning lives on the PHONE flow only (JoinPhoneFlow warns at landing and
 * again before finishing) — the kiosk no longer repeats it. Purely
 * presentational; the session/poll lives in useMobileJoin. Renders nothing
 * while the feature flag is off (the parent gates), and degrades to a muted
 * card with a retry when the session couldn't open (the kiosk's manual add
 * flows are never blocked by this feature).
 */
import { useState } from "react";
import type { MobileJoinSnapshot } from "../join/kiosk-client";

interface Props extends MobileJoinSnapshot {
  qrDataUrl: string | null;
  onReopen: () => void;
}

function AmberPulse() {
  return (
    <span className="relative flex h-[14px] w-[14px] shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f0b341] opacity-60" />
      <span className="relative inline-flex h-[14px] w-[14px] rounded-full bg-[#f0b341]" />
    </span>
  );
}

export function KioskMobileJoinPanel({ status, qrDataUrl, inProgressClients, onReopen }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (status === "idle") return null;

  const unavailable = status === "closed" || status === "error";
  const signing = inProgressClients > 0;
  const signingLine =
    inProgressClients === 1
      ? "1 phone signing in right now"
      : `${inProgressClients} phones signing in right now`;

  if (unavailable) {
    return (
      <div className="k-glass flex flex-wrap items-center justify-between gap-[20px] p-[28px]">
        <div>
          <div className="k-eyebrow text-white/40">Or join from your phone</div>
          <div className="mt-[6px] text-[26px] font-bold text-white/55">
            Phone sign-in isn&rsquo;t available right now — add players here at the kiosk.
          </div>
        </div>
        <button
          type="button"
          onClick={onReopen}
          className="k-tap rounded-2xl border-2 border-white/25 px-[28px] py-[16px] text-[24px] font-bold text-white/80"
        >
          Get a new code
        </button>
      </div>
    );
  }

  if (!expanded) {
    return (
      <div className="flex">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`k-tap flex items-center gap-[22px] rounded-3xl border-2 px-[26px] py-[20px] text-left ${
            signing ? "k-join-signing" : "border-white/25"
          }`}
        >
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt=""
              aria-hidden="true"
              className="h-[96px] w-[96px] shrink-0 rounded-xl bg-white p-[6px]"
            />
          ) : (
            <span className="grid h-[96px] w-[96px] shrink-0 place-items-center rounded-xl border-2 border-dashed border-white/20">
              <span className="h-[28px] w-[28px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block text-[28px] font-bold text-white">Join from your phone</span>
            {signing ? (
              <span className="mt-[4px] flex items-center gap-[10px] text-[20px] font-semibold text-[#f5d38a]">
                <AmberPulse />
                {signingLine}
              </span>
            ) : (
              <span className="mt-[4px] block text-[20px] text-white/45">
                Adults 18+ can join right here &mdash; tap for the QR code
              </span>
            )}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="k-glass flex flex-col items-center gap-[24px] px-[48px] py-[44px] text-center">
      {qrDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qrDataUrl}
          alt="QR code — scan to sign in on your phone"
          className="h-[400px] w-[400px] rounded-2xl bg-white p-[12px]"
        />
      ) : (
        <div className="grid h-[400px] w-[400px] place-items-center rounded-2xl border-2 border-dashed border-white/20">
          <span className="h-[40px] w-[40px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
        </div>
      )}
      <div>
        <div className="text-[34px] font-bold text-white">Scan with your phone camera</div>
        <p className="mt-[8px] text-[22px] text-white/45">
          Adults 18+ &middot; waiver signed on the phone &middot; kids are added here at the kiosk
        </p>
      </div>
      {signing && (
        <div className="flex items-center gap-[14px] text-[22px] font-bold text-[#f5d38a]">
          <AmberPulse />
          {signingLine} — they&rsquo;ll pop into the list above when they finish.
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="k-tap rounded-2xl border-2 border-white/25 px-[44px] py-[14px] text-[24px] font-bold text-white/80"
      >
        Done
      </button>
    </div>
  );
}
