"use client";

/**
 * HeadPinz Naples limited-time offer modal — client half.
 *
 * NAPLES ONLY. Scoped by `pathname.includes("naples")`, this repo's established
 * idiom for it (see HeadPinzNav), which deliberately matches both `/naples/*`
 * and the internal `/hp/naples/*` form — plus `?location=naples` so a
 * Naples-targeted ad landing anywhere still counts. Fort Myers never sees it.
 *
 * IT CANNOT OUTLIVE THE OFFER. The countdown owns the deadline: when it passes
 * the modal closes itself and `router.refresh()` re-runs the server shell, which
 * finds the window closed and renders nothing. The shell also refuses to render
 * past the deadline in the first place, so both a fresh load and a page left
 * open overnight land in the same place.
 *
 * WHAT IT CLAIMS (2026-08-10 run): a genuine 25% sale price that ends Friday
 * night, after which the packs really return to their regular prices — see the
 * server shell for the full reasoning and the honesty rule. `note` states the
 * before-and-after in plain words, in the footer, where it is read last.
 *
 * Trigger rules live here, not in the layout: 15s dwell or 35% scroll, once per
 * visitor per 3 days, and never over a flow where a modal would be hostile.
 * `?offer=1` forces it for smoke-testing.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconClockHour4, IconX } from "@tabler/icons-react";
import DealCountdown from "./DealCountdown";
import { isChromeFreePath } from "~/lib/constants/chrome-routes";

const INK = "#00041b";
const ACCENT = "#fd5b56";
const BODY = "rgba(245,236,238,0.8)";

/** localStorage key holding the epoch ms of the last dismissal. */
const SEEN_KEY = "hp:naples-offer:seen";
const REPEAT_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const DWELL_MS = 15_000;
const SCROLL_TRIGGER = 0.35;

/**
 * Routes that never show it. `/deals` is in the list for its own reason: popping
 * an ad for the deals over the deals page is pure friction between a guest and
 * the thing they already came for.
 */
const SUPPRESSED_PREFIXES = [
  "/book",
  "/kiosk",
  "/admin",
  "/checkout",
  "/deals",
  "/e/",
  "/s/",
  "/v/",
];

export interface NaplesOfferDeal {
  slug: string;
  name: string;
  priceLabel: string;
  /** Regular price for the strikethrough, or null when nothing is discounted. */
  wasLabel: string | null;
  savingsLabel: string;
  savingsPct: number;
  accent: string;
  image: string;
}

export interface NaplesOfferContent {
  endsAt: string;
  deals: NaplesOfferDeal[];
  note: string;
}

export function NaplesOfferPopupClient({ content }: { content: NaplesOfferContent }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  const suppressed =
    // See the twin in VipExperiencePopupClient: no site ads on a screen that
    // suppresses the site's own chrome.
    isChromeFreePath(pathname) ||
    SUPPRESSED_PREFIXES.some(
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

  /** Deadline passed while it was on screen: close, and let the server shell
   *  re-decide (it will find the window closed and render nothing). */
  const handleExpire = useCallback(() => {
    setExpired(true);
    setOpen(false);
    router.refresh();
  }, [router]);

  // Arm the trigger. Client-only signals (storage, scroll, URL), so an effect.
  useEffect(() => {
    if (suppressed) return;

    const params = new URLSearchParams(window.location.search);
    const forced = params.has("offer");

    // Naples gate. Pathname first — the priority order HeadPinzNav uses — then
    // an explicit ?location=, so an ad pointed at Naples still qualifies.
    const isNaples =
      pathname.includes("naples") ||
      (params.get("location") ?? "").toLowerCase().includes("naples");
    if (!isNaples && !forced) return;

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
  }, [suppressed, pathname]);

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

  if (!open || suppressed || expired) return null;

  const utm = "utm_source=site&utm_medium=popup&utm_campaign=naples_limited_offer";

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="naples-offer-title"
        tabIndex={-1}
        className="relative z-10 mx-4 flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/15 shadow-[0_30px_80px_rgba(0,0,0,0.6)] outline-none"
        style={{ background: INK }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 rounded-full bg-black/40 p-1.5 text-white/70 transition hover:bg-black/60 hover:text-white"
        >
          <IconX size={18} />
        </button>

        <div className="px-6 pt-7 pb-5 text-center" style={{ background: "rgba(253,91,86,0.12)" }}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fd5b56] px-3 py-1 text-xs font-bold tracking-[0.18em] text-[#00041b] uppercase">
            Flash Sale · 25% Off · Naples
          </span>
          <h2
            id="naples-offer-title"
            className="font-display mt-3 text-3xl leading-tight text-white sm:text-4xl"
          >
            25% off packs you won&apos;t find on our site
          </h2>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-white">
            <IconClockHour4 size={15} style={{ color: ACCENT }} aria-hidden="true" />
            <DealCountdown
              endsAt={content.endsAt}
              datePrefix="Offer ends "
              clockPrefix="Offer ends in "
              onExpire={handleExpire}
            />
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {content.deals.map((deal) => (
            <Link
              key={deal.slug}
              href={`/deals/${deal.slug}?location=naples&${utm}`}
              onClick={dismiss}
              className="group flex items-center gap-4 rounded-xl border border-white/12 bg-white/[0.04] p-3 transition hover:border-white/30 hover:bg-white/[0.07]"
            >
              <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg">
                <Image src={deal.image} alt="" fill sizes="80px" className="object-cover" />
              </div>
              <div className="min-w-0 flex-1">
                {/* Two lines, not `truncate` — at 390px the name is what clips,
                    and the product name is the one thing that has to survive. */}
                <p className="line-clamp-2 text-sm font-bold text-white">{deal.name}</p>
                <p className="mt-1 text-xs" style={{ color: BODY }}>
                  {deal.wasLabel && (
                    <span className="mr-1 text-white/40 line-through">{deal.wasLabel}</span>
                  )}
                  {deal.priceLabel} plus tax ·{" "}
                  <span className="font-semibold" style={{ color: deal.accent }}>
                    save {deal.savingsLabel} ({deal.savingsPct}%)
                  </span>
                </p>
              </div>
            </Link>
          ))}
        </div>

        <div className="border-t border-white/10 px-6 py-4">
          <Link
            href={`/deals?location=naples&${utm}`}
            onClick={dismiss}
            className="block rounded-full bg-[#fd5b56] px-6 py-3 text-center text-sm font-bold tracking-widest text-[#00041b] uppercase transition hover:brightness-110"
          >
            See the packs
          </Link>
          {/* Says precisely what is limited — the offer being extended here, not
              the price. Read last, remembered longest. */}
          <p className="mt-3 text-center text-[11px] leading-relaxed" style={{ color: BODY }}>
            {content.note}
          </p>
        </div>
      </div>
    </div>
  );
}
