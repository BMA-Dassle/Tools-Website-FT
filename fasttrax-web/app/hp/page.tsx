import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "HeadPinz - Where Fun Comes Together | Fort Myers & Naples",
  description: "Premier bowling, laser tag, gel blasters, arcade games and dining in Fort Myers and Naples, Florida.",
};

const locations = [
  {
    name: "Fort Myers",
    address: "14513 Global Parkway",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    image: "https://headpinz.com/wp-content/uploads/2024/02/Pic-3-scaled.jpg",
  },
  {
    name: "Naples",
    address: "8525 Radio Lane",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    image: "https://headpinz.com/wp-content/uploads/2024/02/7bc74ef0-f7e7-4b82-a8e4-a0ddafbcb6ab.jpeg",
  },
];

const activities = ["BOWLING", "LASER TAG", "GEL BLASTERS", "ARCADE", "DINING"];

export default function HeadPinzHome() {
  return (
    <div className="min-h-screen bg-[#0a0518] flex flex-col items-center justify-center relative">
      {/* Video background */}
      {/* Static poster for immediate display + mobile */}
      <Image
        src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp"
        alt="HeadPinz"
        fill
        className="object-cover"
        sizes="100vw"
        priority
        unoptimized
      />
      {/* Video overlay — desktop only, lazy loaded */}
      <video
        autoPlay
        muted
        loop
        playsInline
        preload="none"
        className="absolute inset-0 w-full h-full object-cover hidden md:block"
        poster="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp"
      >
        <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hero-v2.mp4" type="video/mp4" />
      </video>
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-[#0a0518]" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-4 py-20 w-full max-w-4xl mx-auto">
        {/* Logo */}
        <div className="relative mb-6" style={{ width: "clamp(160px, 30vw, 280px)", height: "clamp(50px, 9vw, 90px)" }}>
          <Image
            src="https://headpinz.com/wp-content/uploads/2023/10/BOWL_HP_logo_Text.webp"
            alt="HeadPinz"
            fill
            className="object-contain"
            sizes="280px"
            unoptimized
            priority
          />
        </div>

        {/* Headline */}
        <h1
          className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-3"
          style={{ fontSize: "clamp(28px, 6vw, 64px)", lineHeight: "1.05", letterSpacing: "-1px" }}
        >
          Your Destination for Fun
        </h1>

        {/* Activities */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-10">
          {activities.map((act, i) => (
            <span key={act} className="flex items-center">
              <span className="font-[var(--font-hp-body)] text-white/60 uppercase tracking-widest" style={{ fontSize: "clamp(9px, 1.4vw, 13px)" }}>
                {act}
              </span>
              {i < activities.length - 1 && (
                <span className="text-[#fd5b56] ml-3" style={{ fontSize: "clamp(9px, 1.4vw, 13px)" }}>&bull;</span>
              )}
            </span>
          ))}
        </div>

        {/* Location selector — glass buttons */}
        <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] uppercase tracking-[0.3em] mb-4">
          Select Your Location
        </p>

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-lg">
          {locations.map((loc) => (
            <Link
              key={loc.name}
              href={loc.href}
              className="group flex-1 flex items-center justify-between gap-4 px-6 py-5 rounded-2xl border border-white/15 hover:border-[#fd5b56]/50 transition-all duration-300 hover:scale-[1.02]"
              style={{
                backgroundColor: "rgba(255,255,255,0.06)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              <div>
                <h2 className="font-[var(--font-hp-hero)] font-black uppercase text-white text-lg tracking-wide">
                  {loc.name}
                </h2>
                <p className="text-white/40 text-[11px] font-[var(--font-hp-body)]">{loc.address}</p>
              </div>
              <div className="w-9 h-9 rounded-full bg-[#fd5b56] flex items-center justify-center shrink-0 group-hover:bg-[#ff7a77] group-hover:shadow-[0_0_16px_rgba(253,91,86,0.4)] transition-all">
                <svg className="w-4 h-4 text-white transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          ))}
        </div>

        {/* 10yr badge */}
        <div className="mt-10 flex items-center gap-2 opacity-30">
          <div className="relative" style={{ width: 30, height: 30 }}>
            <Image
              src="https://headpinz.com/wp-content/uploads/2025/06/1-HeadPinz-10-Year-LOGO.png"
              alt="10 Years"
              fill
              className="object-contain"
              sizes="30px"
              unoptimized
            />
          </div>
          <span className="font-[var(--font-hp-body)] text-white text-[10px] tracking-widest uppercase">Celebrating 10 Years</span>
        </div>
      </div>
    </div>
  );
}
