"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import Nav from "@/components/Nav";
import { ATTRACTION_LIST } from "@/lib/attractions-data";
import type { AttractionConfig } from "@/lib/attractions-data";

// ── Attraction Card ─────────────────────────────────────────────────────────

function AttractionCard({ attraction }: { attraction: AttractionConfig }) {
  const href = attraction.slug === "racing" ? "/book/race" : `/book/${attraction.slug}`;
  const locationLabel =
    attraction.location === "both"
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
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-[10px] font-medium text-white/70 border border-white/10">
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
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-[10px] font-medium text-white/70 border border-white/10">
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
  return (
    <div className="min-h-screen bg-[#000418]">
      <Nav />

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

      {/* Account lookup banner */}
      <section className="px-4 pb-6 sm:pb-10">
        <div className="max-w-5xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#00E2E5]/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-[#00E2E5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <div>
                <p className="text-white text-sm font-medium">Have a FastTrax account?</p>
                <p className="text-white/40 text-xs">Sign in for faster checkout and to use your credits.</p>
              </div>
            </div>
            <Link
              href="/book/race"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold bg-white/8 border border-white/15 text-white hover:bg-white/12 transition-colors whitespace-nowrap"
            >
              Sign In
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* Attraction grid */}
      <section className="px-4 pb-20 sm:pb-28">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {ATTRACTION_LIST.map((a) => (
              <AttractionCard key={a.slug} attraction={a} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
