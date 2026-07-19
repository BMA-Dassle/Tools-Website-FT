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
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useKioskConfig } from "../KioskConfigContext";
import { resetToKiosk } from "../version";
import { KIOSK_LOGOS } from "../assets";
import { readGzFulfillment, type GzFulfillmentPayload } from "../service/gz-fulfillment";
import { KioskGzFulfillment } from "./KioskGzFulfillment";
import {
  readRacePackConfirmation,
  clearRacePackConfirmation,
  type RacePackConfirmLine,
} from "../service/race-pack-confirmation";

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
  const router = useRouter();
  const { config } = useKioskConfig();
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RESET_SECONDS);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // Game Zone cards bought WITH the booking — checkout stashed the charged row
  // pointers; this screen fulfills them (dispense/load) alongside the booking
  // confirmation (owner: "combining the you're-booked and card-dispense screen").
  // Read client-side after mount (sessionStorage) to keep hydration clean.
  const [gzPayload, setGzPayload] = useState<GzFulfillmentPayload | null>(null);
  const [gzBusy, setGzBusy] = useState(false);
  // Race packs bought with the booking — display-only outcome lines
  // ("1 race today · 2 banked to Eric's account"); credits already granted
  // server-side, so the stash is read-once + cleared.
  const [racePacks, setRacePacks] = useState<RacePackConfirmLine[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve(); // defer past the sync effect body (lint + hydration)
      if (!alive) return;
      const p = readGzFulfillment();
      if (p) {
        setGzPayload(p);
        setGzBusy(true);
      }
      const packs = readRacePackConfirmation();
      if (packs) {
        setRacePacks(packs);
        clearRacePackConfirmation();
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const code = codeFromSrc(src);

  // Encode the booking code as a QR so staff can scan it at check-in (the SMS +
  // email carry the full link; this is the on-screen fallback).
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    QRCode.toDataURL(code, { width: 360, margin: 1, color: { dark: "#04252b", light: "#ffffff" } })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => {
    // NEVER auto-reset while cards are still dispensing/loading — the reset
    // unmounts the fulfillment mid-hardware-cycle. Countdown restarts fresh
    // when fulfillment reports done.
    if (gzBusy) return;
    setSecondsLeft(AUTO_RESET_SECONDS);
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          // Self-update if a newer deploy is live, else soft nav (keeps fullscreen).
          void resetToKiosk(() => router.replace("/kiosk"));
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
  }, [router, gzBusy]);

  return (
    <div
      // With a card-fulfillment panel the column can exceed the canvas — scroll
      // from the top instead of center-clipping.
      className={`absolute inset-0 flex flex-col items-center gap-[36px] bg-[#000418] px-[64px] text-center ${
        gzPayload || racePacks
          ? "justify-start overflow-y-auto py-[56px]"
          : "justify-center overflow-hidden"
      }`}
    >
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
      <h1 className="k-display relative text-[124px] leading-none">You&rsquo;re booked.</h1>
      <p className="relative max-w-[30ch] text-[34px] text-white/60">
        Your confirmation and check-in links were just texted and emailed to you — that&rsquo;s your
        ticket, nothing to print.
      </p>
      {racePacks && (
        <div className="relative w-full max-w-[860px] rounded-[24px] border border-[#f0b341]/40 bg-white/[0.04] p-[32px] text-left">
          <div className="k-eyebrow text-[#f0b341]">Race packs</div>
          <div className="mt-[12px] space-y-[10px]">
            {racePacks.map((p, i) => (
              <div
                key={`${p.memberName}-${i}`}
                className="flex items-center justify-between gap-[16px] rounded-2xl border border-white/12 bg-white/[0.03] px-[24px] py-[16px]"
              >
                <div className="min-w-0">
                  <div className="text-[26px] font-bold">{p.memberName}</div>
                  <div className="text-[20px] text-white/50">{p.label}</div>
                </div>
                <div className="text-right text-[22px] leading-snug">
                  {p.granted ? (
                    p.usedToday > 0 ? (
                      <span className="text-[#46d68c]">
                        {p.usedToday} race{p.usedToday === 1 ? "" : "s"} today ·{" "}
                        <span className="font-extrabold">{p.banked} banked</span>
                      </span>
                    ) : (
                      <span className="text-[#46d68c]">
                        <span className="font-extrabold">{p.raceCount} races banked</span> — ready
                        any visit
                      </span>
                    )
                  ) : (
                    <span className="text-amber-300/90">
                      Credits are loading onto their account — ready in a few minutes
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {gzPayload && (
        <KioskGzFulfillment payload={gzPayload} onBusyChange={(busy) => setGzBusy(busy)} />
      )}
      {qrDataUrl ? (
        <div className="relative rounded-[24px] bg-white p-[20px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="Check-in code" width={300} height={300} className="block" />
        </div>
      ) : null}
      {code ? (
        <div className="relative rounded-[24px] border border-white/15 bg-white/[0.04] px-[48px] py-[24px]">
          <div className="k-eyebrow text-white/45">Booking code</div>
          <div className="k-display text-[64px] tracking-widest">{code}</div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void resetToKiosk(() => router.replace("/kiosk"))}
        // k-btn-primary is flex:1 for the wizard's action ROW; here it sits in a
        // flex COLUMN, where flex:1 stretched it into a full-height arch. Reset to
        // its intended fixed height (inline wins over the .kiosk-canvas selector).
        style={{ flex: "0 0 auto" }}
        className="k-btn-primary k-tap relative mt-[16px] h-[112px] w-full max-w-[70%] text-[36px]"
      >
        Done — start over
      </button>
      <p className="relative text-[24px] text-white/40 tabular-nums">
        Returning to start in {secondsLeft}s — touch anywhere to stay
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={KIOSK_LOGOS[config?.brand ?? "fasttrax"]}
        alt=""
        className="relative h-[52px] opacity-70"
        draggable={false}
      />
    </div>
  );
}
