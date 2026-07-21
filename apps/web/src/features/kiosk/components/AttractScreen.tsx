"use client";

/**
 * /kiosk attract screen ("Podium" design, owner pick 2026-07-17).
 *
 * Authored to the fixed 1080×1920 kiosk canvas (px, not vh). Portrait zones:
 * top 480px is the advertising rotation (display-only), the rest is the
 * interactive welcome (reach + ADA band). Any tap starts a session (landing
 * on the category chooser); quick chips deep-link into specific flows.
 *
 * Device provisioning: on mount, URL params (parsed server-side) merge over
 * the stored device config and persist. A kiosk with no config shows the
 * one-time setup card instead of the attract loop.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSignature, IconUserCheck } from "@tabler/icons-react";
import {
  mergeKioskConfig,
  loadKioskConfig,
  saveKioskConfig,
  kioskDeviceKey,
  venueSlug,
  type KioskConfig,
} from "../config";
import { kioskGroupWaiverEnabled, kioskCheckinEnabled } from "../flags";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskAdSlidesFor, KIOSK_LOGOS, KIOSK_PHOTOS } from "../assets";
import { BrandedLoader } from "./BrandedLoader";
import { useKioskClock, syncGlowPhase } from "../hooks/useKioskClock";
import { useKioskAvailability } from "../hooks/useKioskAvailability";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import { captureKioskBootVersion, kioskUpdateAvailable } from "../version";
import { DeviceCheckCard } from "./DeviceCheckCard";
import { clickableDivProps } from "@/lib/a11y";

const AD_ROTATE_MS = 8000;

export function AttractScreen({ urlConfig }: { urlConfig: Partial<KioskConfig> }) {
  const router = useRouter();
  const { config } = useKioskConfig();
  const [adIndex, setAdIndex] = useState(0);
  const [booting, setBooting] = useState(true);
  // Transient boot confirmation: when the kiosk loads via its provisioning URL
  // (slug + number), briefly show which venue/kiosk it resolved and the devices
  // in that config, so staff can eyeball that the right setup loaded. Auto-hides
  // after 30s (or on tap); never blocks the attract loop underneath.
  const [bootInfo, setBootInfo] = useState<KioskConfig | null>(null);
  // Shared wall-clock so every kiosk shows the same ad slide + glow phase at the
  // same instant (owner 2026-07-19). serverNow = Date.now() + offset.
  const { offset } = useKioskClock();
  // Hidden staff gesture ref — declared with the other hooks (BEFORE any early
  // return) so hook order is stable when config transitions null→set.
  const cornerTaps = useRef<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  // Lock the VIP quick-chip when the combo can't actually be booked today
  // (cached server-side; see useKioskAvailability).
  const vipAvailable = useKioskAvailability(config?.center ?? null)("race-bowl");
  // Center-scoped rotation — Naples never advertises karting.
  const adSlides = kioskAdSlidesFor(config?.center ?? null);

  // Boot source-of-truth rule (owner 2026-07-21): NEON is authoritative
  // whenever the kiosk knows WHO it is — identity from the launch URL
  // (`?center=HPFM&kiosk=3`) or, failing that, from the saved local config
  // (start-over / idle returns land on bare /kiosk but the device still knows
  // itself). localStorage is only the fallback when Neon has no row or is
  // unreachable, so an overnight reboot during a DB blip never bricks.
  // The URL is then rewritten to the CANONICAL launch form (identity kept, not
  // stripped) so hard reloads — e.g. the idle self-update — stay
  // cloud-authoritative too (owner: "is it losing that on start over?").
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = loadKioskConfig();
      const hasUrlIdentity = urlConfig.center != null && urlConfig.kioskNumber != null;
      let resolved = mergeKioskConfig(stored, urlConfig);

      // Who is this kiosk? URL wins; otherwise the saved local identity.
      const urlIdentity = hasUrlIdentity ? mergeKioskConfig(null, urlConfig) : null;
      const identity = urlIdentity ?? stored;
      if (identity) {
        try {
          const id = kioskDeviceKey(identity);
          const res = await fetch(`/api/kiosk/device?kioskId=${encodeURIComponent(id)}`);
          const device = res.ok ? (await res.json()).device : null;
          resolved = device?.config
            ? mergeKioskConfig(device.config as KioskConfig, urlConfig) // Neon wins
            : stored
              ? mergeKioskConfig(stored, urlConfig) // no cloud row → local cache
              : urlIdentity; // nothing saved anywhere → bare URL identity
        } catch {
          resolved = stored ? mergeKioskConfig(stored, urlConfig) : urlIdentity; // DB down → cache
        }
      }

      if (cancelled) return;
      if (resolved) saveKioskConfig(resolved);
      // Show the boot confirmation (which re-runs the device tests) when this
      // load carried the provisioning identity, OR when staff just exited the
      // admin (a one-shot sessionStorage flag) — never on a plain guest return
      // to /kiosk.
      let exitedAdmin = false;
      try {
        exitedAdmin = sessionStorage.getItem("kioskBootCheck") === "1";
        if (exitedAdmin) sessionStorage.removeItem("kioskBootCheck");
      } catch {
        /* sessionStorage unavailable — ignore */
      }
      if ((hasUrlIdentity || exitedAdmin) && resolved) setBootInfo(resolved);
      // Keep the identity IN the URL (canonical launch form) instead of
      // stripping it — the next hard reload re-pulls Neon.
      if (resolved) {
        window.history.replaceState(
          null,
          "",
          `/kiosk?center=${venueSlug(resolved)}&kiosk=${resolved.kioskNumber ?? 1}`,
        );
      } else if (Object.keys(urlConfig).length > 0) {
        window.history.replaceState(null, "", "/kiosk");
      }
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [urlConfig]);

  // Auto-hide the boot confirmation after 30s (timer callback, not a sync
  // effect body — clearing on unmount/tap is fine).
  useEffect(() => {
    if (!bootInfo) return;
    const t = setTimeout(() => setBootInfo(null), 30_000);
    return () => clearTimeout(t);
  }, [bootInfo]);

  // Ad index derived from the SHARED clock (not a local counter) so every kiosk
  // is on the same slide. Each tick schedules the next just past the shared 8s
  // boundary, so the flip lands within ~a frame of the same instant everywhere
  // (the old fixed 500ms poll let flips straggle up to half a second apart
  // between kiosks — owner 2026-07-19: "ads are really close but not perfect").
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      const now = Date.now() + offset;
      setAdIndex(Math.floor(now / AD_ROTATE_MS) % adSlides.length);
      // +25ms lands safely past the boundary despite setTimeout clamp/rounding.
      timer = window.setTimeout(tick, AD_ROTATE_MS - (now % AD_ROTATE_MS) + 25);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [offset, adSlides.length]);

  // Seek the glow / ken-burns / sweep / pulse animations to the shared clock's
  // phase so all kiosks breathe together. Re-runs whenever the clock (re)syncs
  // AND whenever the attract root can (re)mount — config null→set and
  // booting→false both change which tree is rendered, and a freshly mounted
  // root starts its animations at a random phase until seeked.
  useEffect(() => {
    syncGlowPhase(rootRef.current, offset);
  }, [offset, config, booting]);

  // Self-update while IDLE: the between-guest reset check (version.ts) only
  // fires when a session ends, so a kiosk parked on attract overnight keeps
  // serving the old build indefinitely. Attract = nobody mid-anything, so a
  // hard reload is always safe here. Capture the boot version (idempotent),
  // then check every 5 min; reload when a newer deploy is live (owner asked
  // 2026-07-19 "when on this page does it check for updates?" — now).
  useEffect(() => {
    void captureKioskBootVersion();
    const t = setInterval(() => {
      void kioskUpdateAvailable().then((update) => {
        if (update) window.location.reload();
      });
    }, 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  // While the cloud fallback resolves, hold the loader instead of flashing
  // the staff setup card at a guest.
  if (booting && !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand="fasttrax" label="Starting up…" />
      </div>
    );
  }
  if (!config) return <SetupCard />;

  // Modulo again: adIndex may have been computed against the other center's
  // slide count for one render right after the config resolves.
  const slideIndex = adIndex % adSlides.length;
  const ad = adSlides[slideIndex];
  const start = (goto?: string) => {
    // Kiosk funnel top: a guest engaged the attract screen. The entry tag says
    // which chip (or "all" for a plain touch) so conversions trace to it.
    clarityTag("kiosk_entry", goto ?? "all");
    clarityEvent("kiosk:attract:engage");
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
    <div ref={rootRef} className="absolute inset-0 flex flex-col overflow-hidden bg-[#000418]">
      {/* Hidden staff entry — 5 taps top-left corner → admin (no visible affordance) */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={cornerHit}
        className="absolute left-0 top-0 z-30 h-[120px] w-[120px] opacity-0"
      />
      {bootInfo && <BootInfoOverlay config={bootInfo} onDismiss={() => setBootInfo(null)} />}
      {/* Cinematic backdrop — photo + navy scrim + red glow + light sweep */}
      <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
        {/* HeadPinz is a bowling brand (FM + Naples) — its attract backdrop is
            the lanes; FastTrax leads with the track. */}
        <div
          className="kiosk-kenburns absolute -inset-[6%] bg-cover bg-center"
          style={{
            backgroundImage: `url(${config.brand === "headpinz" ? KIOSK_PHOTOS.bowl : KIOSK_PHOTOS.race})`,
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418] from-[8%] via-[#020a22]/80 to-[#040e2c]/60" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_40%_at_78%_22%,rgba(229,57,53,0.28),transparent_65%),radial-gradient(55%_42%_at_18%_80%,rgba(0,226,229,0.22),transparent_62%)]" />
        <div className="kiosk-sweep absolute inset-0" />
      </div>

      {/* Ad zone — top 480px, display only (a tap anywhere still starts) */}
      <button
        type="button"
        onClick={() => start()}
        className="relative z-10 h-[480px] w-full shrink-0 cursor-pointer overflow-hidden border-b border-white/10 text-left"
        aria-label="Start booking"
      >
        <div
          className="absolute inset-0 bg-cover bg-center opacity-90 [filter:saturate(0.78)_brightness(0.82)]"
          style={{ backgroundImage: `url(${ad.photo})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#040e2c]/60 to-[#071440]/50" />
        {/* FastTrax only: the race car zips along the bottom edge once per
            slide (behind the title text — rendered before it). Clock-locked
            like the other glow fx, but STAGGERED per kioskNumber so the bank
            of kiosks hands the car off screen-to-screen, highest number →
            lowest (right to left, matching the physical lineup): each kiosk
            starts its 2s crossing 2s after the next-higher one. 4 crossings
            fill the 8s cycle, so numbers wrap mod 4 if there are ever >4. */}
        {config.brand === "fasttrax" && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={KIOSK_PHOTOS.raceCar}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-glow-phase-ms={(((config.kioskNumber ?? 1) - 1) % 4) * 2000}
            className="kiosk-racecar pointer-events-none absolute bottom-[10px] left-full h-[90px] w-auto max-w-none"
          />
        )}
        {/* Title/sub + pips sit ABOVE the race car's lane (car: bottom 10px,
            90px tall → clears ~100px) so the crossing never covers the copy. */}
        <div className="absolute bottom-[120px] left-[64px]">
          <div className="k-display text-[64px]">{ad.title}</div>
          <div className="mt-[8px] text-[28px] text-white/60">{ad.sub}</div>
        </div>
        <div className="absolute bottom-[124px] right-[64px] flex gap-[10px]">
          {/* Index key: slide titles repeat (two "SKIP THE LINE" ads) */}
          {adSlides.map((s, i) => (
            <span
              key={i}
              className={`h-[10px] w-[56px] rounded-full ${i === slideIndex ? "bg-[#00e2e5]" : "bg-white/20"}`}
            />
          ))}
        </div>
      </button>

      {/* Welcome zone */}
      <button
        type="button"
        onClick={() => start()}
        className="relative z-10 flex flex-1 cursor-pointer flex-col items-center justify-center gap-[56px] px-[64px] text-center"
        aria-label="Touch to get started"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS[config.brand]}
          alt={config.brand === "headpinz" ? "HeadPinz" : "FastTrax"}
          className="h-[220px] w-auto object-contain [filter:drop-shadow(0_0_34px_rgba(0,226,229,0.35))]"
          draggable={false}
        />
        <div className="k-display bg-gradient-to-r from-[#f5ecee] from-55% to-[#00e2e5] bg-clip-text text-[150px] text-transparent">
          Let&rsquo;s play.
        </div>
        <div className="max-w-[24ch] text-[34px] text-white/60">
          {config.center === "naples"
            ? "Book bowling, blasters & laser tag right here — takes about a minute."
            : "Book racing, bowling & attractions right here — takes about a minute."}
        </div>
        <span className="kiosk-pulse k-display grid h-[150px] w-full max-w-[80%] place-items-center rounded-full bg-[#00e2e5] text-[44px] tracking-wide text-[#04252b]">
          Touch to get started
        </span>
        {/* 2-col grid kept for the hidden "Race now" / "Bowl now" pair; the
            remaining chips span both columns so nothing sits orphaned at
            half-width. */}
        <span className="grid w-full max-w-[720px] grid-cols-2 gap-[16px]">
          {/* "Race now" / "Bowl now" HIDDEN for now (owner 2026-07-18: "just
              hide, might come back later") — restore by uncommenting:
          <QuickChip label="Race now" onClick={() => start("race")} />
          <QuickChip label="Bowl now" onClick={() => start("bowl")} /> */}
          {/* "See everything" REMOVED (owner 2026-07-19) — the category chooser
              is still reachable via "Touch to get started" / any tap. */}
          <span className="col-span-2">
            <QuickChip
              label="VIP Experience"
              gold
              disabled={!vipAvailable}
              onClick={() => start("vip")}
            />
          </span>
          {/* Standalone race packs (owner 2026-07-18) — FastTrax kiosks, a
              LOCKED pack-only purchase flow (KioskRacePackFlow). Full-width so
              the 2×2 grid never orphans a chip. Kill switch aware. */}
          {kioskRacePacksEnabled() && config.brand === "fasttrax" && (
            <span className="col-span-2">
              <QuickChip label="Race packs — from $49.99" gold onClick={() => start("packs")} />
            </span>
          )}
        </span>
      </button>

      {/* Online & group waiver entry — full-width bar above the footer band
          ("bottom of this screen", owner 2026-07-18). A "not booking"
          affordance, so it sits OUTSIDE the welcome-zone start button. OPT-IN
          flag, default OFF (owner 2026-07-19) — set
          NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED=true in Vercel to show. */}
      {kioskGroupWaiverEnabled() && (
        <button
          type="button"
          onClick={() => {
            clarityEvent("kiosk:waiver:open");
            router.push("/kiosk/waiver");
          }}
          className="k-display k-tap relative z-10 mx-[64px] mb-[8px] flex h-[92px] shrink-0 items-center justify-center gap-[16px] rounded-2xl border-2 border-white/15 text-[30px] text-white/60"
        >
          <IconSignature size={34} aria-hidden="true" />
          Online &amp; Group Waiver
        </button>
      )}

      {/* Self-service check-in entry — full-width bar for guests who already
          booked. A "not booking" affordance, so it sits OUTSIDE the welcome-zone
          start button. OPT-IN flag, default OFF — set
          NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED=true in Vercel to show. */}
      {kioskCheckinEnabled() && (
        <button
          type="button"
          onClick={() => router.push("/kiosk/checkin")}
          className="k-display k-tap relative z-10 mx-[64px] mb-[8px] flex h-[92px] shrink-0 items-center justify-center gap-[16px] rounded-2xl border-2 border-[#00e2e5]/40 text-[30px] text-[#00e2e5]"
        >
          <IconUserCheck size={34} aria-hidden="true" />
          Checking in? Start here
        </button>
      )}

      <div className="relative z-10 flex h-[130px] shrink-0 items-center justify-center gap-[32px] pb-[16px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS.fasttrax}
          alt="FastTrax"
          className="h-[56px] opacity-90"
          draggable={false}
        />
        <span className="text-[28px] text-white/40">&times;</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={KIOSK_LOGOS.headpinz}
          alt="HeadPinz"
          className="h-[52px] opacity-90"
          draggable={false}
        />
        <span className="k-eyebrow text-white/45">
          {config.center === "naples" ? "Naples" : "Fort Myers"}
        </span>
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-20 h-[10px] bg-gradient-to-r from-[#e53935] via-white/60 to-[#00e2e5]" />
    </div>
  );
}

function QuickChip({
  label,
  gold,
  disabled,
  onClick,
}: {
  label: string;
  gold?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <span
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      className={`k-display flex h-[92px] w-full items-center justify-center rounded-2xl border-2 px-[32px] text-[30px] ${
        disabled
          ? "border-white/10 text-white/25"
          : gold
            ? "border-[#e8b14c]/60 text-[#e8b14c]"
            : "border-white/15 text-white/60"
      }`}
    >
      {label}
    </span>
  );
}

/**
 * Transient staff boot confirmation — the shared DeviceCheckCard (venue +
 * device tests) in a top overlay that auto-hides after 30s and dismisses on
 * tap. Positioned at the top so it never blocks the "tap to start" area, and
 * stops its own tap from starting a guest session.
 */
function BootInfoOverlay({ config, onDismiss }: { config: KioskConfig; onDismiss: () => void }) {
  return (
    <div
      {...clickableDivProps((e) => {
        e.stopPropagation();
        onDismiss();
      }, "Dismiss boot check")}
      className="absolute left-1/2 top-6 z-50 w-[92%] max-w-[560px] -translate-x-1/2 cursor-pointer rounded-2xl border border-[#00e2e5]/40 bg-[#0a1730]/95 p-5 text-left shadow-2xl backdrop-blur"
    >
      <DeviceCheckCard config={config} />
      <div className="mt-2 text-xs text-white/45">
        Boot check — tap to dismiss (auto-hides in 30s).
      </div>
    </div>
  );
}

/** One-time device setup when no config exists and no URL params were given. */
function SetupCard() {
  const { setConfig } = useKioskConfig();

  const provision = (center: "fort-myers" | "naples", brand: "fasttrax" | "headpinz") => {
    setConfig({ center, brand, readerId: null, variant: "podium" });
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[48px] bg-[#000418] px-[64px] text-center">
      <div className="k-display text-[80px]">Kiosk setup</div>
      <div className="max-w-[40ch] text-[34px] text-white/55">
        This device has no venue configured. Pick where it lives (staff only — guests never see
        this). You can also provision via URL: /kiosk?center=fasttrax&amp;reader=DEVICE_ID
      </div>
      <div className="flex flex-col gap-[20px]">
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
    </div>
  );
}

function SetupButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="k-display h-[130px] min-w-[720px] rounded-2xl border-2 border-[#00e2e5]/50 px-[48px] text-[42px] text-white transition-colors hover:bg-[#00e2e5]/10"
    >
      {label}
    </button>
  );
}
