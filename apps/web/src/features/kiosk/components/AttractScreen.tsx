"use client";

/**
 * /kiosk attract screen ("Podium" design, owner pick 2026-07-17).
 *
 * Portrait zones: top ~25% is the advertising rotation (display-only), the
 * lower 75% is the interactive welcome (reach + ADA band). Any tap starts a
 * session. Quick chips deep-link into flows; "See everything" lands on the
 * category chooser.
 *
 * Device provisioning: on mount, URL params (parsed server-side) merge over
 * the stored device config and persist. A kiosk with no config shows the
 * one-time setup card instead of the attract loop.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  mergeKioskConfig,
  loadKioskConfig,
  saveKioskConfig,
  kioskId,
  type KioskConfig,
  type KioskVariant,
} from "../config";
import { useKioskConfig } from "../KioskConfigContext";
import { KIOSK_AD_SLIDES, KIOSK_LOGOS, KIOSK_PHOTOS } from "../assets";
import { BrandedLoader } from "./BrandedLoader";

const AD_ROTATE_MS = 8000;

export function AttractScreen({ urlConfig }: { urlConfig: Partial<KioskConfig> }) {
  const router = useRouter();
  const { config } = useKioskConfig();
  const [adIndex, setAdIndex] = useState(0);
  const [booting, setBooting] = useState(true);
  // Hidden staff gesture ref — declared with the other hooks (BEFORE any early
  // return) so hook order is stable when config transitions null→set.
  const cornerTaps = useRef<number[]>([]);

  // Boot: merge provisioning URL params over stored config; if the device has
  // no local config yet but the URL names a venue, pull the saved setup from
  // Neon by kioskId (a reimaged kiosk recovers its reader/dispenser/scanner
  // with just ?center=…&kiosk=…). saveKioskConfig notifies the store.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = loadKioskConfig();
      let merged = mergeKioskConfig(stored, urlConfig);
      // No usable local config but we know the venue → try the cloud fallback.
      if (!stored && merged?.center) {
        try {
          const id = kioskId(merged);
          const res = await fetch(`/api/kiosk/device?kioskId=${encodeURIComponent(id)}`);
          if (res.ok) {
            const { device } = await res.json();
            if (device?.config) {
              // Saved config is the base; URL params still win on top.
              merged = mergeKioskConfig(device.config as KioskConfig, urlConfig);
            }
          }
        } catch {
          /* offline / no DB — fall back to whatever the URL gave us */
        }
      }
      if (cancelled) return;
      if (merged) saveKioskConfig(merged);
      if (Object.keys(urlConfig).length > 0) {
        window.history.replaceState(null, "", "/kiosk");
      }
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [urlConfig]);

  useEffect(() => {
    const iv = setInterval(() => {
      setAdIndex((i) => (i + 1) % KIOSK_AD_SLIDES.length);
    }, AD_ROTATE_MS);
    return () => clearInterval(iv);
  }, []);

  // While the cloud fallback resolves, hold the loader instead of flashing
  // the staff setup card at a guest.
  if (booting && !config) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label="Starting up…" />
      </div>
    );
  }
  if (!config) return <SetupCard />;

  const ad = KIOSK_AD_SLIDES[adIndex];
  const start = (goto?: string) => {
    router.push(goto ? `/kiosk/flow?goto=${goto}` : "/kiosk/flow");
  };

  // Hidden staff gesture: 5 taps within 3s on the top-left corner → admin.
  const cornerHit = () => {
    const now = Date.now();
    cornerTaps.current = [...cornerTaps.current.filter((t) => now - t < 3000), now];
    if (cornerTaps.current.length >= 5) {
      cornerTaps.current = [];
      router.push("/kiosk/admin");
    }
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#000418]">
      {/* Hidden staff entry — 5 taps top-left corner → admin (no visible affordance) */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={cornerHit}
        className="absolute left-0 top-0 z-30 h-24 w-24 opacity-0"
      />
      {/* Cinematic backdrop — photo + navy scrim + light sweep (video later) */}
      <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
        <div
          className="kiosk-kenburns absolute -inset-[6%] bg-cover bg-center"
          style={{ backgroundImage: `url(${KIOSK_PHOTOS.race})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418] from-[8%] via-[#020a22]/80 to-[#040e2c]/60" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_40%_at_78%_22%,rgba(229,57,53,0.28),transparent_65%)]" />
        <div className="kiosk-sweep absolute inset-0" />
      </div>

      {/* Ad zone — top ~25%, display only (a tap anywhere still starts) */}
      <button
        type="button"
        onClick={() => start()}
        className="relative z-10 h-[25vh] w-full shrink-0 cursor-pointer overflow-hidden border-b border-white/10 text-left"
        aria-label="Start booking"
      >
        <div
          className="absolute inset-0 bg-cover bg-center opacity-90 [filter:saturate(0.78)_brightness(0.82)]"
          style={{ backgroundImage: `url(${ad.photo})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#040e2c]/60 to-[#071440]/50" />
        <div className="absolute bottom-[8%] left-[6%]">
          <div
            className="font-heading text-[1.4vh] font-bold uppercase tracking-[0.28em]"
            style={{ color: ad.accent }}
          >
            Today at the complex
          </div>
          <div className="font-heading mt-1 text-[4vh] font-extrabold italic leading-none">
            {ad.title}
          </div>
          <div className="mt-1 text-[1.8vh] text-white/55">{ad.sub}</div>
        </div>
        <div className="absolute bottom-[10%] right-[6%] flex gap-2">
          {KIOSK_AD_SLIDES.map((s, i) => (
            <span
              key={s.title}
              className={`h-[0.5vh] w-[3vh] rounded-full ${i === adIndex ? "bg-[#00e2e5]" : "bg-white/20"}`}
            />
          ))}
        </div>
      </button>

      {/* Welcome zone — lower 75% */}
      <button
        type="button"
        onClick={() => start()}
        className="relative z-10 flex flex-1 cursor-pointer flex-col items-center justify-center gap-[3.5vh] px-[6%] text-center"
        aria-label="Touch to get started"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS[config.brand]}
          alt={config.brand === "headpinz" ? "HeadPinz" : "FastTrax"}
          className="h-[13vh] w-auto object-contain [filter:drop-shadow(0_0_34px_rgba(0,226,229,0.35))]"
          draggable={false}
        />
        {config.variant === "pitcrew" ? (
          <div className="font-heading text-[10vh] font-extrabold italic leading-[0.98]">
            Hi there.
            <br />
            <span className="text-[#00e2e5]">Ready to play?</span>
          </div>
        ) : (
          <div className="font-heading bg-gradient-to-r from-[#f5ecee] from-55% to-[#00e2e5] bg-clip-text text-[13vh] font-extrabold italic leading-none text-transparent">
            Let&rsquo;s play.
          </div>
        )}
        <div className="max-w-[24ch] text-[2.6vh] text-white/55">
          {config.variant === "pitcrew"
            ? "I'll walk you through it — one quick question at a time."
            : "Book racing, bowling & attractions right here — takes about a minute."}
        </div>
        <span className="kiosk-pulse font-heading grid h-[10.5vh] w-full max-w-[80%] place-items-center rounded-full bg-[#00e2e5] text-[3.6vh] font-extrabold uppercase italic tracking-wide text-[#04252b]">
          {config.variant === "pitcrew" ? "Let's go" : "Touch to get started"}
        </span>
        <span className="flex flex-wrap items-center justify-center gap-3">
          <QuickChip label="Race now" onClick={() => start("race")} />
          <QuickChip label="Bowl now" onClick={() => start("bowl")} />
          <QuickChip label="VIP Experience" gold onClick={() => start("vip")} />
          <QuickChip label="See everything" onClick={() => start()} />
        </span>
      </button>

      <div className="relative z-10 flex h-[7vh] shrink-0 items-center justify-center gap-8 pb-[1vh]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS.fasttrax}
          alt="FastTrax"
          className="h-[3.6vh] opacity-90"
          draggable={false}
        />
        <span className="text-white/40">&times;</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS.headpinz}
          alt="HeadPinz"
          className="h-[3.3vh] opacity-90"
          draggable={false}
        />
        <span className="font-heading text-[1.5vh] font-bold uppercase tracking-[0.24em] text-white/45">
          {config.center === "naples" ? "Naples" : "Fort Myers"}
        </span>
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-20 h-[0.6vh] bg-gradient-to-r from-[#e53935] via-white/60 to-[#00e2e5]" />
    </div>
  );
}

function QuickChip({
  label,
  gold,
  onClick,
}: {
  label: string;
  gold?: boolean;
  onClick: () => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`font-heading inline-flex h-[5.5vh] items-center rounded-2xl border-2 px-6 text-[2vh] font-bold ${
        gold ? "border-[#e8b14c]/60 text-[#e8b14c]" : "border-white/15 text-white/60"
      }`}
    >
      {label}
    </span>
  );
}

/** One-time device setup when no config exists and no URL params were given. */
function SetupCard() {
  const { setConfig } = useKioskConfig();
  const [variant, setVariant] = useState<KioskVariant>("podium");

  const provision = (center: "fort-myers" | "naples", brand: "fasttrax" | "headpinz") => {
    setConfig({ center, brand, readerId: null, variant });
  };

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-10 bg-[#000418] px-10 text-center">
      <div className="font-heading text-[5vh] font-extrabold italic">Kiosk setup</div>
      <div className="max-w-[40ch] text-[2.2vh] text-white/55">
        This device has no venue configured. Pick where it lives (staff only — guests never see
        this). You can also provision via URL: /kiosk?center=fasttrax&amp;reader=DEVICE_ID
      </div>
      <div className="flex flex-col gap-4">
        <SetupButton
          label="FastTrax — Fort Myers"
          onClick={() => provision("fort-myers", "fasttrax")}
        />
        <SetupButton
          label="HeadPinz — Fort Myers"
          onClick={() => provision("fort-myers", "headpinz")}
        />
        <SetupButton label="HeadPinz — Naples" onClick={() => provision("naples", "headpinz")} />
      </div>
      <div className="flex items-center gap-4 text-[1.8vh] text-white/55">
        <span>Design variant:</span>
        {(["podium", "pitcrew"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVariant(v)}
            className={`rounded-full border-2 px-5 py-2 font-heading font-bold uppercase ${
              variant === v ? "border-[#00e2e5] text-[#00e2e5]" : "border-white/15 text-white/50"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function SetupButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-heading h-[8vh] min-w-[46vh] rounded-2xl border-2 border-[#00e2e5]/50 px-10 text-[2.6vh] font-bold italic text-white transition-colors hover:bg-[#00e2e5]/10"
    >
      {label}
    </button>
  );
}
