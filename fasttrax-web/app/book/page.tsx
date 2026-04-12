"use client";

import Image from "next/image";
import Link from "next/link";
import BrandNav from "@/components/BrandNav";
// MiniCart is rendered globally in root layout
import { ATTRACTION_LIST } from "@/lib/attractions-data";
import type { AttractionConfig } from "@/lib/attractions-data";
import { getBookingLocation } from "@/lib/booking-location";

// ── Attraction Card ─────────────────────────────────────────────────────────

function AttractionCard({ attraction, bookingLoc }: { attraction: AttractionConfig; bookingLoc: string | null }) {
  const href = attraction.slug === "racing" ? "/book/race"
    : attraction.slug === "bowling" ? (bookingLoc === "naples" ? "/hp/book/bowling?location=naples" : "/hp/book/bowling")
    : `/book/${attraction.slug}`;
  // Show specific building name — gel blaster/laser tag are at HeadPinz, not FastTrax
  const locationLabel = bookingLoc === "naples"
    ? "HeadPinz Naples"
    : attraction.building.includes("HeadPinz")
      ? "HeadPinz Fort Myers"
      : attraction.location === "both"
        ? "FastTrax & HeadPinz"
        : attraction.location === "fasttrax"
          ? "FastTrax Fort Myers"
        : "HeadPinz Fort Myers";

  return (
    <Link
      href={href}
      className="group relative flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden hover:border-white/20 hover:bg-white/[0.06] transition-all duration-300"
    >
      {/* Image */}
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={attraction.heroImage}
          alt={attraction.name}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#000418] via-[#000418]/40 to-transparent" />

        {/* Location badge */}
        <div className="absolute top-3 left-3">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-xs font-medium text-white/70 border border-white/10">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {locationLabel}
          </span>
        </div>

        {/* Duration badge */}
        {attraction.durationLabel && (
          <div className="absolute top-3 right-3">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-xs font-medium text-white/70 border border-white/10">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="10" />
                <path strokeLinecap="round" d="M12 6v6l4 2" />
              </svg>
              {attraction.durationLabel}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 p-4 sm:p-5">
        <h3 className="font-display text-lg sm:text-xl text-white uppercase tracking-wider mb-1.5">
          {attraction.name}
        </h3>
        <p className="text-white/50 text-sm leading-relaxed mb-4 flex-1">
          {attraction.description}
        </p>

        {/* CTA */}
        <div
          className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-xl font-bold text-sm transition-colors"
          style={{
            backgroundColor: attraction.color,
            color: "#000418",
          }}
        >
          Book Now
          <svg className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </div>
      </div>

      {/* Color accent line */}
      <div className="h-0.5 w-full" style={{ backgroundColor: attraction.color }} />
    </Link>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BookLandingPage() {
  const bookingLoc = getBookingLocation();

  // Filter attractions by current booking location
  // Fort Myers (headpinz + fasttrax) share all attractions — only Naples is filtered
  const filtered = ATTRACTION_LIST.filter(a => {
    if (!bookingLoc || bookingLoc === "headpinz" || bookingLoc === "fasttrax") return true;
    return a.products.some(p => p.location === bookingLoc) || a.location === bookingLoc;
  });

  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />

      {/* Hero */}
      <section className="pt-28 sm:pt-36 pb-8 sm:pb-12 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <h1 className="font-display text-3xl sm:text-5xl text-white uppercase tracking-widest mb-3">
            Book an Experience
          </h1>
          <p className="text-white/50 text-sm sm:text-base max-w-xl mx-auto leading-relaxed">
            High-speed racing, shuffleboard, duckpin bowling, laser tag, and more.
            Pick your adventure and lock in your time.
          </p>
        </div>
      </section>

      {/* Attraction grid */}
      <section className="px-4 pb-20 sm:pb-28">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {filtered.map((a) => (
              <AttractionCard key={a.slug} attraction={a} bookingLoc={bookingLoc} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
