"use client";

/**
 * Ultimate VIP Experience site popup — client half.
 *
 * DESIGN: this deliberately borrows the live site's own vocabulary rather than
 * inventing a "premium dark" one, because an invented one reads as stock. Every
 * device here already exists on fasttraxent.com:
 *  - the red -> white -> cyan racing stripe (Hero's bottom accent) divides the
 *    two venues, so the join between buildings is FastTrax's own mark
 *  - headline is Exo 2 black uppercase with a coloured text glow (Hero's
 *    "FASTTRAX" treatment); the price gets the same glow instead of a badge
 *  - inclusions are plain uppercase Exo 2 lines at line-height 2, NOT icon
 *    bullet lists (see the Race Add-Ons cards on /pricing)
 *  - the voucher block uses the site's dashed-border card:
 *    1.78px dashed accent on rgba(7,16,39,.5), 8px radius
 *  - buttons are a solid fill at border-radius 555px with a colour-matched glow
 *  - body copy sits at 15-17px / 1.6 in rgba(245,236,238,.8) — the site does
 *    not use 10px micro-type, and neither should an ad pretending to be part
 *    of it
 *
 * Layout: two columns on `sm`+ (stacked photos beside the copy, short enough
 * for a 1366x768 laptop), one column below, centred vertically at every size.
 * The sheet is sized to avoid internal scrolling down to a 375x629 phone; the
 * CTA lives in a footer OUTSIDE the scroll area so it is reachable regardless.
 * `dvh`, not `vh`, so an iOS toolbar can never push it off-screen.
 *
 * Trigger rules live here, not in the layout: 20s dwell or 40% scroll, once
 * per visitor per 14 days, and never over a flow where a popup would be
 * hostile (booking, kiosk, admin, group-events/birthday inquiry pages on
 * either brand). `?vip=1` forces it for smoke-testing.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";

/** Straight from the live site's palette. */
const GOLD = "#FFD700";
const INK = "#04081a";
const RED = "rgb(228,28,29)";
const CYAN = "#00E2E5";
/** The site's body-copy colour — not a generic white/70. */
const BODY = "rgba(245,236,238,0.8)";
/** Hero's bottom accent, reused as the seam between the two venues. */
const RACING_STRIPE = `linear-gradient(90deg, ${RED}, rgba(255,255,255,.6), ${CYAN})`;
const RACING_STRIPE_V = `linear-gradient(180deg, ${RED}, rgba(255,255,255,.6), ${CYAN})`;

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const TRACK_IMG = `${BLOB}/images/subpages/pricing-combos.webp`;
const LANES_IMG = "/promo/world-cup/neoverse-vip.jpg";

/** localStorage key holding the epoch ms of the last dismissal. */
const SEEN_KEY = "ft:vip-popup:seen";
const REPEAT_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const DWELL_MS = 20_000;
const SCROLL_TRIGGER = 0.4;

/**
 * Route prefixes that never show it. Booking is the big one: interrupting a
 * guest who is ALREADY buying is the worst possible moment, and the combo is
 * on offer inside that flow anyway.
 */
const SUPPRESSED_PREFIXES = ["/book", "/kiosk", "/admin", "/checkout", "/e/", "/s/"];

/**
 * Route segments that never show it, on either brand. Group-events and
 * birthday pages are lead-capture pages with their own forms and modals —
 * interrupting a planner mid-inquiry to sell a walk-in combo loses the bigger
 * sale. Matched by segment, not prefix, because the same pages live at
 * /group-events (fasttraxent.com), /fort-myers|naples/group-events and
 * /fort-myers|naples/birthdays (headpinz.com), and the internal /hp/... form
 * in dev (owner 2026-08-04).
 */
const SUPPRESSED_SEGMENTS = ["group-events", "birthdays"];

export interface VipPopupStop {
  name: string;
  note: string;
  venue: string;
  accent: "track" | "lanes";
}

export interface VipPopupVoucher {
  title: string;
  items: string[];
  /** Shared terms. Renders WITH the items, never separately — they are
   *  redeem-later vouchers with real limits, not walk-up extras. */
  note: string;
}

export interface VipPopupContent {
  name: string;
  durationLabel: string;
  weekdayPrice: string;
  weekendPrice: string;
  minHeadcount: number;
  startHoursLabel: string;
  href: string;
  stops: VipPopupStop[];
  voucher: VipPopupVoucher | null;
}

export function VipExperiencePopupClient({ content }: { content: VipPopupContent }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  const segments = pathname.split("/");
  const suppressed =
    SUPPRESSED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`),
    ) || SUPPRESSED_SEGMENTS.some((s) => segments.includes(s));

  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      // Private mode / storage disabled — it just shows again next visit.
    }
  }, []);

  // Arm the trigger. Client-only signals (storage, scroll, URL), so an effect.
  useEffect(() => {
    if (suppressed) return;

    const forced = new URLSearchParams(window.location.search).has("vip");
    if (!forced) {
      try {
        const seen = Number(window.localStorage.getItem(SEEN_KEY));
        if (seen && Date.now() - seen < REPEAT_AFTER_MS) return;
      } catch {
        // Unreadable storage — treat as unseen rather than never showing.
      }
    }

    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      restoreFocusTo.current = document.activeElement;
      setOpen(true);
    };

    if (forced) {
      fire();
      return;
    }

    const timer = window.setTimeout(fire, DWELL_MS);
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY / max >= SCROLL_TRIGGER) fire();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [suppressed]);

  // Modal behaviour: Esc, scroll lock, focus in and back out again.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cardRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = priorOverflow;
      (restoreFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, dismiss]);

  if (!open || suppressed) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute inset-0 h-full w-full cursor-default bg-[rgba(2,4,14,0.78)] backdrop-blur-[3px] motion-safe:animate-[vipFade_.4s_ease]"
      />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vip-popup-title"
        tabIndex={-1}
        className={[
          // min-w-0 on the card AND its columns: grid/flex children default to
          // min-width:auto, so one un-shrinkable child widens the whole card.
          "relative m-2 flex min-w-0 max-w-[calc(100%-1rem)] flex-col overflow-hidden outline-none",
          "w-[calc(100%-1rem)] max-h-[calc(100dvh-1rem)]",
          // Wider + a narrower photo column than the first pass: it buys the
          // copy column enough width to keep the headline on two lines, which
          // is worth more vertical room than the photos are.
          "sm:m-0 sm:grid sm:max-h-[92dvh] sm:w-[940px] sm:max-w-[940px] sm:grid-cols-[272px_1fr]",
          "motion-safe:animate-[vipRise_.5s_cubic-bezier(.16,.84,.36,1)]",
        ].join(" ")}
        style={{
          backgroundColor: INK,
          borderRadius: 16,
          boxShadow: "0 30px 90px rgba(0,0,0,.75)",
        }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close this offer"
          className="absolute right-3 top-3 z-30 grid h-8 w-8 place-items-center rounded-full text-white/70 transition-colors hover:text-white"
          style={{ backgroundColor: "rgba(4,8,26,.7)" }}
        >
          <IconX size={15} stroke={2.4} aria-hidden />
        </button>

        <Venues />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-col overflow-y-auto px-5 pb-2 pt-4 sm:px-8 sm:pb-3 sm:pt-6">
            <h2
              id="vip-popup-title"
              className="font-heading font-black uppercase text-white"
              style={{
                fontSize: "clamp(23px, 5.8vw, 36px)",
                lineHeight: 1.05,
                letterSpacing: "-1px",
              }}
            >
              <span className="block">Two Locations. One Price.</span>
              <span className="block" style={{ color: GOLD, textShadow: `0 0 40px ${GOLD}80` }}>
                Endless Memories.
              </span>
            </h2>

            <p
              className="font-body mt-2.5 hidden sm:block"
              style={{ color: BODY, fontSize: 16, lineHeight: 1.6, maxWidth: "52ch" }}
            >
              The {content.name} is one booking for both buildings. Pick a start time and we
              schedule the rest.
            </p>

            {/* Price as type, not as a badge — the Hero's glow treatment. */}
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:mt-4">
              <span
                className="font-heading font-black text-white"
                style={{
                  fontSize: "clamp(34px, 8vw, 46px)",
                  lineHeight: 1,
                  letterSpacing: "-1.5px",
                  textShadow: `0 0 40px ${GOLD}66`,
                }}
              >
                {content.weekdayPrice}
              </span>
              <span className="font-body" style={{ color: BODY, fontSize: 15 }}>
                per person, Mon–Thu
              </span>
              <span className="font-body" style={{ color: "rgba(245,236,238,0.45)", fontSize: 14 }}>
                {content.weekendPrice} Fri–Sun
              </span>
            </div>

            {/* Site idiom: uppercase Exo 2 lines at line-height 2, no icons. */}
            <ul
              className="font-heading mt-2.5 uppercase sm:mt-4"
              style={{
                color: BODY,
                fontSize: "clamp(12.5px, 3.3vw, 15px)",
                lineHeight: 1.75,
                letterSpacing: "0.8px",
              }}
            >
              {content.stops.map((stop) => (
                <li key={stop.name}>
                  {stop.name}
                  <span style={{ color: stop.accent === "lanes" ? "#a98cff" : CYAN }}>
                    {"  ·  "}
                    {stop.venue}
                  </span>
                </li>
              ))}
            </ul>

            {content.voucher && (
              <div
                className="mt-2.5 sm:mt-4"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${GOLD}`,
                  borderRadius: 8,
                  padding: "11px 14px",
                }}
              >
                <h3
                  className="font-heading uppercase"
                  style={{
                    color: GOLD,
                    fontSize: "clamp(13px, 3.4vw, 16px)",
                    letterSpacing: "1.2px",
                    lineHeight: 1.2,
                  }}
                >
                  {content.voucher.title}
                </h3>
                <ul
                  className="font-heading mt-1 uppercase"
                  style={{
                    color: BODY,
                    fontSize: "clamp(11.5px, 3.1vw, 14px)",
                    lineHeight: 1.65,
                    letterSpacing: "0.8px",
                  }}
                >
                  {content.voucher.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p
                  className="font-body mt-1.5"
                  style={{ color: "rgba(245,236,238,0.5)", fontSize: 11.5, lineHeight: 1.45 }}
                >
                  {content.voucher.note}
                </p>
              </div>
            )}

            {/* Table-stakes inclusions — desktop only. On a phone the vouchers
                above are what actually sells this, and the height is worth more. */}
            <p
              className="font-body mt-3 hidden sm:block"
              style={{ color: "rgba(245,236,238,0.55)", fontSize: 13, lineHeight: 1.5 }}
            >
              Racing license, POV race video, bowling shoes and chips &amp; salsa are included too.
            </p>
          </div>

          {/* Pinned footer — the button is never something you scroll to find. */}
          <div className="shrink-0 px-5 pb-4 pt-2 sm:px-8 sm:pb-6 sm:pt-3">
            <Link
              href={content.href}
              onClick={dismiss}
              className="font-body block text-center font-semibold uppercase transition-transform hover:scale-[1.02]"
              style={{
                backgroundColor: GOLD,
                color: INK,
                borderRadius: 555,
                padding: "16px 24px",
                fontSize: 14,
                letterSpacing: "1.5px",
                boxShadow: `0 0 20px ${GOLD}66`,
              }}
            >
              Book the VIP Experience
            </Link>
            <div
              className="font-body mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center"
              style={{ color: "rgba(245,236,238,0.4)", fontSize: 12 }}
            >
              <span>
                {content.durationLabel}
                {content.minHeadcount > 1 && ` · ${content.minHeadcount} guest minimum`}
                {content.startHoursLabel && ` · Starts ${content.startHoursLabel}`}
              </span>
              <button
                type="button"
                onClick={dismiss}
                className="underline underline-offset-2 transition-colors hover:text-white"
              >
                No thanks
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes vipFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes vipRise {
          from { opacity: 0; transform: scale(.965) }
          to   { opacity: 1; transform: scale(1) }
        }
      `}</style>
    </div>
  );
}

/* ── The two buildings, joined by the site's own racing stripe ─────────── */

function Venues() {
  return (
    <div className="relative grid h-[88px] min-w-0 shrink-0 grid-cols-2 sm:h-auto sm:grid-cols-1 sm:grid-rows-2">
      <Venue
        src={TRACK_IMG}
        alt="Karts under neon lighting on the FastTrax indoor track"
        venue="FastTrax"
        objectPosition="50% 42%"
      />
      <Venue
        src={LANES_IMG}
        alt="HeadPinz VIP bowling lanes beneath the NeoVerse LED video wall"
        venue="HeadPinz"
        objectPosition="56% 62%"
      />
      {/* Vertical between the phone's side-by-side panels, horizontal between
          the desktop's stacked ones. Two elements because the gradient axis
          flips too, and a 90deg gradient on a 1px-wide box renders flat. */}
      <span
        aria-hidden
        className="absolute left-1/2 top-0 z-20 h-full w-[3px] -translate-x-1/2 sm:hidden"
        style={{ backgroundImage: RACING_STRIPE_V }}
      />
      <span
        aria-hidden
        className="absolute left-0 top-1/2 z-20 hidden h-[3px] w-full -translate-y-1/2 sm:block"
        style={{ backgroundImage: RACING_STRIPE }}
      />
    </div>
  );
}

function Venue(props: { src: string; alt: string; venue: string; objectPosition: string }) {
  return (
    <figure className="relative m-0 overflow-hidden">
      <Image
        src={props.src}
        alt={props.alt}
        fill
        sizes="(max-width: 639px) 50vw, 300px"
        className="object-cover"
        style={{ objectPosition: props.objectPosition }}
      />
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(4,8,26,.55) 0%, rgba(4,8,26,.05) 45%, rgba(4,8,26,.9) 100%)",
        }}
      />
      <figcaption
        className="font-heading absolute inset-x-0 bottom-0 z-10 px-4 pb-3 font-black uppercase text-white"
        style={{ fontSize: 15, letterSpacing: "1px" }}
      >
        {props.venue}
      </figcaption>
    </figure>
  );
}
