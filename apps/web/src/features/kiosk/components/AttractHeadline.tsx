"use client";

/**
 * Attract screen — HEADLINE layout (owner 2026-07-28, `attractLayout:
 * "headline"`, the default). Replaces the 480px ad zone.
 *
 * What changed and why:
 *
 *  1. NO AD ZONE. The top 480px was display-only and painted a second
 *     full-bleed photo on top of the backdrop photo — which is why it needed
 *     its own heavier scrim. The slide now drives the screen's OWN backdrop, so
 *     there is one photograph, one scrim, and 480px back in the reach band.
 *
 *  2. NO PRIMARY BUTTON. `start()` fires on a tap anywhere, so the big cyan
 *     "Touch to get started" pill was a label shaped like a control. It is a
 *     prompt now. The only real buttons left are the two that go somewhere
 *     DIFFERENT from a plain tap (VIP, race packs), and they get quiet.
 *
 *  3. ONE MESSAGE. The neon sign, the marquee banner and the pill all said
 *     "start". Now the headline names the activity and the prompt names the
 *     gesture, once each.
 *
 *  4. VIDEO. Slides with a clip run it full-bleed; slides without one keep the
 *     still with ken-burns. Exactly ONE <video> is mounted at a time — kiosk
 *     PCs are not fast, and four decoders would be four decoders.
 *
 *  5. BILLBOARD INTEGRATED, NOT OVERLAID. AttractBillboard paints a z-20 layer
 *     with a 94% navy veil to blank the screen, because "ALL RIGHT HERE" would
 *     otherwise collide with the "Let's bowl." underneath it. Here the billboard
 *     simply BECOMES the source of the headline and backdrop for its ~11s, then
 *     hands back. The bleed cannot happen — there is only ever one headline —
 *     and the veil, the second text layer and the pointer-events escape hatch
 *     all go away. The overlay component is untouched and still used by the
 *     ad-zone layout.
 *
 * Clock: every moving part (slide index, vehicle crossing, billboard phase)
 * derives from the shared kiosk wall clock, so a bank performs in unison with
 * no cross-kiosk messaging. Vehicles reuse the EXISTING `kiosk-racecar` /
 * `kiosk-bowlball` / `kiosk-ad-rumble` keyframes and the same per-kiosk stagger
 * the ad-zone banner used — no new timing to keep in sync with
 * KIOSK_GLOW_PERIODS_MS.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BILLBOARD_SLIDES,
  bankPosition,
  bankSize,
  billboardPhase,
  type BillboardPhase,
} from "../attract/billboard";
import { KIOSK_PHOTOS, KIOSK_VIDEOS, type KioskAdSlide } from "../assets";
import { venueSlug, type KioskConfig } from "../config";
import { kioskBillboardEnabled } from "../flags";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { useT } from "../i18n";
import { BrandLogo } from "./BrandLogo";
import { clickableDivProps } from "@/lib/a11y";

/** Headline base size; measured DOWN from here when a phrase is too wide. */
const HEADLINE_PX = 150;
/** Same 64px side gutter the rest of the canvas uses, with a little air. */
const HEADLINE_MAX_W = 940;

export interface AttractHeadlineProps {
  config: KioskConfig;
  /** The current ad-rotation slide — drives headline, backdrop, accent, vehicle. */
  slide: KioskAdSlide;
  /** Every slide in this venue's rotation, so backdrops can crossfade. */
  slides: KioskAdSlide[];
  /** Index of `slide` within `slides`. */
  index: number;
  /** Shared-clock offset: corrected now = Date.now() + offset. */
  offset: number;
  /** False locks the VIP shortcut (no feasible combo left today). */
  vipAvailable: boolean;
  /** Self-healed photo URL resolver from the parent's useResilientImages.
   *  Mirrors that hook's own signature (undefined in → undefined out). */
  resolvePhoto: (url: string | undefined) => string | undefined;
  onStart: (goto?: string) => void;
}

export function AttractHeadline({
  config,
  slide,
  slides,
  index,
  offset,
  vipAvailable,
  resolvePhoto,
  onStart,
}: AttractHeadlineProps) {
  const t = useT();
  const venue = venueSlug(config);

  // Physical bank position drives the vehicle stagger, so a handoff follows
  // where a kiosk STANDS (HPFM runs 3·2·6·1·4) rather than its number.
  const position = bankPosition(venue, config.kioskNumber ?? 1);
  const phaseMs = ((position ?? (config.kioskNumber ?? 1) - 1) % 4) * 2000;

  const phase = useBillboardPhase(config, position, offset);
  const bbSlides = BILLBOARD_SLIDES[venue];
  const bbSlide =
    position != null && bbSlides.length ? bbSlides[Math.min(position, bbSlides.length - 1)] : null;
  const showing: BillboardPhase = bbSlide ? phase : "idle";
  const finale = showing === "finale";
  const activity = showing === "activity";
  const onShow = activity || finale;

  // The headline slot is shared: the rotation owns it when idle, the billboard
  // owns it during the show. One element either way — that is the whole point.
  const headline = finale
    ? t("attract.billboard.allRightHere")
    : activity && bbSlide
      ? t(bbSlide.word)
      : t(slide.headline);
  const accent = finale ? "#00e2e5" : activity && bbSlide ? bbSlide.accent : slide.accent;

  const headlineRef = useFitOneLine(headline);

  // Vehicles never run during a bank event — a car driving through the finale
  // is exactly the collision this integration exists to avoid.
  const vehicle = onShow ? undefined : slide.vehicle;

  /**
   * Every clip is mounted ONCE for the life of the page and only PLAYED while
   * its slide is up. This is a cost guard, not a style choice.
   *
   * Mounting the active clip conditionally (the obvious way to write this)
   * unmounts it on every slide change, so the rotation re-fetches each clip
   * roughly every 32s — forever, on a screen that runs 24/7 unattended. The
   * kart reel is 31MB; that is the 2026-07-24 "717MB transfer spike" incident
   * again, several orders of magnitude worse, and Fast Data Transfer is billed
   * on every client egress.
   *
   * Mounted-but-paused costs one fetch per clip per page load and no decode:
   * a paused <video> does not decode frames, so the CPU story is the same as
   * one player. play() is best-effort — a rejected promise (autoplay policy,
   * decoder busy) just leaves the poster still showing, which is a correct
   * fallback rather than an error state.
   */
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  useEffect(() => {
    videoRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i === index && !onShow) {
        void el.play().catch(() => {
          /* poster stays up — never blank the backdrop over this */
        });
      } else if (!el.paused) {
        el.pause();
      }
    });
  }, [index, onShow]);

  return (
    <>
      {/* ── backdrop: one layer per slide, only the active one opaque ── */}
      <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
        {slides.map((s, i) => (
          <div
            key={s.title}
            className={`absolute inset-0 transition-opacity duration-1000 ${
              i === index && !onShow ? "opacity-100" : "opacity-0"
            }`}
          >
            {/* The still doubles as the clip's poster: it is already painted
                when the video mounts, so a slow decode shows the photo, never
                black. Ken-burns only when there is no clip — video moves. */}
            <div
              className={`absolute -inset-[6%] bg-cover bg-center ${s.video ? "" : "kiosk-kenburns"}`}
              style={{ backgroundImage: `url(${resolvePhoto(s.photo)})` }}
            />
            {s.video && (
              <video
                ref={(el) => {
                  videoRefs.current[i] = el;
                }}
                src={KIOSK_VIDEOS[s.video]}
                poster={resolvePhoto(s.photo)}
                muted
                loop
                playsInline
                preload="auto"
                tabIndex={-1}
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
          </div>
        ))}
        {/* Billboard backdrop — a STILL, deliberately: the show is a hard
            light-up per screen and a cut reads crisper than a moving image.
            Dimmed under the finale so the shared line carries the row. */}
        {bbSlide && (
          <div
            className="absolute inset-0 bg-cover bg-center transition-opacity duration-500"
            style={{
              backgroundImage: `url(${resolvePhoto(bbSlide.photo)})`,
              opacity: activity ? 1 : finale ? 0.38 : 0,
            }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418] from-[8%] via-[#020a22]/80 to-[#040e2c]/60" />
        <div
          className="absolute inset-0 transition-[background] duration-1000"
          style={{
            background: `radial-gradient(62% 38% at 50% 30%, ${withAlpha(accent, 0.22)}, transparent 68%)`,
          }}
        />
        <div className="kiosk-sweep absolute inset-0" />
      </div>

      {/* ── promo ribbon — only on a slide that carries a real offer ──
          Height changes between a promo day and a normal one, so everything
          below it is flex, never absolute against the top.
          It STARTS a session like the rest of the screen: the prompt below
          promises "touch anywhere", so 132px of dead strip on Mega Tuesdays
          would quietly make that a lie. (A div, not a button — it sits outside
          the hero button and buttons cannot nest.) */}
      <div
        {...clickableDivProps(() => onStart(), t("attract.touchAnywhereToStart"))}
        className="relative z-10 flex shrink-0 items-center justify-center gap-[26px] overflow-hidden bg-[rgba(0,4,24,0.92)] transition-[height,border-bottom-width] duration-500"
        style={{
          height: slide.notice && !onShow ? 132 : 0,
          borderBottomWidth: slide.notice && !onShow ? 3 : 0,
          borderBottomColor: slide.accent,
          borderBottomStyle: "solid",
        }}
      >
        <span
          className="kiosk-ad-blink h-[12px] w-[12px] shrink-0 rounded-full"
          style={{ background: slide.accent, boxShadow: `0 0 16px ${slide.accent}` }}
        />
        <div className="text-center">
          <div className="k-display text-[44px]" style={{ color: slide.accent }}>
            {slide.title}
          </div>
          {slide.notice && (
            <div className="text-[26px] font-bold text-[#ff5a52]">{slide.notice}</div>
          )}
        </div>
        <span
          className="kiosk-ad-blink h-[12px] w-[12px] shrink-0 rounded-full"
          style={{ background: slide.accent, boxShadow: `0 0 16px ${slide.accent}` }}
        />
      </div>

      {/* ── hero: logo, the one headline, the prompt ── */}
      <button
        type="button"
        onClick={() => onStart()}
        className="relative z-10 flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-[40px] px-[64px] text-center"
        aria-label={t("attract.touchAnywhereToStart")}
      >
        <BrandLogo
          brand={config.brand}
          alt={config.brand === "headpinz" ? "HeadPinz" : "FastTrax"}
          className="h-[184px] w-auto object-contain [filter:drop-shadow(0_0_34px_rgba(0,226,229,0.35))]"
          fallbackClassName="k-display text-[110px] leading-none text-white"
        />

        {/* The vehicle crosses THROUGH the word, so the lane is the headline's
            own box. Parked at left:100% and clipped by the canvas, it is
            invisible except during its ~2s crossing. */}
        <span className="relative grid w-full place-items-center">
          <span
            ref={headlineRef}
            data-glow-phase-ms={phaseMs}
            className={`k-display block whitespace-pre-line [text-wrap:nowrap] ${
              vehicle ? "kiosk-ad-rumble" : ""
            }`}
            style={
              onShow
                ? {
                    fontSize: finale ? 132 : HEADLINE_PX,
                    color: "#fff",
                    lineHeight: 0.95,
                    textShadow: `0 0 10px rgba(255,255,255,0.88), 0 0 64px ${accent}`,
                  }
                : {
                    fontSize: HEADLINE_PX,
                    backgroundImage: `linear-gradient(90deg, #f5ecee 52%, ${accent})`,
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }
            }
          >
            {headline}
          </span>
          {vehicle === "car" && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={resolvePhoto(KIOSK_PHOTOS.raceCar)}
              alt=""
              aria-hidden="true"
              draggable={false}
              data-glow-phase-ms={phaseMs}
              className="kiosk-racecar pointer-events-none absolute left-full top-1/2 h-[96px] w-auto max-w-none -translate-y-1/2"
            />
          )}
          {vehicle === "ball" && (
            <span
              aria-hidden="true"
              data-glow-phase-ms={phaseMs}
              className="kiosk-bowlball pointer-events-none absolute left-full top-1/2 -translate-y-1/2"
            >
              <span className="kiosk-bowlball-sprite" />
            </span>
          )}
        </span>

        {/* Replaces the cyan pill. The screen IS the button; this says so. */}
        <span
          className="grid justify-items-center gap-[14px] text-white/70 transition-opacity duration-500"
          style={{ opacity: finale ? 0.35 : activity ? 0.6 : 1 }}
        >
          <span className="k-display text-[38px] tracking-[0.22em]">
            {t("attract.touchAnywhereToStart")}
          </span>
          <span
            className="kiosk-attract-chev k-display text-[54px] leading-[0.6]"
            aria-hidden="true"
          >
            ⌄
          </span>
        </span>
      </button>

      {/* ── the only real buttons: the two that go somewhere a tap doesn't ──
          Faded during the show so the bank reads as one continuous sign. */}
      <div
        className="relative z-10 flex shrink-0 justify-center gap-[20px] px-[64px] pb-[24px] transition-opacity duration-500"
        style={{ opacity: finale ? 0 : activity ? 0.25 : 1 }}
      >
        <QuietAction
          label={t("attract.vipExperience")}
          disabled={!vipAvailable}
          onClick={() => onStart("vip")}
        />
        {kioskRacePacksEnabled() && config.brand === "fasttrax" && (
          <QuietAction
            label={t("attract.racePacks", { price: "$49.99" })}
            onClick={() => onStart("packs")}
          />
        )}
      </div>
    </>
  );
}

/**
 * Billboard phase for this screen, polled off the shared clock exactly as
 * AttractBillboard does. Returns "idle" whenever the billboard shouldn't run
 * here at all — wrong brand, flag off, or a kiosk that isn't in the bank map
 * (owner 2026-07-26: unmapped kiosks sit the choreography out).
 */
function useBillboardPhase(
  config: KioskConfig,
  position: number | null,
  offset: number,
): BillboardPhase {
  const venue = venueSlug(config);
  const enabled = config.brand === "headpinz" && kioskBillboardEnabled(venue) && position != null;
  const count = bankSize(venue);
  const [phase, setPhase] = useState<BillboardPhase>("idle");

  useEffect(() => {
    // No setState on the disabled path — the return below DERIVES idle instead,
    // so a kiosk that leaves the bank can never be stranded mid-show by a
    // phase we forgot to clear (and no cascading render on mount).
    if (!enabled || position == null) return;
    const tick = () => setPhase(billboardPhase(Date.now() + offset, position, count));
    tick();
    // 200ms poll keeps the phase honest across clock resyncs; the CSS
    // transitions smooth the edges, so cadence jitter is invisible.
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [enabled, position, count, offset]);

  return enabled ? phase : "idle";
}

/**
 * Force the headline onto ONE line by measuring, not by trusting the copy.
 *
 * `.k-display` sets `text-wrap: balance`, which re-enables wrapping underneath
 * `white-space: nowrap` (shorthand interaction) — the same trap NeonAdTitle
 * documents. "Let's blast." overflowed and wrapped at 150px; Spanish is longer
 * again. So: nowrap forced in the class list, then shrink until it fits.
 */
function useFitOneLine(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  // Layout effect so the size lands before paint — a long phrase never flashes
  // oversized on the slide flip.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.fontSize = `${HEADLINE_PX}px`;
    const w = el.scrollWidth;
    if (w > HEADLINE_MAX_W) {
      el.style.fontSize = `${Math.floor((HEADLINE_PX * HEADLINE_MAX_W) / w)}px`;
    }
  }, [text]);
  return ref;
}

/**
 * A shortcut, not a primary action: no fill, thin rule, smaller type. These sit
 * OUTSIDE the hero button so a tap on one deep-links instead of starting the
 * generic flow.
 */
function QuietAction({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      className={`k-display k-tap flex h-[96px] max-w-[420px] flex-1 items-center justify-center rounded-[18px] border-[1.5px] bg-[rgba(0,4,24,0.42)] px-[18px] text-center text-[27px] backdrop-blur-[8px] ${
        disabled ? "border-white/10 text-white/25" : "border-[#e8b14c]/45 text-[#e8b14c]"
      }`}
    >
      {label}
    </button>
  );
}

/** #rrggbb → rgba() at the given alpha (slide accents arrive as hex). */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
