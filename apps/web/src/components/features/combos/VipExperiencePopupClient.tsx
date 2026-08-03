"use client";

/**
 * Ultimate VIP Experience site popup — client half.
 *
 * Composition: a photographic diptych (the track / the VIP suite) split by a
 * single gold seam with the price medallion sitting ON the seam, so "two
 * locations, one price" reads before a word does. Below it the booked,
 * time-slotted stops run on a sector-timing rail, and the unscheduled bonus
 * attractions sit in a visually separate band — they are a different KIND of
 * thing and must not read as booked times.
 *
 * Layout flips at `sm`: a landscape two-column card on desktop (short enough
 * for a 1366x768 laptop) and a bottom sheet on phones. The sheet is sized to
 * fit WITHOUT internal scrolling down to an iPhone SE with the Safari bars
 * showing — the deck line and the secondary dismiss link are dropped below
 * `sm` to buy that headroom. `dvh` (not `vh`) so an iOS toolbar can never push
 * the CTA off-screen.
 *
 * Trigger rules live here, not in the layout: 20s dwell or 40% scroll, once
 * per visitor per 14 days, and never over a flow where a popup would be
 * hostile (booking, kiosk, admin). `?vip=1` forces it for smoke-testing.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowRight, IconCheck, IconClock, IconTicket, IconX } from "@tabler/icons-react";

const GOLD = "#FFD700";
const INK = "#04081a";
const TRACK_ACCENT = "#00e2e5";
const LANES_ACCENT = "#8652ff";

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

  const suppressed = SUPPRESSED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`),
  );

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
      // Keep Tab inside the dialog while it owns the screen.
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
    <div className="fixed inset-0 z-[130] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute inset-0 h-full w-full cursor-default bg-[rgba(2,4,14,0.74)] backdrop-blur-[3px] motion-safe:animate-[vipFade_.4s_ease]"
      />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vip-popup-title"
        tabIndex={-1}
        className={[
          // `min-w-0` on the card AND its columns is load-bearing: grid/flex
          // children default to min-width:auto, so one un-shrinkable child (the
          // eyebrow) silently widened the whole card past the viewport.
          "relative m-2 flex min-w-0 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl outline-none",
          "w-[calc(100%-1rem)] max-h-[calc(100dvh-1rem)]",
          "sm:m-0 sm:grid sm:max-h-[94dvh] sm:w-[872px] sm:max-w-[872px] sm:grid-cols-[292px_1fr]",
          "motion-safe:animate-[vipRise_.5s_cubic-bezier(.16,.84,.36,1)]",
        ].join(" ")}
        style={{
          backgroundColor: INK,
          border: `1px solid ${GOLD}57`,
          boxShadow: `0 30px 90px rgba(0,0,0,.7), 0 0 60px ${GOLD}17`,
        }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close this offer"
          className="absolute right-3 top-3 z-30 grid h-[30px] w-[30px] place-items-center rounded-full border border-white/20 bg-[rgba(4,8,26,.62)] text-white/80 backdrop-blur-sm transition-colors hover:bg-[rgba(4,8,26,.9)] hover:text-white"
        >
          <IconX size={14} stroke={2.4} aria-hidden />
        </button>

        <Diptych content={content} />

        {/* Column: scrolling content + a CTA footer pinned outside the scroll
            area. On any normal phone nothing scrolls at all; on the very
            smallest the button is still reachable without hunting for it. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-col gap-[6px] overflow-y-auto px-[15px] pb-1 pt-2 sm:gap-[13px] sm:px-6 sm:pb-2 sm:pt-5">
            <div className="flex min-w-0 items-center gap-2.5 pr-9">
              {/* Hidden on the sheet: it wrapped to three lines at 375px and the
                  headline already places you. Desktop keeps it as the eyebrow. */}
              <p
                className="hidden min-w-0 text-[9.5px] font-semibold uppercase tracking-[.22em] sm:block sm:shrink-0"
                style={{ color: "#e6c33a" }}
              >
                Fort Myers Entertainment Complex
              </p>
              <span
                className="hidden h-px flex-1 sm:block"
                style={{ background: `linear-gradient(90deg, ${GOLD}66, ${GOLD}0d)` }}
              />
              {content.durationLabel && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.13em] tabular-nums"
                  style={{
                    color: "#e6c33a",
                    backgroundColor: `${GOLD}1a`,
                    border: `1px solid ${GOLD}47`,
                  }}
                >
                  <IconClock size={11} stroke={2.2} aria-hidden />
                  {content.durationLabel}
                </span>
              )}
            </div>

            <h2
              id="vip-popup-title"
              className="font-display text-balance text-[22px] font-black uppercase leading-[.96] tracking-[-.018em] text-white sm:text-[34px]"
            >
              Two locations.
              <br />
              One price.
              <br />
              <span style={{ color: GOLD }}>Endless memories.</span>
            </h2>

            {/* Dropped below `sm` — the sheet needs the height more than it
                needs this line, and the headline plus the rail already say it. */}
            <p className="-mt-[3px] hidden max-w-[54ch] text-[13.5px] leading-[1.5] text-[#bdb7a8] sm:block">
              The <strong className="font-semibold text-white">{content.name}</strong> runs your
              whole night across both buildings — and it books as one reservation, on one bill.
            </p>

            <Rail stops={content.stops} />
            {content.voucher && <VoucherBand voucher={content.voucher} />}

            {/* Table-stakes inclusions. The sheet gets the short form on one
                line; the vouchers above are what actually differentiates. */}
            <p className="border-t border-white/10 pt-1.5 text-[9.5px] leading-[1.35] text-[#8d887b] sm:pt-[11px] sm:text-[11.5px] sm:leading-[1.5]">
              <b className="font-semibold text-[#bdb7a8]">In the price too:</b>{" "}
              <span className="sm:hidden">license, POV video, shoes &amp; chips.</span>
              <span className="hidden sm:inline">
                racing license, POV race video, bowling shoes and chips &amp; salsa.
              </span>
            </p>
          </div>

          {/* Pinned footer — outside the scroll area, so the button is never
              something you have to scroll to find. */}
          <div className="shrink-0 px-[15px] pb-[calc(0.7rem_+_env(safe-area-inset-bottom))] pt-1 sm:px-6 sm:pb-[20px] sm:pt-2">
            <Link
              href={content.href}
              onClick={dismiss}
              className="font-display flex w-full items-center justify-center gap-2.5 rounded-full py-[13px] text-[13px] font-black uppercase tracking-[.07em] transition-transform hover:-translate-y-px sm:py-[14px] sm:text-[14px] sm:tracking-[.09em]"
              style={{
                color: INK,
                backgroundImage: `linear-gradient(180deg, #ffe14d, ${GOLD})`,
                boxShadow: `0 8px 26px ${GOLD}3d`,
              }}
            >
              Book the VIP Experience
              <IconArrowRight size={16} stroke={2.6} aria-hidden />
            </Link>
            <button
              type="button"
              onClick={dismiss}
              className="mt-2 hidden w-full text-center text-[12px] text-[#8d887b] underline decoration-[#bdb7a859] underline-offset-[3px] transition-colors hover:text-[#bdb7a8] sm:block"
            >
              Maybe another night
            </button>
            <p className="mt-1.5 text-center text-[9.5px] leading-[1.4] tabular-nums text-[#6f6a5f] sm:mt-2 sm:text-[10.5px] sm:leading-[1.5]">
              {/* The sheet's medallion has no room for the day tier, so it lands
                  here instead — the price must never appear without its tier. */}
              <span className="sm:hidden">Per person: {content.weekdayPrice} Mon–Thu · </span>
              {content.weekendPrice} Fri–Sun
              {content.minHeadcount > 1 && ` · ${content.minHeadcount} guest minimum`}
              {content.startHoursLabel && ` · Starts ${content.startHoursLabel}`}
            </p>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes vipFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes vipRise {
          from { opacity: 0; transform: translateY(26px) }
          to   { opacity: 1; transform: translateY(0) }
        }
        @media (min-width: 640px) {
          @keyframes vipRise {
            from { opacity: 0; transform: scale(.965) }
            to   { opacity: 1; transform: scale(1) }
          }
        }
      `}</style>
    </div>
  );
}

/* ── The two venues, joined by one gold seam ───────────────────────────── */

function Diptych({ content }: { content: VipPopupContent }) {
  return (
    <div className="relative grid h-[80px] min-w-0 shrink-0 grid-cols-2 sm:h-auto sm:grid-cols-1 sm:grid-rows-2">
      <Panel
        src={TRACK_IMG}
        alt="Two karts under neon lighting on the FastTrax indoor track"
        venue="FastTrax"
        venueRole="The Track"
        accent={TRACK_ACCENT}
        objectPosition="50% 42%"
        captionClass="bottom-0 pb-2.5 sm:bottom-auto sm:top-0 sm:pb-0 sm:pt-[13px]"
      />
      <Panel
        src={LANES_IMG}
        alt="HeadPinz VIP bowling lanes beneath the NeoVerse LED video wall"
        venue="HeadPinz"
        venueRole="The VIP Suite"
        accent="#a98cff"
        objectPosition="56% 62%"
        captionClass="bottom-0 items-end pb-2.5 text-right sm:items-start sm:pb-[13px] sm:text-left"
      />

      {/* The joint between the two venues: vertical between the phone's
          side-by-side panels, horizontal between the desktop's stacked ones.
          Two elements rather than one responsive element, because the gradient
          axis has to flip too and a 180deg gradient on a 1px-tall box renders
          as a flat bar. */}
      <span
        aria-hidden
        className="absolute left-1/2 top-0 z-20 h-full w-px -translate-x-1/2 sm:hidden"
        style={{
          backgroundImage: `linear-gradient(180deg, ${GOLD}00, ${GOLD} 16%, ${GOLD} 84%, ${GOLD}00)`,
        }}
      />
      <span
        aria-hidden
        className="absolute left-0 top-1/2 z-20 hidden h-px w-full -translate-y-1/2 sm:block"
        style={{
          backgroundImage: `linear-gradient(90deg, ${GOLD}00, ${GOLD} 16%, ${GOLD} 84%, ${GOLD}00)`,
        }}
      />

      <div
        className="absolute left-1/2 top-1/2 z-30 flex h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full text-center sm:h-[112px] sm:w-[112px]"
        style={{
          backgroundColor: GOLD,
          color: INK,
          boxShadow: `0 0 0 5px rgba(4,8,26,.82), 0 10px 30px rgba(0,0,0,.6), 0 0 34px ${GOLD}57`,
        }}
      >
        <span className="font-display text-[25px] font-black leading-[.9] tracking-[-.03em] tabular-nums sm:text-[40px]">
          {content.weekdayPrice}
        </span>
        {/* A 68px disc can hold the number or the qualifier, not both — on the
            sheet "per person" and the day tier both move to the fine print. */}
        <span className="mt-[3px] hidden text-[8.5px] font-semibold uppercase tracking-[.15em] text-[rgba(4,8,26,.72)] sm:block">
          Per person
        </span>
        {/* The day tier moves to the footer fine print on the sheet — a 64px
            disc cannot carry three lines legibly. */}
        <span className="mt-1 hidden border-t border-[rgba(4,8,26,.24)] pt-[3px] text-[8px] font-semibold uppercase tracking-[.09em] tabular-nums text-[rgba(4,8,26,.68)] sm:mt-[5px] sm:block sm:pt-1">
          Mon–Thu
        </span>
      </div>
    </div>
  );
}

function Panel(props: {
  src: string;
  alt: string;
  venue: string;
  /** Not `role` — that reads as the ARIA attribute on a JSX element. */
  venueRole: string;
  accent: string;
  objectPosition: string;
  captionClass: string;
}) {
  return (
    <figure className="relative m-0 overflow-hidden">
      <Image
        src={props.src}
        alt={props.alt}
        fill
        sizes="(max-width: 639px) 50vw, 292px"
        className="object-cover"
        style={{ objectPosition: props.objectPosition }}
      />
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(4,8,26,.68) 0%, rgba(4,8,26,.10) 42%, rgba(4,8,26,.92) 100%)",
        }}
      />
      <figcaption
        className={`absolute inset-x-0 z-10 flex flex-col gap-[3px] px-[11px] sm:px-3.5 ${props.captionClass}`}
      >
        <span className="font-display text-[12.5px] font-bold uppercase leading-[1.1] tracking-[.06em] text-white">
          {props.venue}
        </span>
        {/* Hidden on the sheet: the medallion owns the middle of a 130px strip
            and these would collide. No information is lost — every rail stop
            and bonus tile already carries its building. */}
        <span
          className="hidden text-[9.5px] font-semibold uppercase tracking-[.19em] sm:block"
          style={{ color: props.accent }}
        >
          {props.venueRole}
        </span>
      </figcaption>
    </figure>
  );
}

/* ── Booked, time-slotted stops ────────────────────────────────────────── */

function Rail({ stops }: { stops: VipPopupStop[] }) {
  return (
    <div>
      {/* Hidden on the sheet: the gold dots and the two-venue diptych already
          read as "here is the plan", and the label costs a whole line. */}
      <p className="mb-1.5 hidden text-[9px] font-semibold uppercase tracking-[.2em] text-[#8d887b] sm:mb-[7px] sm:block">
        Your booked times
      </p>
      <ol className="relative grid grid-cols-3">
        <span
          aria-hidden
          className="absolute left-[9px] right-[9px] top-[5px] h-px"
          style={{
            backgroundImage: `linear-gradient(90deg, ${GOLD}24, ${GOLD}80, ${GOLD}24)`,
          }}
        />
        {stops.map((stop) => {
          const dot = stop.accent === "lanes" ? LANES_ACCENT : TRACK_ACCENT;
          return (
            <li
              key={stop.name}
              className="relative flex flex-col gap-0.5 pr-2 pt-3 sm:pr-3 sm:pt-[17px]"
            >
              <span
                aria-hidden
                className="absolute left-1 top-0 h-[11px] w-[11px] rounded-full"
                style={{ backgroundColor: INK, border: `2px solid ${dot}` }}
              />
              <span className="font-display text-[11px] font-bold uppercase leading-[1.15] tracking-[.01em] text-white sm:text-[12.5px] sm:tracking-[.03em]">
                {stop.name}
              </span>
              <span className="hidden text-[11px] leading-[1.35] text-[#8d887b] sm:block">
                {stop.note}
              </span>
              {/* Hidden on the sheet — the diptych above already names both
                  buildings, and the sheet needs the 13px more than the repeat. */}
              <span
                className="mt-0.5 hidden text-[8.5px] font-semibold uppercase tracking-[.15em] opacity-90 sm:block"
                style={{ color: dot }}
              >
                At {stop.venue}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ── Redeem-later vouchers — a different KIND of thing from the rail ────
   These are NOT booked times and NOT walk-up extras: one code, redeemable up
   to a year out, subject to availability. The band is visually a ticket, and
   the terms sit inside it so the offer and its limits can never be separated
   (an earlier draft of this ad implied unlimited walk-up access — it isn't). */

function VoucherBand({ voucher }: { voucher: VipPopupVoucher }) {
  return (
    <div
      className="rounded-lg px-2.5 py-1.5 sm:px-3 sm:py-2.5"
      style={{ backgroundColor: `${GOLD}0f`, border: `1px solid ${GOLD}33` }}
    >
      <p
        className="mb-1.5 flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[.14em] sm:text-[9px] sm:tracking-[.18em]"
        style={{ color: "#e6c33a" }}
      >
        <IconTicket size={12} stroke={2.2} aria-hidden />
        {voucher.title}
      </p>
      <ul className="flex flex-col gap-0.5 sm:gap-[3px]">
        {voucher.items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-1.5 text-[10px] leading-[1.3] text-[#d6d1c4] sm:text-[12px] sm:leading-[1.4]"
          >
            <IconCheck
              size={11}
              stroke={3}
              aria-hidden
              className="mt-[3px] shrink-0"
              style={{ color: GOLD }}
            />
            {item}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[8px] leading-[1.3] text-[#8d887b] sm:mt-1.5 sm:text-[9.5px] sm:leading-[1.4]">
        {voucher.note}
      </p>
    </div>
  );
}
