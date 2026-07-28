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
  billboardStage,
  type BillboardStage,
} from "../attract/billboard";
import { slidePlaysVideo, vehiclePhaseMs } from "../attract/rotation";
import { KIOSK_PHOTOS, KIOSK_VIDEOS, type KioskAdSlide } from "../assets";
import { venueSlug, type KioskConfig } from "../config";
import { kioskBillboardEnabled } from "../flags";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { useT } from "../i18n";
import { syncGlowPhase } from "../hooks/useKioskClock";
import { BrandLogo } from "./BrandLogo";
import { clickableDivProps } from "@/lib/a11y";

/** How often a playing clip is re-checked against the shared clock. Kiosk cuts
 *  carry a keyframe every second, so a correction is cheap and near-instant —
 *  worth checking often enough that a stall converges within a slide. */
const DRIFT_CHECK_MS = 2000;
/** Only correct drift a viewer could actually see — a seek is a visible hitch,
 *  so nudging on every tick would stutter more than the drift it fixes. */
const DRIFT_TOLERANCE_S = 0.25;

/**
 * Put a looping clip at the frame the SHARED clock says it should be on.
 *
 * Same principle as syncGlowPhase for CSS animations: position is derived, not
 * remembered, so a kiosk that boots late, resyncs its clock, or re-mounts the
 * screen lands on exactly the frame its neighbours are showing. Modulo the
 * clip's own duration, so clips of different lengths each stay aligned to
 * themselves across the bank.
 *
 * `tolerance` makes it a drift CORRECTION rather than an unconditional seek:
 * pass it from the watchdog so an already-aligned clip is left alone.
 */
function seekToClock(el: HTMLVideoElement, offset: number, tolerance = 0): void {
  const duration = el.duration;
  // Metadata not in yet — the loadedmetadata pass will place it.
  if (!Number.isFinite(duration) || duration <= 0) return;
  const want = ((((Date.now() + offset) / 1000) % duration) + duration) % duration;
  if (tolerance > 0 && Math.abs(el.currentTime - want) <= tolerance) return;
  try {
    el.currentTime = want;
  } catch {
    /* not seekable yet — the next tick gets it */
  }
}

/**
 * Where a vehicle waits between crossings.
 *
 * The ad zone parks at plain `left: 100%` and gets away with it because its
 * container is the FULL canvas width and carries `overflow-hidden`. The
 * headline lane is narrower — it sits inside the hero's 64px side padding — so
 * left:100% is x=1016 on a 1080 canvas and 64px of the vehicle sits in view.
 * Hence the extra 64px, which puts the park position back on the canvas edge.
 *
 * An INLINE STYLE, not a Tailwind arbitrary value: `left-[calc(100%+64px)]`
 * emits `calc(100%+64px)`, and CSS requires whitespace around `+` inside
 * calc(). The browser drops the whole declaration, `left` falls back to `auto`,
 * and the vehicle renders at its static position — parked in the MIDDLE of the
 * lane, permanently visible. Tailwind would need `calc(100%_+_64px)`; an inline
 * style just keeps the spaces and cannot be got wrong the same way.
 */
const PARK_LEFT = "calc(100% + 64px)";

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
  /** Which lap of the rotation we're on — drives video/still alternation. */
  cycle: number;
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
  cycle,
  offset,
  vipAvailable,
  resolvePhoto,
  onStart,
}: AttractHeadlineProps) {
  const t = useT();
  const venue = venueSlug(config);

  /** Does slide `i` run its clip on THIS lap? See attract/rotation.ts. */
  const playsVideo = (i: number) => slidePlaysVideo(cycle, i, !!slides[i]?.video);

  // Physical bank position drives the vehicle stagger, so the handoff follows
  // where a kiosk STANDS (HPFM runs 3·2·6·1·4) rather than its number, and the
  // phase is spread across the REAL bank size — see vehiclePhaseMs.
  const position = bankPosition(venue, config.kioskNumber ?? 1);
  const phaseMs = vehiclePhaseMs(position, bankSize(venue), config.kioskNumber ?? 1);

  const stage = useBillboardStage(config, position, offset);
  const bbSlides = BILLBOARD_SLIDES[venue];
  const bbSlide =
    position != null && bbSlides.length ? bbSlides[Math.min(position, bbSlides.length - 1)] : null;
  // The curtain is up on this screen (solid billboard image, all screens
  // together); the word may or may not have arrived yet.
  const onShow = !!bbSlide && stage.image;
  const finale = !!bbSlide && stage.finale;
  const wordUp = !!bbSlide && stage.word;

  // The headline slot is shared: the rotation owns it when idle, the billboard
  // owns it during the show. One element either way — that is the whole point.
  // During the lead-in the slot is EMPTY: the image has changed but this
  // screen's word has not lit yet, and leaving "Let's bowl." sitting on a
  // billboard photo is exactly the mismatch the show is meant to avoid.
  const headline = finale
    ? t("attract.billboard.allRightHere")
    : wordUp && bbSlide
      ? t(bbSlide.word)
      : onShow
        ? ""
        : t(slide.headline);
  const accent = finale ? "#00e2e5" : wordUp && bbSlide ? bbSlide.accent : slide.accent;

  // The finale line is set a touch smaller than an activity word, matching the
  // overlay it replaces.
  const headlineRef = useFitOneLine(headline, finale ? 132 : HEADLINE_PX);

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
  /**
   * Re-seek the headline lane to the shared clock whenever its animated
   * children change identity.
   *
   * AttractScreen seeks the whole root on [offset, config, booting, adIndex],
   * which covers a slide flip — but NOT the billboard, which suppresses the
   * vehicle for its ~11s and then brings it back with adIndex unchanged. A
   * freshly mounted element starts its animation wherever the browser happens
   * to be, so without this the bank falls out of step after every show at
   * HeadPinz. Cheap and idempotent: every target derives from the same clock,
   * so re-seeking an already-aligned animation is a no-op.
   */
  const laneRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    syncGlowPhase(laneRef.current, offset);
  }, [offset, vehicle, index, onShow]);

  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  useEffect(() => {
    videoRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i === index && !onShow && playsVideo(i)) {
        seekToClock(el, offset);
        void el.play().catch(() => {
          /* poster stays up — never blank the backdrop over this */
        });
      } else if (!el.paused) {
        // Includes a still lap: the clip stays mounted (so it is not re-fetched)
        // but stops decoding entirely while its photo is showing.
        el.pause();
      }
    });
    // playsVideo is derived from index/cycle/slides, all in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, cycle, onShow, offset, slides]);

  /**
   * Keep the PLAYING clip locked to the shared clock.
   *
   * syncGlowPhase only seeks CSS animations; a <video> just plays from wherever
   * it happened to start, so two kiosks showing the same slide sit at different
   * frames — the bank looks out of step even though the rotation is in step.
   * seekToClock derives the frame from the same wall clock everything else
   * uses, so every screen shows the SAME frame of the SAME clip.
   *
   * Decoders also drift (dropped frames, a stalled buffer, a resumed tab), so
   * a seek at slide-change alone is not enough on a screen that runs for weeks.
   * This watchdog re-checks while the clip is on and nudges it back only when
   * it has drifted past a threshold a viewer could notice — correcting every
   * tick would stutter, correcting never would slowly desynchronise the row.
   */
  useEffect(() => {
    if (onShow) return;
    const iv = setInterval(() => {
      const el = videoRefs.current[index];
      if (el && !el.paused) seekToClock(el, offset, DRIFT_TOLERANCE_S);
    }, DRIFT_CHECK_MS);
    return () => clearInterval(iv);
  }, [index, cycle, onShow, offset]);

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
              className={`absolute -inset-[6%] bg-cover bg-center ${playsVideo(i) ? "" : "kiosk-kenburns"}`}
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
                // Duration is unknown until metadata lands, so the activation
                // seek above can be a no-op on a cold start. Place it here too.
                onLoadedMetadata={(e) => seekToClock(e.currentTarget, offset)}
                // Faded out rather than unmounted on a still lap — unmounting
                // is what re-downloads the clip (see the play/pause effect).
                // The still underneath is what shows through.
                style={{ opacity: playsVideo(i) ? 1 : 0 }}
                className="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
              />
            )}
          </div>
        ))}
        {/* Billboard backdrop — a STILL, deliberately: the show is a hard
            light-up per screen and a cut reads crisper than a moving image.
            Solid through BOTH phases (owner 2026-07-28: "solid images behind")
            — the shared scrim below already carries the text, so dimming the
            finale only made the row look like it was fading out. */}
        {bbSlide && (
          <div
            className="absolute inset-0 bg-cover bg-center transition-opacity duration-500"
            style={{
              backgroundImage: `url(${resolvePhoto(bbSlide.photo)})`,
              opacity: onShow ? 1 : 0,
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
            own box.
            PARKED AT calc(100% + 64px), NOT left-full: the lane lives inside
            the hero's 64px side padding, so left:100% is x=1016 on a 1080
            canvas — 64px of the vehicle sat permanently visible at the right
            edge, then lurched into motion. The extra 64px pushes the park
            position out to the canvas edge so it is genuinely hidden until it
            crosses. */}
        <span ref={laneRef} className="relative grid w-full place-items-center">
          <span
            ref={headlineRef}
            data-glow-phase-ms={phaseMs}
            className={`k-display block ${vehicle ? "kiosk-ad-rumble" : ""}`}
            style={
              onShow
                ? {
                    // Billboard words carry deliberate \n breaks ("Gel\nblasters"),
                    // so this is the one case that WANTS to wrap.
                    whiteSpace: "pre-line",
                    // fontSize is owned by useFitOneLine — see there.
                    color: "#fff",
                    lineHeight: 0.95,
                    textShadow: `0 0 10px rgba(255,255,255,0.88), 0 0 64px ${accent}`,
                  }
                : {
                    // Rotation headlines are ALWAYS one line. Set INLINE, not as
                    // a utility class: `white-space: pre-line` is a shorthand
                    // that also sets `text-wrap: wrap`, so pairing it with a
                    // `[text-wrap:nowrap]` class made the winner depend on
                    // stylesheet order. When wrap won, "LET'S GO MEGA." broke
                    // over two lines — and fitOneLine measures scrollWidth,
                    // which on a WRAPPED element equals the container, so it
                    // never shrank and the second line was clipped. Inline
                    // beats both the utility and .k-display's text-wrap:balance.
                    whiteSpace: "nowrap",
                    // fontSize is owned by useFitOneLine — see there.
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
              // Fall back to the raw URL: useResilientImages returns undefined
              // for anything it has not resolved yet, and src={undefined}
              // renders nothing at all — the car would simply never appear.
              src={resolvePhoto(KIOSK_PHOTOS.raceCar) ?? KIOSK_PHOTOS.raceCar}
              alt=""
              aria-hidden="true"
              draggable={false}
              data-glow-phase-ms={phaseMs}
              // Centred with top + marginTop, NOT -translate-y-1/2: the
              // kiosk-racecar keyframes animate `transform`, which silently
              // replaces any transform utility on the same element. With
              // -translate-y-1/2 the car dropped half its height below the
              // line and read as "the car isn't working".
              style={{ marginTop: -48, left: PARK_LEFT }}
              className="kiosk-racecar pointer-events-none absolute top-1/2 h-[96px] w-auto max-w-none"
            />
          )}
          {vehicle === "ball" && (
            <span
              aria-hidden="true"
              data-glow-phase-ms={phaseMs}
              // Same transform collision as the car above (sprite is 84px).
              style={{ marginTop: -42, left: PARK_LEFT }}
              className="kiosk-bowlball pointer-events-none absolute top-1/2"
            >
              <span className="kiosk-bowlball-sprite" />
            </span>
          )}
        </span>

        {/* Replaces the cyan pill. The screen IS the button; this says so.
            Left at full strength through the billboard: the show swaps the
            backdrop and the headline, nothing else (owner 2026-07-28). A guest
            can still walk up and start mid-show, so the prompt that tells them
            so must not fade out underneath them. */}
        <span className="grid justify-items-center gap-[14px] text-white/70">
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
          Untouched by the billboard (owner 2026-07-28): the show is just
          another entry in the rotation, swapping the backdrop and the headline
          and leaving the screen's furniture where it is. Fading these out made
          the bank look like it was powering down, and hid two live shortcuts
          from anyone standing in front of it. */}
      <div className="relative z-10 flex shrink-0 justify-center gap-[20px] px-[64px] pb-[24px]">
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
function useBillboardStage(
  config: KioskConfig,
  position: number | null,
  offset: number,
): BillboardStage {
  const venue = venueSlug(config);
  const enabled = config.brand === "headpinz" && kioskBillboardEnabled(venue) && position != null;
  const count = bankSize(venue);
  const [stage, setStage] = useState<BillboardStage>(OFF_STAGE);

  useEffect(() => {
    // No setState on the disabled path — the return below DERIVES the off
    // state instead, so a kiosk that leaves the bank can never be stranded
    // mid-show by a stage we forgot to clear (and no cascading render).
    if (!enabled || position == null) return;
    const tick = () => setStage(billboardStage(Date.now() + offset, position, count));
    tick();
    // 200ms poll keeps the stage honest across clock resyncs; the CSS
    // transitions smooth the edges, so cadence jitter is invisible.
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [enabled, position, count, offset]);

  return enabled ? stage : OFF_STAGE;
}

const OFF_STAGE: BillboardStage = { image: false, word: false, finale: false };

/**
 * Force the headline onto ONE line by measuring, not by trusting the copy.
 *
 * `.k-display` sets `text-wrap: balance`, which re-enables wrapping underneath
 * `white-space: nowrap` (shorthand interaction) — the same trap NeonAdTitle
 * documents. "Let's blast." overflowed and wrapped at 150px; Spanish is longer
 * again. So: nowrap forced in the class list, then shrink until it fits.
 */
function useFitOneLine(text: string, base: number) {
  const ref = useRef<HTMLSpanElement>(null);
  // Layout effect so the size lands before paint — a long phrase never flashes
  // oversized on the slide flip.
  //
  // This hook OWNS fontSize; the style prop deliberately does not set it. When
  // both did, every re-render re-applied the base size from the prop and wiped
  // the measured shrink — and the effect would not re-run, because the text had
  // not changed. On HeadPinz that is a 200ms billboard poll re-inflating the
  // headline five times a second, so a phrase that needed shrinking simply
  // overflowed instead.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.fontSize = `${base}px`;
    const w = el.scrollWidth;
    if (w > HEADLINE_MAX_W) {
      el.style.fontSize = `${Math.floor((base * HEADLINE_MAX_W) / w)}px`;
    }
  }, [text, base]);
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
