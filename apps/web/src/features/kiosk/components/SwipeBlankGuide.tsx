"use client";

/**
 * "Take a new card, then swipe it" — the two-step guide for kiosks WITHOUT a
 * card dispenser (owner 2026-08-28). On these kiosks a new Game Zone card is a
 * blank the guest takes from the holder under the screen and swipes on the MSR;
 * the tokens then load onto that card. Nothing comes out of the machine, so the
 * guide has to carry the whole instruction: WHERE the cards are, and WHAT to do
 * with one. Used by the new-card cart row, the voucher run ("card 2 of 3") and
 * the confirmation-screen fulfilment of cards bought with a booking.
 *
 * Pure inline SVG (no emoji, no external assets); both steps glow while the
 * kiosk waits for the swipe (it cannot sense the "take a card" half) and the
 * swiping card animates under the existing reduced-motion guard
 * (app/kiosk/kiosk.css) — with motion reduced, both figures rest as static
 * "here / like this" diagrams.
 *
 * `size` — "md" for screens wrapped in `kiosk-zoom` (rem scale), "lg" for the
 * fixed-canvas confirmation column (px scale).
 */
import { useT } from "../i18n";

/** "wait" — both steps lit, we're waiting for the swipe; "checking" — the swipe
 *  landed and the lookup is running (steps dim, status line says so). */
export type SwipeGuideStep = "wait" | "checking";

function HolderGlyph({ active }: { active: boolean }) {
  const stroke = active ? "#46d68c" : "rgba(255,255,255,0.35)";
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden="true">
      {/* Screen bottom edge + the holder mounted below it */}
      <rect x="10" y="6" width="140" height="18" rx="4" fill="rgba(255,255,255,0.08)" />
      <rect
        x="40"
        y="58"
        width="80"
        height="48"
        rx="8"
        fill="rgba(0,0,0,0.35)"
        stroke={stroke}
        strokeWidth="4"
      />
      {/* Fanned blanks in the holder */}
      <g transform="translate(80 60)">
        <rect
          x="-26"
          y="-22"
          width="44"
          height="30"
          rx="4"
          fill="#0d3f8f"
          transform="rotate(-10)"
        />
        <rect x="-22" y="-26" width="44" height="30" rx="4" fill="#1554b8" transform="rotate(-4)" />
        <rect x="-18" y="-30" width="44" height="30" rx="4" fill="#2a6fd6" transform="rotate(3)" />
        <rect x="-18" y="-30" width="44" height="8" rx="4" fill="#00b8cf" transform="rotate(3)" />
      </g>
      {/* Hand / arrow: lift one out */}
      <path
        d="M118 40 v-22 m0 0 l-8 8 m8 -8 l8 8"
        fill="none"
        stroke={stroke}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SwipeGlyph({ active }: { active: boolean }) {
  const stroke = active ? "#46d68c" : "rgba(255,255,255,0.35)";
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden="true">
      {/* Reader body with a slot along the top */}
      <rect
        x="16"
        y="62"
        width="128"
        height="44"
        rx="8"
        fill="rgba(0,0,0,0.35)"
        stroke={stroke}
        strokeWidth="4"
      />
      <rect
        x="28"
        y="66"
        width="104"
        height="8"
        rx="4"
        fill="#000"
        stroke="#2c3446"
        strokeWidth="1.5"
      />
      {/* Card drawn through the slot, stripe down */}
      <g className={active ? "k-swipe-card" : undefined}>
        <rect
          x="52"
          y="28"
          width="56"
          height="40"
          rx="5"
          fill="#0d3f8f"
          stroke="#3d6ec9"
          strokeWidth="2"
        />
        <rect x="52" y="58" width="56" height="8" fill="#111" />
      </g>
      {/* Direction arrow */}
      <path
        d="M30 20 h100 m0 0 l-10 -8 m10 8 l-10 8"
        fill="none"
        stroke={stroke}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SwipeBlankGuide({
  step,
  label,
  sublabel,
  listening,
  note,
  onCancel,
  size = "md",
}: {
  /** Waiting for the swipe, or checking the card that was just swiped. */
  step: SwipeGuideStep;
  /** Headline above the steps (e.g. "Card 2 of 3"). */
  label?: string;
  sublabel?: string;
  /** MSR port is open. When false the guide says it is still connecting. */
  listening: boolean;
  /** Inline verdict from the last swipe (duplicate / has value / couldn't check). */
  note?: string | null;
  onCancel?: () => void;
  size?: "md" | "lg";
}) {
  const t = useT();
  const lg = size === "lg";
  // Both steps light together while we wait (the kiosk can't sense the "take a
  // card" half) and dim together while the swiped card is being checked.
  const lit = step === "wait";
  const stepBox = (n: 1 | 2, title: string, body: string, glyph: React.ReactNode) => (
    <div
      className={`flex flex-1 flex-col items-center rounded-2xl border-2 text-center transition-colors ${
        lg ? "px-[20px] py-[18px]" : "px-4 py-3.5"
      } ${lit ? "border-[#46d68c] bg-[#46d68c]/10" : "border-white/10 bg-white/[0.03]"}`}
    >
      <div
        className={`font-bold uppercase tracking-[0.25em] ${
          lg ? "text-[18px]" : "text-[11px]"
        } ${lit ? "text-[#46d68c]" : "text-white/40"}`}
      >
        {t("gamezone.swipe.stepN", { n })}
      </div>
      <div className={lg ? "my-[10px] h-[120px] w-[160px]" : "my-2 h-[84px] w-[112px]"}>
        {glyph}
      </div>
      <div
        className={`font-heading font-extrabold italic leading-tight ${lg ? "text-[30px]" : "text-xl"}`}
      >
        {title}
      </div>
      <div className={`mt-1 ${lg ? "text-[20px]" : "text-sm"} text-white/60`}>{body}</div>
    </div>
  );
  return (
    <div className="flex flex-col items-center text-center" role="status" aria-live="polite">
      {label ? (
        <div
          className={`font-heading font-extrabold italic leading-tight ${lg ? "text-[34px]" : "text-2xl"}`}
        >
          {label}
        </div>
      ) : null}
      {sublabel ? (
        <div className={`mt-1 ${lg ? "text-[22px]" : "text-base"} text-white/55`}>{sublabel}</div>
      ) : null}
      <div className={`flex w-full gap-3 ${label || sublabel ? (lg ? "mt-[16px]" : "mt-3") : ""}`}>
        {stepBox(
          1,
          t("gamezone.swipe.step1.title"),
          t("gamezone.swipe.step1.body"),
          <HolderGlyph active={lit} />,
        )}
        {stepBox(
          2,
          t("gamezone.swipe.step2.title"),
          t("gamezone.swipe.step2.body"),
          <SwipeGlyph active={lit} />,
        )}
      </div>
      <div
        className={`${lg ? "mt-[14px] min-h-[32px] text-[22px]" : "mt-2.5 min-h-[24px] text-sm"}`}
      >
        {step === "checking" ? (
          <span className="text-white/70">{t("gamezone.swipe.checking")}</span>
        ) : !listening ? (
          <span className="text-amber-300/90">{t("gamezone.connectingReader")}</span>
        ) : note ? (
          <span className="text-[#ff8c7a]">{note}</span>
        ) : null}
      </div>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className={`k-tap mt-2 rounded-full border border-white/20 text-white/70 ${
            lg ? "px-[28px] py-[12px] text-[22px]" : "px-5 py-2.5 text-sm"
          }`}
        >
          {t("gamezone.cancel")}
        </button>
      ) : null}
    </div>
  );
}
