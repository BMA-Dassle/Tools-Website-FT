import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "HeadPinz – Bowling, Laser Tag, Arcade & Dining | Fort Myers & Naples FL",
  description:
    "Bowling from $13.99, laser tag, gel blasters, HyperBowling, NeoVerse, 40+ arcade games & Nemo's Sports Bistro. Two Southwest Florida locations. Book online — shoes included!",
  keywords: [
    "HeadPinz",
    "bowling Fort Myers",
    "bowling Naples",
    "bowling near me",
    "laser tag Fort Myers",
    "laser tag Naples",
    "gel blasters",
    "arcade Fort Myers",
    "arcade Naples",
    "HyperBowling",
    "NeoVerse",
    "family entertainment Southwest Florida",
    "things to do Fort Myers",
    "things to do Naples FL",
    "birthday party Fort Myers",
    "group events Fort Myers",
    "SWFL entertainment",
  ],
  openGraph: {
    title: "HeadPinz – Bowling, Laser Tag & More | Fort Myers & Naples",
    description:
      "Bowling from $13.99, laser tag, gel blasters, 40+ arcade games & dining. Two Southwest Florida locations. Shoes included — book online!",
    type: "website",
    url: "https://headpinz.com",
  },
  alternates: {
    canonical: "https://headpinz.com",
  },
};

const jsonLdSchemas = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "HeadPinz",
    url: "https://headpinz.com",
    logo: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/logo-white.png",
    description:
      "Premier bowling, laser tag, gel blasters, arcade games and dining in Fort Myers and Naples, Florida.",
    sameAs: [
      "https://www.facebook.com/headpinz",
      "https://www.instagram.com/headpinz",
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "HeadPinz",
    url: "https://headpinz.com",
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "HeadPinz Locations",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "HeadPinz Fort Myers",
        url: "https://headpinz.com/fort-myers",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "HeadPinz Naples",
        url: "https://headpinz.com/naples",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Book Bowling",
        url: "https://headpinz.com/book/bowling",
      },
      {
        "@type": "ListItem",
        position: 4,
        name: "Birthday Parties",
        url: "https://headpinz.com/fort-myers/birthdays",
      },
      {
        "@type": "ListItem",
        position: 5,
        name: "Group Events",
        url: "https://headpinz.com/fort-myers/group-events",
      },
      {
        "@type": "ListItem",
        position: 6,
        name: "Attractions",
        url: "https://headpinz.com/fort-myers/attractions",
      },
    ],
  },
];

const locations = [
  {
    name: "Fort Myers",
    address: "14513 Global Parkway",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/location-fm.jpg",
  },
  {
    name: "Naples",
    address: "8525 Radio Lane",
    hours: "Sun-Thu 11AM-12AM • Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/location-naples.jpeg",
  },
];

const activities = ["BOWLING", "LASER TAG", "GEL BLASTERS", "ARCADE", "DINING"];

export default function HeadPinzHome() {
  return (
    <div className="min-h-screen bg-[#0a1628] flex flex-col items-center justify-center relative">
      {jsonLdSchemas.map((schema, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
      ))}
      {/* Video background — plays on all devices, poster as fallback */}
      <video
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        className="absolute inset-0 w-full h-full object-cover"
        poster="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
      >
        <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hero-v3.mp4" type="video/mp4" />
      </video>
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-[#0a1628]" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-4 py-20 w-full max-w-4xl mx-auto">
        {/* Logo */}
        <div className="relative mb-6" style={{ width: "clamp(160px, 30vw, 280px)", height: "clamp(50px, 9vw, 90px)" }}>
          <Image
            src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp"
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
          className="font-heading font-black uppercase text-white mb-3"
          style={{ fontSize: "clamp(28px, 6vw, 64px)", lineHeight: "1.05", letterSpacing: "-1px" }}
        >
          Your Destination for Fun
        </h1>

        {/* Activities */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-10">
          {activities.map((act, i) => (
            <span key={act} className="flex items-center">
              <span className="font-body text-white/60 uppercase tracking-widest" style={{ fontSize: "clamp(9px, 1.4vw, 13px)" }}>
                {act}
              </span>
              {i < activities.length - 1 && (
                <span className="text-[#fd5b56] ml-3" style={{ fontSize: "clamp(9px, 1.4vw, 13px)" }}>&bull;</span>
              )}
            </span>
          ))}
        </div>

        {/* Location selector — glass buttons */}
        <p className="font-body text-white/30 text-xs uppercase tracking-[0.3em] mb-4">
          Select Your Location
        </p>

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-lg">
          {locations.map((loc) => (
            <Link
              key={loc.name}
              href={loc.href}
              className="group flex-1 flex items-center justify-between gap-4 px-6 py-5 rounded-2xl border border-[#123075]/40 hover:border-[#fd5b56]/50 transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(18,48,117,0.3)]"
              style={{
                backgroundColor: "rgba(255,255,255,0.06)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              <div>
                <h2 className="font-heading font-black uppercase text-white text-lg tracking-wide">
                  {loc.name}
                </h2>
                <p className="text-white/40 text-[13px] font-body">{loc.address}</p>
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
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/10yr-logo.png"
              alt="10 Years"
              fill
              className="object-contain"
              sizes="30px"
              unoptimized
            />
          </div>
          <span className="font-body text-white text-xs tracking-widest uppercase">Celebrating 10 Years</span>
        </div>
      </div>
    </div>
  );
}
