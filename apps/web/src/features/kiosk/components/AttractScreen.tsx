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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconFlag, IconSignature, IconUserCheck } from "@tabler/icons-react";
import {
  mergeKioskConfig,
  loadKioskConfig,
  saveKioskConfig,
  kioskDeviceKey,
  venueSlug,
  type KioskConfig,
} from "../config";
import {
  kioskGroupWaiverEnabled,
  kioskCheckinEnabled,
  kioskRaceInfoEnabled,
  kioskBillboardEnabled,
  kioskWelcomeRotateEnabled,
} from "../flags";
import { bankPosition, BILLBOARD_SLIDES } from "../attract/billboard";
import { AttractBillboard } from "./AttractBillboard";
import { AttractHeadline } from "./AttractHeadline";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { useKioskConfig } from "../KioskConfigContext";
import { useT, LanguageSwitcher } from "../i18n";
import { kioskAdSlidesFor, KIOSK_PHOTOS } from "../assets";
import { useResilientImages } from "../hooks/useResilientImage";
import { BrandLogo } from "./BrandLogo";
import { BrandedLoader } from "./BrandedLoader";
import { useKioskClock, syncGlowPhase } from "../hooks/useKioskClock";
import { ATTRACT_POLL_MS, useKioskAvailability } from "../hooks/useKioskAvailability";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import { captureKioskBootVersion, kioskUpdateAvailable } from "../version";
import { DeviceCheckCard } from "./DeviceCheckCard";
import { clickableDivProps } from "@/lib/a11y";

const AD_ROTATE_MS = 8000;

export function AttractScreen({ urlConfig }: { urlConfig: Partial<KioskConfig> }) {
  const router = useRouter();
  const { config } = useKioskConfig();
  const t = useT();
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
  // (cached server-side; see useKioskAvailability). The attract loop runs 24/7
  // on every idle kiosk, so it polls on the slow interval — enough to keep the
  // chip honest without keeping the vendor recompute warm around the clock.
  const vipAvailable = useKioskAvailability(config?.center ?? null, {
    pollMs: ATTRACT_POLL_MS,
  }).available("race-bowl");
  // Center-scoped rotation — Naples never advertises karting.
  const adSlides = kioskAdSlidesFor(config?.center ?? null);

  // Self-heal the attract photos (backdrop + rotating ad slides) if a flaky-WiFi
  // fetch fails — they're CSS background-images, which never retry on their own,
  // so on an unattended kiosk a single failed load otherwise blanks the attract
  // loop until a reload. Both backdrops are healed (brand may not be known yet).
  const resolvePhoto = useResilientImages([
    KIOSK_PHOTOS.bowl,
    KIOSK_PHOTOS.race,
    ...adSlides.map((s) => s.photo),
    // The race car is an <img> in the headline layout (it crosses the word),
    // and the billboard photos are rendered by AttractHeadline rather than by
    // AttractBillboard there — so both need healing from THIS list too.
    KIOSK_PHOTOS.raceCar,
    ...(config ? BILLBOARD_SLIDES[venueSlug(config)].map((s) => s.photo) : []),
  ]);

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
  //
  // adIndex is in here because of the HEADLINE layout: its vehicle is chosen by
  // the SLIDE (car on racing, ball on bowling, nothing on gel/Game Zone), so a
  // new element mounts mid-loop every rotation and would start at a random
  // phase — the bank visibly falls out of step after the first crossing. The
  // ad-zone layout mounted one vehicle per BRAND at root mount, so it never
  // needed this. Seeking is idempotent (every target is derived from the same
  // shared clock), so re-running it on a slide flip costs a querySelectorAll
  // and cannot introduce a jump.
  useEffect(() => {
    syncGlowPhase(rootRef.current, offset);
  }, [offset, config, booting, adIndex]);

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
        <BrandedLoader brand="fasttrax" label={t("attract.startingUp")} />
      </div>
    );
  }
  if (!config) return <SetupCard />;

  // Modulo again: adIndex may have been computed against the other center's
  // slide count for one render right after the config resolves.
  const ad = adSlides[adIndex % adSlides.length];
  // Car / ball (and the banner-text rumble they cause) are STAGGERED by
  // PHYSICAL bank position — not kioskNumber math — so the handoff travels
  // down the actual row. FT is banked in number order (identity), but HPFM
  // runs 3·2·6·1·4 and Naples 10·9·7·8 (owner 2026-07-26); see
  // attract/billboard.ts. A kiosk missing from the map still gets a stable
  // number-derived phase for its own banner crossing (the crossing is
  // per-screen scenery, unlike the bank-wide billboard, which excludes it).
  const bankPos = bankPosition(venueSlug(config), config.kioskNumber ?? 1);
  const carPhaseMs = ((bankPos ?? (config.kioskNumber ?? 1) - 1) % 4) * 2000;
  // Per-device attract layout; "headline" is the default for a config that
  // predates the field (resolveKioskConfig backfills it on read).
  const attractLayout = config.attractLayout ?? "headline";
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
      {/* Language switcher. Its default slot (top-[500px]) was tuned to sit just
          BELOW the 480px ad zone — with that gone in the headline layout it
          floated over the logo and read as debris, so there it moves into the
          footer band instead, beside the venue name where the rest of the
          chrome lives. The ad-zone layout keeps the original placement. */}
      <LanguageSwitcher
        posClass={attractLayout === "headline" ? "right-[32px] bottom-[34px]" : undefined}
      />
      {/* Hidden staff entry — 5 taps top-left corner → admin (no visible affordance) */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={cornerHit}
        className="absolute left-0 top-0 z-30 h-[120px] w-[120px] opacity-0"
      />
      {bootInfo && <BootInfoOverlay config={bootInfo} onDismiss={() => setBootInfo(null)} />}

      {/* Attract layout (per-device, owner 2026-07-28). "headline" is the
          default: no ad zone, no primary button, video backdrop, and the
          billboard drives the headline instead of overlaying the screen.
          "adzone" is the previous layout, kept verbatim below. */}
      {attractLayout === "headline" ? (
        <AttractHeadline
          config={config}
          slide={ad}
          slides={adSlides}
          index={adIndex % adSlides.length}
          offset={offset}
          vipAvailable={vipAvailable}
          resolvePhoto={resolvePhoto}
          onStart={start}
        />
      ) : (
        <>
          {/* Cinematic backdrop — photo + navy scrim + red glow + light sweep */}
          <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
            {/* HeadPinz is a bowling brand (FM + Naples) — its attract backdrop is
            the lanes; FastTrax leads with the track. */}
            <div
              className="kiosk-kenburns absolute -inset-[6%] bg-cover bg-center"
              style={{
                backgroundImage: `url(${resolvePhoto(config.brand === "headpinz" ? KIOSK_PHOTOS.bowl : KIOSK_PHOTOS.race)})`,
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#000418] from-[8%] via-[#020a22]/80 to-[#040e2c]/60" />
            <div className="absolute inset-0 bg-[radial-gradient(60%_40%_at_78%_22%,rgba(229,57,53,0.28),transparent_65%),radial-gradient(55%_42%_at_18%_80%,rgba(0,226,229,0.22),transparent_62%)]" />
            <div className="kiosk-sweep absolute inset-0" />
          </div>

          {/* Ad zone — top 480px, display only (a tap anywhere still starts).
          v2 "doors" (owner 2026-07-21): centered neon "<X> STARTS HERE"
          headline + "TOUCH ANYWHERE …" marquee banner riding the car lane.
          The slide accent drives the tube glow, banner border, beacon dots,
          and accent text. No pips, no sub-copy — sign + banner make one
          sentence. */}
          <button
            type="button"
            onClick={() => start()}
            className="relative z-10 h-[480px] w-full shrink-0 cursor-pointer overflow-hidden border-b border-white/10 text-left"
            aria-label="Start booking"
          >
            <div
              className="absolute inset-0 bg-cover bg-center opacity-90 [filter:saturate(0.78)_brightness(0.82)]"
              style={{ backgroundImage: `url(${resolvePhoto(ad.photo)})` }}
            />
            {/* Darker scrim than v1 — the neon headline needs the extra ground. */}
            <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#020a1e]/80 to-[#040a24]/70" />
            <NeonAdTitle title={ad.title} accent={ad.accent} />
            {/* Red standout line above the headline (Mega Tuesday junior rule) —
            always red, independent of the slide accent. bottom-[310px] clears
            the headline, which renders TWO lines tall in practice (title top
            ≈ 272px from the zone bottom) despite NeonAdTitle's nowrap intent —
            228px overlapped it (owner screenshot 2026-07-21). */}
            {ad.notice && (
              <div className="absolute bottom-[310px] left-1/2 -translate-x-1/2">
                <div className="whitespace-nowrap rounded-full border-2 border-[#e53935] bg-[rgba(0,4,24,0.82)] px-[30px] py-[12px] text-[30px] font-bold text-[#ff5a52] shadow-[0_0_28px_rgba(229,57,53,0.45)]">
                  {ad.notice}
                </div>
              </div>
            )}
            {/* Marquee banner on the bottom 100px — the strip the car crosses. */}
            <div
              className="absolute inset-x-0 bottom-0 flex h-[100px] items-center justify-center gap-[26px] overflow-hidden border-t-[3px] shadow-[0_-12px_44px_rgba(0,0,0,0.45)]"
              style={{
                borderColor: ad.accent,
                backgroundImage: `linear-gradient(90deg, ${withAlpha(ad.accent, 0.16)}, rgba(0,4,24,0.88) 45%, rgba(0,4,24,0.88) 55%, ${withAlpha(ad.accent, 0.16)})`,
                backgroundColor: "rgba(0,4,24,0.82)",
              }}
            >
              <span className="kiosk-ad-sheen absolute inset-0" aria-hidden="true" />
              <BannerDot accent={ad.accent} />
              {/* FastTrax: the text rattles while the car drives over it — same 8s
              cycle AND the same per-kiosk stagger as the car, so the rumble
              tracks this kiosk's own crossing, not the bank's. */}
              {/* Both brands now run a banner crossing (FT car / HP ball), so the
              rumble tracks this kiosk's own crossing on either brand. */}
              <div
                className="k-display kiosk-ad-rumble text-[42px]"
                data-glow-phase-ms={carPhaseMs}
              >
                {t("attract.touchAnywhere")}{" "}
                <span style={{ color: ad.accent }}>{ad.bannerAction}</span>
              </div>
              <BannerDot accent={ad.accent} />
            </div>
            {/* FastTrax only: the race car drives ALONG the banner (rendered after
            it → on top, like it's the road) once per slide. Clock-locked like
            the other glow fx, but STAGGERED per kioskNumber so the bank of
            kiosks hands the car off screen-to-screen, highest number → lowest
            (right to left, matching the physical lineup): each kiosk starts
            its 2s crossing 2s after the next-higher one. 4 crossings fill the
            8s cycle, so numbers wrap mod 4 if there are ever >4. */}
            {config.brand === "fasttrax" && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={KIOSK_PHOTOS.raceCar}
                alt=""
                aria-hidden="true"
                draggable={false}
                data-glow-phase-ms={carPhaseMs}
                className="kiosk-racecar pointer-events-none absolute bottom-[8px] left-full h-[90px] w-auto max-w-none"
              />
            )}
            {/* HeadPinz: the bowling ball rolls the banner — the brand's mirror of
            the FastTrax car (owner 2026-07-26). Outer span translates on the
            shared clock with the same per-kiosk stagger; inner sprite spins. */}
            {config.brand === "headpinz" && (
              <span
                aria-hidden="true"
                data-glow-phase-ms={carPhaseMs}
                className="kiosk-bowlball pointer-events-none absolute bottom-[8px] left-full"
              >
                <span className="kiosk-bowlball-sprite" />
              </span>
            )}
          </button>

          {/* Welcome zone */}
          <button
            type="button"
            onClick={() => start()}
            className="relative z-10 flex flex-1 cursor-pointer flex-col items-center justify-center gap-[56px] px-[64px] text-center"
            aria-label="Touch to get started"
          >
            <BrandLogo
              brand={config.brand}
              alt={config.brand === "headpinz" ? "HeadPinz" : "FastTrax"}
              className="h-[220px] w-auto object-contain [filter:drop-shadow(0_0_34px_rgba(0,226,229,0.35))]"
              fallbackClassName="k-display text-[120px] leading-none text-white [filter:drop-shadow(0_0_34px_rgba(0,226,229,0.35))]"
            />
            <RotatingWelcome brand={config.brand} offset={offset} />
            <div className="max-w-[24ch] text-[34px] text-white/60">
              {config.center === "naples"
                ? t("attract.subtitle.bowling")
                : t("attract.subtitle.racing")}
            </div>
            <span className="kiosk-pulse k-display grid h-[150px] w-full max-w-[80%] place-items-center rounded-full bg-[#00e2e5] text-[44px] tracking-wide text-[#04252b]">
              {t("attract.touchToStart")}
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
                  label={t("attract.vipExperience")}
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
                  <QuickChip
                    label={t("attract.racePacks", { price: "$49.99" })}
                    gold
                    onClick={() => start("packs")}
                  />
                </span>
              )}
            </span>
          </button>
        </>
      )}

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
          {t("attract.waiver")}
        </button>
      )}

      {/* Self-service check-in + race-info entries — "not booking" affordances,
          so they sit OUTSIDE the welcome-zone start button. One flex row: with
          both flags on they sit side by side; with one on it spans full width
          (owner 2026-07-21). Both OPT-IN, default OFF — set
          NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED / NEXT_PUBLIC_KIOSK_RACE_INFO_ENABLED
          to "true" in Vercel to show. BOTH are Fort-Myers-only (the two FM
          venues share center "fort-myers") — racing never advertises at Naples
          (owner 2026-07-25). */}
      {config.center === "fort-myers" && (kioskCheckinEnabled() || kioskRaceInfoEnabled()) && (
        <div className="relative z-10 mx-[64px] mb-[8px] flex shrink-0 gap-[16px]">
          {kioskCheckinEnabled() && (
            <button
              type="button"
              onClick={() => router.push("/kiosk/checkin")}
              className="k-tap flex h-[92px] flex-1 flex-col items-center justify-center rounded-2xl border-2 border-[#00e2e5]/40 text-[#00e2e5]"
            >
              <span className="k-display flex items-center gap-[14px] text-[30px]">
                <IconUserCheck size={30} aria-hidden="true" />
                {t("attract.raceReservation")}
              </span>
              <span className="text-[19px] text-[#00e2e5]/70">
                {t("attract.raceReservationSub")}
              </span>
            </button>
          )}
          {kioskRaceInfoEnabled() && config.center === "fort-myers" && (
            <button
              type="button"
              onClick={() => {
                clarityEvent("kiosk:raceinfo:open");
                router.push("/kiosk/race-info");
              }}
              className="k-tap flex h-[92px] flex-1 flex-col items-center justify-center rounded-2xl border-2 border-[#e53935]/50 text-[#ff6b6b]"
            >
              <span className="k-display flex items-center gap-[14px] text-[30px]">
                <IconFlag size={30} aria-hidden="true" />
                {t("attract.raceGrid")}
              </span>
              <span className="text-[19px] text-[#ff6b6b]/70">{t("attract.raceGridSub")}</span>
            </button>
          )}
        </div>
      )}

      <div className="relative z-10 flex h-[130px] shrink-0 items-center justify-center gap-[32px] pb-[16px]">
        <BrandLogo
          brand="fasttrax"
          alt="FastTrax"
          className="h-[56px] opacity-90"
          fallbackClassName="k-display text-[28px] leading-none text-white/90"
        />
        <span className="text-[28px] text-white/40">&times;</span>
        <BrandLogo
          brand="headpinz"
          alt="HeadPinz"
          className="h-[52px] opacity-90"
          fallbackClassName="k-display text-[28px] leading-none text-white/90"
        />
        <span className="k-eyebrow text-white/45">
          {config.center === "naples" ? "Naples" : "Fort Myers"}
        </span>
      </div>

      {/* Bank billboard takeover — HeadPinz, clock-locked, defaults ON at
          HPFM (owner 2026-07-26). pointer-events-none: taps fall through to
          the welcome zone and start a session normally. Rendered BEFORE the
          bottom strip so the brand gradient stays visible during the show. */}
      {/* AD-ZONE LAYOUT ONLY. The headline layout integrates the same
          choreography directly (AttractHeadline drives its own headline and
          backdrop off billboardPhase), so mounting this on top of it would
          re-introduce the veil and the text-on-text bleed it exists to hide. */}
      {attractLayout === "adzone" &&
        config.brand === "headpinz" &&
        kioskBillboardEnabled(venueSlug(config)) && (
          <AttractBillboard
            venue={venueSlug(config)}
            kioskNumber={config.kioskNumber ?? 1}
            offset={offset}
          />
        )}

      <div className="absolute bottom-0 left-0 right-0 z-20 h-[10px] bg-gradient-to-r from-[#e53935] via-white/60 to-[#00e2e5]" />
    </div>
  );
}

const WELCOME_PERIOD_MS = 4000;
const WELCOME_FADE_MS = 450;

/**
 * Rotating welcome line — "Let's play." / "Let's bowl." / "Let's party."
 * (HeadPinz) and play/race/bowl (FastTrax), owner 2026-07-26. The index is
 * derived from the SHARED wall clock (like the ad rotation), so the whole
 * bank swaps words together; each swap fades out/in over 450ms. Kill switch
 * pins the static "Let's play."
 */
function RotatingWelcome({ brand, offset }: { brand: KioskConfig["brand"]; offset: number }) {
  const rotate = kioskWelcomeRotateEnabled();
  const t = useT();
  // t is useCallback'd on the locale, so a language switch re-derives the
  // list (and re-schedules the timers) without churning every render.
  const phrases = useMemo(
    () =>
      brand === "headpinz"
        ? [t("attract.letsPlay"), t("attract.letsBowl"), t("attract.letsParty")]
        : [t("attract.letsPlay"), t("attract.letsRace"), t("attract.letsBowl")],
    [brand, t],
  );
  // Clock-aligned from the very first paint (lazy initializer, not an
  // effect) — mount-time offset is the cached localStorage sync, which is
  // plenty for a 4s cycle; ticks below re-derive from the live offset.
  const [idx, setIdx] = useState(() =>
    typeof window === "undefined"
      ? 0
      : Math.floor((Date.now() + offset) / WELCOME_PERIOD_MS) % phrases.length,
  );
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!rotate) return;
    let fade: number | undefined;
    let timer: number | undefined;
    const scheduleNext = (nowMs: number) =>
      // +25ms lands safely past the boundary despite setTimeout clamp/rounding
      // (same trick as the ad-rotation tick above).
      window.setTimeout(tick, WELCOME_PERIOD_MS - (nowMs % WELCOME_PERIOD_MS) + 25);
    function tick() {
      const now = Date.now() + offset;
      const next = Math.floor(now / WELCOME_PERIOD_MS) % phrases.length;
      setShown(false);
      fade = window.setTimeout(() => {
        setIdx(next);
        setShown(true);
      }, WELCOME_FADE_MS);
      timer = scheduleNext(now);
    }
    timer = scheduleNext(Date.now() + offset);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(timer);
    };
  }, [offset, rotate, phrases]);

  return (
    <div
      className="k-display bg-gradient-to-r from-[#f5ecee] from-55% to-[#00e2e5] bg-clip-text text-[150px] text-transparent transition-opacity duration-[450ms]"
      style={{ opacity: shown ? 1 : 0 }}
    >
      {rotate ? phrases[idx] : t("attract.letsPlay")}
    </div>
  );
}

/** Centered one-line neon headline for the ad zone. Auto-fits: long titles
 *  (GEL BLASTERS START HERE) shrink from 76px until the line clears ~64px
 *  side margins — measured, so a future copy tweak can't silently clip.
 *  `.k-display`'s `text-wrap: balance` re-enables wrapping underneath
 *  `white-space: nowrap` (shorthand interaction), so nowrap is forced on BOTH
 *  properties. */
function NeonAdTitle({ title, accent }: { title: string; accent: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Layout effect so the size lands before paint — a long headline never
  // flashes oversized on the slide flip. This component is never SSR'd (the
  // attract root renders behind the boot loader), so the server-side
  // useLayoutEffect warning can't fire.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.fontSize = "76px";
    const w = el.scrollWidth;
    if (w > 950) el.style.fontSize = `${Math.floor((76 * 950) / w)}px`;
  }, [title]);
  return (
    <div className="kiosk-ad-flicker absolute bottom-[122px] left-1/2 -translate-x-1/2">
      <div
        ref={ref}
        className="k-display whitespace-nowrap text-[76px] text-white [text-wrap:nowrap]"
        style={{
          textShadow: `0 0 6px rgba(255,255,255,0.85), 0 0 24px ${accent}, 0 0 64px ${withAlpha(accent, 0.42)}`,
        }}
      >
        {title}
      </div>
    </div>
  );
}

/** Blinking beacon dot flanking the banner text. */
function BannerDot({ accent }: { accent: string }) {
  return (
    <span
      aria-hidden="true"
      className="kiosk-ad-blink h-[12px] w-[12px] shrink-0 rounded-full"
      style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
    />
  );
}

/** #rrggbb → rgba() at the given alpha (slide accents arrive as hex). */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
