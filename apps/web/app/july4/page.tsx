import type { Metadata } from "next";
import Link from "next/link";
import { IconCar, IconBowling, IconArrowRight } from "@tabler/icons-react";

/**
 * July-4 "USA250" promo landing — `/july4`.
 *
 * Standalone marketing page for the 25%-off Fourth-of-July offer that the
 * Usa250PromoPopup advertises. One job: state the offer and route the guest to
 * the right booking page (with `code=USA250` pre-applied) for their venue.
 *
 * Shared top-level route — served on BOTH fasttraxent.com and headpinz.com
 * (see `isSharedTopLevelRoute` in middleware.ts). Brand chrome is host-aware;
 * the hero is self-contained so the page reads complete on either domain.
 *
 * The coupon art (`public/promo/usa250-july4.png`) and the parchment backdrop
 * (`public/promo/july4-declaration.jpg`) are the supplied assets.
 *
 * Booking destinations carry the code so the discount is live on arrival:
 *   - FastTrax · Fort Myers  → /book/race/v2?code=USA250          (go-kart racing)
 *   - HeadPinz · Fort Myers  → /book/v2?code=USA250&location=fort-myers
 *   - HeadPinz · Naples      → /book/v2?code=USA250&location=naples
 */

export const metadata: Metadata = {
  title: "1776 Prices, 2026 Quality — 25% Off July 4th | FastTrax & HeadPinz",
  description:
    "Celebrate the Fourth of July with 25% off every reservation — go-kart racing, bowling, laser tag & more. Book July 4th, 2026 with code USA250 at FastTrax Fort Myers and HeadPinz Fort Myers & Naples.",
};

const BG_SRC = "/promo/july4-declaration.jpg";
const COUPON_SRC = "/promo/usa250-july4.png";
const FT_LOGO_SRC =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png";
const HP_LOGO_SRC =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp";

interface PromoLocation {
  brand: "FastTrax" | "HeadPinz";
  city: string;
  activities: string;
  href: string;
  Icon: typeof IconCar;
}

const LOCATIONS: PromoLocation[] = [
  {
    brand: "FastTrax",
    city: "Fort Myers",
    activities: "Go-Kart Racing",
    href: "/book/race/v2?code=USA250",
    Icon: IconCar,
  },
  {
    brand: "HeadPinz",
    city: "Fort Myers",
    activities: "Bowling · Laser Tag · Gel Blasters",
    href: "/book/v2?code=USA250&location=fort-myers",
    Icon: IconBowling,
  },
  {
    brand: "HeadPinz",
    city: "Naples",
    activities: "Bowling · Laser Tag · Gel Blasters",
    href: "/book/v2?code=USA250&location=naples",
    Icon: IconBowling,
  },
];

export default function July4PromoPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0a1628]">
      {/* ── Parchment backdrop — the Declaration of Independence ── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- single decorative promo backdrop */}
        <img src={BG_SRC} alt="" className="h-full w-full object-cover opacity-[0.45]" />
        {/* Deep-navy wash keeps text legible over the warm parchment */}
        <div className="absolute inset-0 bg-[#0a1628]/82" />
        {/* Patriotic glows — red top, gold center, blue bottom */}
        <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgba(226,59,63,0.22),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(45%_40%_at_50%_55%,rgba(212,175,55,0.12),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_100%,rgba(31,74,160,0.20),transparent_70%)]" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-4 pb-20 pt-12 text-center md:pt-16">
        {/* ── Dual-brand logos (no site nav on this page) ── */}
        <div className="mb-10 flex items-center justify-center gap-5 sm:gap-7">
          {/* eslint-disable-next-line @next/next/no-img-element -- brand logo */}
          <img
            src={FT_LOGO_SRC}
            alt="FastTrax Entertainment"
            className="h-11 w-auto object-contain sm:h-14"
          />
          <span aria-hidden className="h-9 w-px bg-white/20 sm:h-11" />
          {/* eslint-disable-next-line @next/next/no-img-element -- brand logo */}
          <img src={HP_LOGO_SRC} alt="HeadPinz" className="h-7 w-auto object-contain sm:h-9" />
        </div>

        {/* ── Offer headline ── */}
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.3em] text-[#E8C77A] md:text-sm">
          Fourth of July · One Day Only
        </p>
        <h1 className="font-display text-5xl uppercase leading-[0.92] tracking-tight text-white drop-shadow-[0_3px_16px_rgba(0,0,0,0.8)] sm:text-6xl md:text-7xl">
          25% Off Every
          <br />
          Reservation
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-white/80 md:text-lg">
          Race, bowl, blast and play for less. Book any reservation for{" "}
          <span className="font-semibold text-white">Saturday, July 4th, 2026</span> and take 25%
          off with code <span className="font-bold tracking-wider text-[#fd5b56]">USA250</span>.
        </p>

        {/* ── Coupon art ── */}
        <div className="mt-9 w-full max-w-lg">
          {/* eslint-disable-next-line @next/next/no-img-element -- supplied coupon graphic */}
          <img
            src={COUPON_SRC}
            alt="1776 Prices, 2026 Quality — 25% off all reservations July 4th. Use code USA250."
            className="block h-auto w-full rounded-2xl shadow-2xl ring-1 ring-white/10"
          />
        </div>

        {/* ── Location picker ── */}
        <p className="mt-12 text-xs font-semibold uppercase tracking-[0.3em] text-white/40">
          Pick your location to book
        </p>

        <div className="mt-5 grid w-full grid-cols-1 gap-3">
          {LOCATIONS.map((loc) => (
            <Link
              key={`${loc.brand}-${loc.city}`}
              href={loc.href}
              className="group flex items-center gap-4 rounded-2xl border border-white/12 bg-white/[0.06] px-5 py-4 text-left backdrop-blur-sm transition-all duration-300 hover:scale-[1.01] hover:border-[#fd5b56]/55 hover:bg-white/[0.09] hover:shadow-[0_0_28px_rgba(253,91,86,0.22)]"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#e23b3f]/15 text-[#fd5b56]">
                <loc.Icon size={24} stroke={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-heading text-lg font-bold uppercase tracking-wide text-white">
                  {loc.brand} <span className="text-white/55">·</span> {loc.city}
                </h2>
                <p className="text-[13px] text-white/55">{loc.activities}</p>
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e23b3f] text-white transition-all group-hover:bg-[#ff5a5e] group-hover:shadow-[0_0_16px_rgba(253,91,86,0.45)]">
                <IconArrowRight
                  size={18}
                  stroke={2.5}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </div>
            </Link>
          ))}
        </div>

        {/* ── Fine print ── */}
        <p className="mt-10 max-w-md text-xs leading-relaxed text-white/40">
          Discount applies to online reservations for July 4, 2026 only and is applied automatically
          at checkout with code USA250. Valid at FastTrax Fort Myers and HeadPinz Fort Myers &amp;
          Naples.
        </p>
      </div>
    </main>
  );
}
