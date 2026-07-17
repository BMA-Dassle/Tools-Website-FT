"use client";

/**
 * Kiosk confirmation — the guest's receipt IS their phone (email + SMS were
 * sent by the reserve path; there is no printer). Shows the booking code,
 * auto-resets to the attract screen after 60s so the kiosk is never left
 * on a stranger's confirmation.
 *
 * `src` carries the ORIGINAL web confirmation URL produced by CheckoutStep
 * (e.g. /hp/book/bowling/confirmation?code=XXXX) — we surface its code and
 * keep a stable seam for the bowl-now live-lane display to hook into.
 */
import { useEffect, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { KIOSK_LOGOS } from "../assets";

const AUTO_RESET_SECONDS = 60;

function codeFromSrc(src: string | null): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, "https://kiosk.local");
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

export function KioskConfirmation({ src }: { src: string | null }) {
  const { config } = useKioskConfig();
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RESET_SECONDS);
  const code = codeFromSrc(src);

  useEffect(() => {
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          window.location.href = "/kiosk";
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    const onTouch = () => setSecondsLeft(AUTO_RESET_SECONDS);
    document.addEventListener("pointerdown", onTouch, { passive: true });
    return () => {
      clearInterval(iv);
      document.removeEventListener("pointerdown", onTouch);
    };
  }, []);

  return (
    <div className="relative flex h-screen w-screen flex-col items-center justify-center gap-8 overflow-hidden bg-[#000418] px-10 text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(70% 45% at 50% 22%, rgba(0,226,229,0.16), transparent 65%)",
        }}
      />
      <svg
        width="180"
        height="180"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#46d68c"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m7.5 12.5 3 3 6-7" />
      </svg>
      <h1 className="font-heading relative text-[9vh] font-extrabold italic leading-none">
        You&rsquo;re booked.
      </h1>
      <p className="relative max-w-[30ch] text-[2.6vh] text-white/60">
        Your confirmation and check-in links were just texted and emailed to you — that&rsquo;s your
        ticket, nothing to print.
      </p>
      {code ? (
        <div className="relative rounded-2xl border border-white/15 bg-white/[0.04] px-10 py-5">
          <div className="font-heading text-[1.6vh] font-bold uppercase tracking-[0.3em] text-white/45">
            Booking code
          </div>
          <div className="font-heading text-[5vh] font-extrabold tracking-widest">{code}</div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          window.location.href = "/kiosk";
        }}
        className="font-heading relative mt-4 h-[9vh] w-full max-w-[70%] rounded-full bg-[#00e2e5] text-[3vh] font-extrabold uppercase italic tracking-wide text-[#04252b]"
      >
        Done — start over
      </button>
      <p className="relative text-[1.9vh] text-white/40 tabular-nums">
        Returning to start in {secondsLeft}s — touch anywhere to stay
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={KIOSK_LOGOS[config?.brand ?? "fasttrax"]}
        alt=""
        className="relative h-[5vh] opacity-70"
        draggable={false}
      />
    </div>
  );
}
