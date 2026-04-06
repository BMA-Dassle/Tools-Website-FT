import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "HeadPinz - Where Fun Comes Together | Fort Myers & Naples",
  description:
    "Choose your HeadPinz location. Premier bowling, laser tag, gel blasters, arcade games and dining in Fort Myers and Naples, Florida.",
  openGraph: {
    title: "HeadPinz - Where Fun Comes Together",
    description:
      "Premier bowling, laser tag, gel blasters, arcade & dining. Fort Myers and Naples locations.",
    type: "website",
    url: "https://headpinz.com",
  },
};

const locations = [
  {
    name: "Fort Myers",
    address: "14513 Global Parkway",
    city: "Fort Myers, FL 33913",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    image: "https://headpinz.com/wp-content/uploads/2024/02/Pic-3-scaled.jpg",
  },
  {
    name: "Naples",
    address: "8525 Radio Lane",
    city: "Naples, FL 34104",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    image: "https://headpinz.com/wp-content/uploads/2024/02/7bc74ef0-f7e7-4b82-a8e4-a0ddafbcb6ab.jpeg",
  },
];

const activities = ["BOWLING", "LASER TAG", "GEL BLASTERS", "ARCADE", "DINING"];

export default function HeadPinzHome() {
  return (
    <div className="min-h-screen bg-[#0a0518]">
      {/* ====== HERO — Video background ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 85vh, 900px)" }}>
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
        {/* Heavy gradient overlay for text legibility */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-[#0a0518]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(500px, 85vh, 900px)" }}>
          {/* Headline — Outfit Bold */}
          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{ fontSize: "clamp(36px, 8vw, 80px)", lineHeight: "1.05", letterSpacing: "-1px", marginBottom: "16px" }}
          >
            Your Destination<br />for Fun
          </h1>

          {/* Activity list */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-8">
            {activities.map((act, i) => (
              <span key={act} className="flex items-center">
                <span
                  className="font-[var(--font-hp-body)] text-white/80 uppercase tracking-widest"
                  style={{ fontSize: "clamp(11px, 1.8vw, 16px)" }}
                >
                  {act}
                </span>
                {i < activities.length - 1 && (
                  <span className="text-[#fd5b56] ml-3" style={{ fontSize: "clamp(11px, 1.8vw, 16px)" }}>&bull;</span>
                )}
              </span>
            ))}
          </div>

          {/* 10yr badge */}
          <div className="relative mb-2" style={{ width: "80px", height: "80px" }}>
            <Image
              src="https://headpinz.com/wp-content/uploads/2025/06/1-HeadPinz-10-Year-LOGO.png"
              alt="Celebrating 10 Years of Fun"
              fill
              className="object-contain"
              sizes="80px"
              unoptimized
            />
          </div>
          <p className="font-[var(--font-hp-body)] text-white/40 text-xs tracking-widest uppercase">
            Celebrating 10 Years
          </p>
        </div>
      </section>

      {/* ====== CHOOSE YOUR LOCATION ====== */}
      <section style={{ padding: "clamp(40px, 8vw, 80px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <h2
          className="font-[var(--font-hp-display)] uppercase text-white text-center"
          style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "clamp(32px, 6vw, 56px)" }}
        >
          Choose Your Location
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 max-w-5xl mx-auto">
          {locations.map((loc) => (
            <Link
              key={loc.name}
              href={loc.href}
              className="group relative block rounded-2xl overflow-hidden border-2 border-white/10 hover:border-[#fd5b56]/60 transition-all duration-300 hover:scale-[1.02]"
              style={{
                height: "clamp(320px, 45vw, 440px)",
                boxShadow: "0 4px 40px rgba(0,0,0,0.4)",
              }}
            >
              {/* Venue photo background */}
              <Image
                src={loc.image}
                alt={`HeadPinz ${loc.name}`}
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-105"
                sizes="(max-width: 768px) 100vw, 50vw"
                unoptimized
              />
              {/* Gradient overlay — stronger at bottom for text */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-black/20 group-hover:from-black/80 group-hover:via-black/30 transition-all duration-300" />

              {/* Coral glow on hover */}
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" style={{ boxShadow: "inset 0 0 60px rgba(253,91,86,0.15)" }} />

              {/* Content pinned to bottom */}
              <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
                <h3
                  className="font-[var(--font-hp-display)] uppercase text-white"
                  style={{ fontSize: "clamp(28px, 5vw, 40px)", letterSpacing: "3px", lineHeight: "1.1", marginBottom: "8px" }}
                >
                  {loc.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/80 text-sm mb-1">
                  {loc.address}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-xs mb-1">
                  {loc.city}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-5">
                  {loc.hours} &bull; {loc.hoursWeekend}
                </p>
                <span className="inline-flex items-center gap-2 bg-[#fd5b56] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all group-hover:bg-[#ff7a77] group-hover:shadow-[0_0_20px_rgba(253,91,86,0.4)]">
                  Explore
                  <svg
                    className="w-4 h-4 transition-transform group-hover:translate-x-1"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ====== GALLERY STRIP ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_1.webp", alt: "HeadPinz gallery" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp", alt: "HeadPinz entertainment" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_5.webp", alt: "HeadPinz fun" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_6.webp", alt: "HeadPinz action" },
          ].map((img) => (
            <div key={img.src} className="relative overflow-hidden rounded-lg" style={{ aspectRatio: "4/3" }}>
              <Image
                src={img.src}
                alt={img.alt}
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 640px) 50vw, 25vw"
                unoptimized
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
