"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

const locations = [
  {
    name: "Fort Myers",
    slug: "fort-myers",
    address: "14513 Global Parkway",
    city: "Fort Myers, FL 33913",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    image: "https://headpinz.com/wp-content/uploads/2024/02/Pic-3-scaled.jpg",
  },
  {
    name: "Naples",
    slug: "naples",
    address: "8525 Radio Lane",
    city: "Naples, FL 34104",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    image: "https://headpinz.com/wp-content/uploads/2024/02/7bc74ef0-f7e7-4b82-a8e4-a0ddafbcb6ab.jpeg",
  },
];

const activities = ["BOWLING", "LASER TAG", "GEL BLASTERS", "ARCADE", "DINING"];

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/`;
}

export default function HeadPinzHome() {
  const router = useRouter();

  // Auto-redirect returning visitors to their last location
  useEffect(() => {
    const lastLoc = getCookie("hp-location");
    if (lastLoc) {
      const loc = locations.find(l => l.slug === lastLoc);
      if (loc) router.replace(loc.href);
    }
  }, [router]);

  function handleLocationSelect(slug: string, href: string) {
    setCookie("hp-location", slug, 90); // Remember for 90 days
    router.push(href);
  }

  return (
    <div className="min-h-screen bg-[#0a0518] flex flex-col">
      {/* ====== FULL-SCREEN SPLASH ====== */}
      <div className="relative flex-1 flex flex-col items-center justify-center min-h-screen">
        {/* Video background */}
        <video
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp"
        >
          <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hero.mp4" type="video/mp4" />
        </video>

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a0518]" />

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center text-center px-4 py-16 w-full max-w-5xl mx-auto">
          {/* Logo */}
          <div className="relative mb-8" style={{ width: "clamp(180px, 35vw, 320px)", height: "clamp(55px, 10vw, 100px)" }}>
            <Image
              src="https://headpinz.com/wp-content/uploads/2023/10/BOWL_HP_logo_Text.webp"
              alt="HeadPinz"
              fill
              className="object-contain"
              sizes="320px"
              unoptimized
              priority
            />
          </div>

          {/* Headline */}
          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-4"
            style={{ fontSize: "clamp(32px, 7vw, 72px)", lineHeight: "1.05", letterSpacing: "-1px" }}
          >
            Your Destination<br />for Fun
          </h1>

          {/* Activity list */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-12">
            {activities.map((act, i) => (
              <span key={act} className="flex items-center">
                <span className="font-[var(--font-hp-body)] text-white/70 uppercase tracking-widest" style={{ fontSize: "clamp(10px, 1.6vw, 14px)" }}>
                  {act}
                </span>
                {i < activities.length - 1 && (
                  <span className="text-[#fd5b56] ml-3" style={{ fontSize: "clamp(10px, 1.6vw, 14px)" }}>&bull;</span>
                )}
              </span>
            ))}
          </div>

          {/* CHOOSE YOUR LOCATION */}
          <p className="font-[var(--font-hp-body)] text-white/40 text-xs uppercase tracking-[0.3em] mb-6">
            Select Your Location
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-3xl">
            {locations.map((loc) => (
              <button
                key={loc.slug}
                onClick={() => handleLocationSelect(loc.slug, loc.href)}
                className="group relative block rounded-2xl overflow-hidden border-2 border-white/10 hover:border-[#fd5b56]/60 transition-all duration-300 hover:scale-[1.02] text-left"
                style={{ height: "clamp(240px, 35vw, 360px)" }}
              >
                <Image
                  src={loc.image}
                  alt={`HeadPinz ${loc.name}`}
                  fill
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                  sizes="(max-width: 640px) 100vw, 50vw"
                  unoptimized
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-black/10 group-hover:from-black/80 transition-all duration-300" />

                <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                  <h2
                    className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-1"
                    style={{ fontSize: "clamp(24px, 4vw, 36px)", lineHeight: "1.1" }}
                  >
                    {loc.name}
                  </h2>
                  <p className="font-[var(--font-hp-body)] text-white/70 text-sm">{loc.address}</p>
                  <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-4">{loc.hours}</p>
                  <span className="inline-flex items-center gap-2 bg-[#fd5b56] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-5 py-2 rounded-full group-hover:bg-[#ff7a77] group-hover:shadow-[0_0_20px_rgba(253,91,86,0.4)] transition-all">
                    Enter
                    <svg className="w-4 h-4 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* 10yr */}
          <div className="mt-12 flex items-center gap-3 opacity-40">
            <div className="relative" style={{ width: 40, height: 40 }}>
              <Image
                src="https://headpinz.com/wp-content/uploads/2025/06/1-HeadPinz-10-Year-LOGO.png"
                alt="10 Years"
                fill
                className="object-contain"
                sizes="40px"
                unoptimized
              />
            </div>
            <span className="font-[var(--font-hp-body)] text-white text-xs tracking-widest uppercase">Celebrating 10 Years</span>
          </div>
        </div>
      </div>
    </div>
  );
}
