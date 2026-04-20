"use client";

import Image from "next/image";
import Link from "next/link";
import HeadPinzNav from "@/components/headpinz/Nav";
import { ATTRACTIONS, type AttractionConfig } from "@/lib/attractions-data";
import { getBookingLocation } from "@/lib/booking-location";

/**
 * HeadPinz booking hub — served at `headpinz.com/book` (via middleware
 * rewrite from /book → /hp/book on HP host). Mirror of the FastTrax
 * `/book` landing but:
 *   - HeadPinz palette (coral #fd5b56 + navy #123075 on #0a1628 bg)
 *   - Only HP-relevant attractions (bowling, shuffly, laser tag, gel
 *     blasters — skips karting and duckpin which are FastTrax-only)
 *   - A "Plan a group event" card at the end for 20+ groups
 *
 * Bowling is pulled from `ATTRACTIONS.bowling` directly (it's excluded
 * from `ATTRACTION_LIST` because it uses a separate QAMF flow), then
 * shuffly / laser-tag / gel-blaster are appended in display order.
 *
 * If location is set to Naples via ?location=naples or the BookingLocation
 * store, attractions + href links auto-adjust to Naples equivalents.
 */

// HeadPinz brand tokens (mirror the hp/* pages).
const CORAL = "#fd5b56";
const NAVY = "#123075";
const GOLD = "#FFD700";
const BG = "#0a1628";

function AttractionCard({
  attraction,
  bookingLoc,
}: {
  attraction: AttractionConfig;
  bookingLoc: string | null;
}) {
  const naplesMode = bookingLoc === "naples";

  const href =
    attraction.slug === "bowling"
      ? naplesMode
        ? "/hp/book/bowling?location=naples"
        : "/hp/book/bowling"
      : `/book/${attraction.slug}${naplesMode ? "?location=naples" : ""}`;

  const locationLabel = naplesMode ? "HeadPinz Naples" : "HeadPinz Fort Myers";

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
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />

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
        <h3 className="font-heading font-black text-lg sm:text-xl text-white uppercase tracking-wider mb-1.5">
          {attraction.name}
        </h3>
        <p className="font-body text-white/50 text-sm leading-relaxed mb-4 flex-1">
          {attraction.description}
        </p>

        <div
          className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-xl font-bold text-sm transition-colors"
          style={{ backgroundColor: attraction.color, color: "#ffffff" }}
        >
          Book Now
          <svg className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </div>
      </div>

      <div className="h-0.5 w-full" style={{ backgroundColor: attraction.color }} />
    </Link>
  );
}

export default function HeadPinzBookLandingPage() {
  const bookingLoc = getBookingLocation();
  const naplesMode = bookingLoc === "naples";
  const eventsHref = naplesMode ? "/naples/group-events" : "/fort-myers/group-events";

  // Explicit HP attraction order: bowling first (not in ATTRACTION_LIST —
  // it has its own QAMF flow), then the multi-location attractions.
  const hpAttractions: AttractionConfig[] = [
    ATTRACTIONS.bowling,
    ATTRACTIONS.shuffly,
    ATTRACTIONS["laser-tag"],
    ATTRACTIONS["gel-blaster"],
  ];

  // If Naples, filter to attractions that have a Naples product.
  const filtered = naplesMode
    ? hpAttractions.filter((a) => a.products.some((p) => p.location === "naples"))
    : hpAttractions;

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      {/* Hero */}
      <section className="pt-28 sm:pt-36 pb-8 sm:pb-12 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-3"
            style={{ color: CORAL, fontSize: "12px", letterSpacing: "3px" }}
          >
            Book Online
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(28px, 6vw, 56px)",
              lineHeight: 1.05,
              letterSpacing: "-0.6px",
              marginBottom: "16px",
            }}
          >
            What are you in the mood for?
          </h1>
          <p
            className="font-body text-white/60 mx-auto"
            style={{ fontSize: "clamp(14px, 1.8vw, 18px)", lineHeight: 1.6, maxWidth: "48ch" }}
          >
            Bowling lanes, NEXUS laser tag, gel blasters, shuffleboard — pick your vibe and lock in
            a time. Small groups self-serve online; larger parties get a dedicated planner.
          </p>
        </div>
      </section>

      {/* Attraction grid */}
      <section className="px-4 pb-10">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {filtered.map((a) => (
              <AttractionCard key={a.slug} attraction={a} bookingLoc={bookingLoc} />
            ))}
          </div>
        </div>
      </section>

      {/* Group-event CTA block */}
      <section className="px-4 pb-20 sm:pb-28">
        <div className="max-w-5xl mx-auto">
          <div
            className="rounded-2xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5"
            style={{
              backgroundColor: `${NAVY}25`,
              border: `1.78px solid ${GOLD}40`,
            }}
          >
            <div className="flex-1">
              <div
                className="uppercase font-bold mb-2"
                style={{ color: GOLD, fontSize: "10px", letterSpacing: "3px" }}
              >
                Groups of 20+
              </div>
              <h2
                className="font-heading font-black uppercase italic text-white mb-2"
                style={{ fontSize: "clamp(20px, 3vw, 28px)", lineHeight: 1.15, letterSpacing: "-0.3px" }}
              >
                Looking for the ultimate VIP experience?
              </h2>
              <p
                className="font-body text-white/70"
                style={{ fontSize: "14px", lineHeight: 1.6, maxWidth: "52ch" }}
              >
                Let our event planners handle the whole thing — bowling, food, drinks, arcade,
                laser tag — so you can focus on the fun. Birthdays, corporate outings, team
                building, celebrations.
              </p>
            </div>
            <Link
              href={eventsHref}
              className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-6 py-3.5 rounded-full transition-all hover:scale-105 whitespace-nowrap no-underline"
              style={{ backgroundColor: GOLD, color: BG }}
            >
              Plan a group event →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
