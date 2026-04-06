import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import BookingLink from "@/components/BookingLink";
import LaneAvailability from "@/components/headpinz/LaneAvailability";

export const metadata: Metadata = {
  title: "HeadPinz Naples - Bowling, Laser Tag, Arcade & Dining",
  description:
    "Premier bowling, NEXUS laser tag, NeoVerse, HyperBowling, arcade gaming & Nemo's dining at HeadPinz Naples. 8525 Radio Lane, Naples FL 34104. Book now!",
  keywords: [
    "HeadPinz Naples",
    "bowling Naples",
    "laser tag Naples",
    "arcade Naples",
    "HyperBowling",
    "NeoVerse",
    "things to do Naples",
    "family entertainment Naples",
    "bowling alley Naples",
    "glow bowling Naples",
  ],
  openGraph: {
    title: "HeadPinz Naples - Bowling, Laser Tag, Arcade & More",
    description:
      "Premier bowling, NEXUS laser tag, arcade gaming & Nemo's dining at HeadPinz Naples.",
    type: "website",
    url: "https://headpinz.com/hp/naples",
  },
  alternates: {
    canonical: "https://headpinz.com/hp/naples",
  },
};

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const attractions = [
  {
    name: "Premier Bowling",
    tagline: "24 State-of-the-Art Lanes",
    description: "Modern lanes with cosmic glow effects, VIP lounge lanes, and a full-service bar steps away. 1.5 hours, up to 6 per lane.",
    image: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp",
    price: "From $12.99",
    cta: "Reserve Lanes",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: null,
    accent: "#fd5b56",
    borderColor: "rgba(253,91,86,0.45)",
  },
  {
    name: "NEXUS Laser Tag",
    tagline: "2-Story Glow Arena",
    description: "Immersive, multi-level space-themed combat. Haptic vests and precision sensors for objective-based missions.",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    price: "$8.50/person",
    cta: "Join the Mission",
    ctaHref: "/book/laser-tag",
    external: false,
    badge: null,
    accent: "#E41C1D",
    borderColor: "rgba(228,28,29,0.45)",
  },
  {
    name: "NEXUS Gel Blasters",
    tagline: "Zero Mess. Total Mayhem.",
    description: "State-of-the-art blasters with haptic vests. Eco-friendly Gellets evaporate on impact. All the action, none of the cleanup.",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
    price: "$12/person",
    cta: "Book Gel Blasters",
    ctaHref: "/book/gel-blaster",
    external: false,
    badge: null,
    accent: "#9b51e0",
    borderColor: "rgba(155,81,224,0.45)",
  },
  {
    name: "NeoVerse",
    tagline: "Interactive Video Wall Experience",
    description: "Step into a 360-degree immersive projection world. Touch-reactive walls, dynamic games, and mind-bending visuals.",
    image: "https://headpinz.com/wp-content/uploads/2024/02/neoverse.jpg",
    price: "Select VIP",
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: "VIP ONLY",
    accent: "#FFD700",
    borderColor: "rgba(255,215,0,0.35)",
  },
  {
    name: "HyperBowling",
    tagline: "Where Bowling Meets Gaming",
    description: "LED-integrated bumper targets turn every throw into a scoring challenge. Dynamic gameplay meets physical skill.",
    image: "https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg",
    price: "Select VIP",
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: "VIP ONLY",
    accent: "#00E2E5",
    borderColor: "rgba(0,226,229,0.35)",
  },
  {
    name: "Game Zone",
    tagline: "40+ Premier Arcade Games",
    description: "The latest titles, VR simulators, and a prize center. Load any amount onto a Game Card at our kiosks and play.",
    image: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_4.webp",
    price: "Game Cards",
    cta: "Learn More",
    ctaHref: "/hp/naples/attractions",
    external: false,
    badge: null,
    accent: "#fd5b56",
    borderColor: "rgba(253,91,86,0.45)",
  },
];

const specials = [
  {
    name: "Fun 4 All Day",
    when: "Mon-Thu before 6PM",
    regular: "$12.99",
    vip: "$14.99",
    note: "1.5 hours per lane",
  },
  {
    name: "Fun 4 Night",
    when: "Mon-Thu 6PM-12AM",
    regular: "$15.99",
    vip: "$17.99",
    note: "1.5 hours per lane",
  },
  {
    name: "Fri-Sat Bowling",
    when: "All day & night",
    regular: "$15.99",
    vip: "$17.99",
    note: "1.5 hours per lane",
  },
  {
    name: "Late Night Madness",
    when: "Fri-Sat 11PM-1AM",
    regular: "$11.99",
    vip: "$13.99",
    note: "2 hours unlimited",
  },
  {
    name: "Sunday Pizza Bowl",
    when: "Sundays all day",
    regular: "$64.95",
    vip: "$79.95",
    note: "2 hrs + shoes + pizza + soda per lane",
  },
];

const weeklyEvents = [
  { day: "Monday", event: "BOGO Laser Tag", color: "#fd5b56" },
  { day: "Tuesday", event: "Double Token Days", color: "#00E2E5" },
  { day: "Thursday", event: "Double Token Days", color: "#00E2E5" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function NaplesPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO — Video background ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "100vh" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://headpinz.com/wp-content/uploads/2023/10/Caronchi_Photography_190226_4716-2048x1365-1.webp"
        >
          <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hero-v2.mp4" type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a1628]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "100vh" }}>
          <div className="relative mb-4" style={{ width: "clamp(140px, 25vw, 240px)", height: "clamp(42px, 7vw, 72px)" }}>
            <Image
              src="https://headpinz.com/wp-content/uploads/2023/10/BOWL_HP_logo_Text.webp"
              alt="HeadPinz"
              fill
              className="object-contain"
              sizes="240px"
              priority
              unoptimized
            />
          </div>

          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(36px, 8vw, 80px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "12px",
              textShadow: "0 0 40px rgba(253,91,86,0.35)",
            }}
          >
            Naples
          </h1>

          <p
            className="font-[var(--font-hp-body)] text-white/70 uppercase tracking-widest"
            style={{ fontSize: "clamp(11px, 1.8vw, 15px)", marginBottom: "20px", letterSpacing: "3px" }}
          >
            Bowling &bull; Laser Tag &bull; Gel Blasters &bull; Arcade &bull; Dining
          </p>

          <div className="mb-8" />

          <BookingLink
            href="https://www.mybowlingpassport.com/2/3148/book"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105"
            style={{ boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
          >
            Book Now
          </BookingLink>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== LOCATION INFO + LIVE AVAILABILITY ====== */}
      <section style={{ padding: "clamp(40px, 6vw, 60px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="space-y-4">
            <h2
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{ fontSize: "clamp(20px, 3vw, 28px)", textShadow: "0 0 30px rgba(253,91,86,0.25)" }}
            >
              HeadPinz Naples
            </h2>
            <div className="space-y-2">
              <a
                href="https://maps.google.com/?q=8525+Radio+Lane+Naples+FL+34104"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 text-white/70 hover:text-white transition-colors group"
              >
                <svg className="w-5 h-5 text-[#fd5b56] shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-sm">8525 Radio Lane<br />Naples, FL 34104</span>
              </a>
              <a href="tel:+12394553755" className="flex items-center gap-3 text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5 text-[#fd5b56] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                <span className="text-sm">(239) 455-3755</span>
              </a>
              <div className="flex items-center gap-3 text-white/50">
                <svg className="w-5 h-5 text-[#fd5b56] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm">Sun-Thu 11AM-12AM &bull; Fri-Sat 11AM-2AM</span>
              </div>
            </div>
          </div>

          <LaneAvailability location="naples" />
        </div>
      </section>

      {/* ====== WHAT'S INSIDE — Attraction Cards ====== */}
      <section id="attractions" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 56px)" }}>
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white"
            style={{
              fontSize: "clamp(28px, 6vw, 52px)",
              letterSpacing: "3px",
              marginBottom: "12px",
              textShadow: "0 0 40px rgba(253,91,86,0.3)",
            }}
          >
            What&apos;s Inside
          </h2>
          <div className="mx-auto h-1 w-24 rounded-full" style={{ background: "linear-gradient(90deg, #fd5b56, #123075)" }} />
        </div>

        <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {attractions.map((a) => (
            <div
              key={a.name}
              className="group relative flex flex-col rounded-lg overflow-hidden transition-all duration-300 hover:scale-[1.02]"
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: `1.78px dashed ${a.borderColor}`,
              }}
            >
              <div className="relative overflow-hidden" style={{ height: "clamp(180px, 28vw, 240px)" }}>
                <Image
                  src={a.image}
                  alt={a.name}
                  fill
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  unoptimized
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#071027] via-transparent to-transparent" />

                {a.badge && (
                  <span
                    className="absolute top-3 right-3 text-white text-[10px] font-bold font-[var(--font-hp-body)] uppercase tracking-wider px-3 py-1.5 rounded-full"
                    style={{ backgroundColor: a.accent }}
                  >
                    {a.badge}
                  </span>
                )}

                <span
                  className="absolute bottom-3 left-4 font-[var(--font-hp-body)] font-bold text-sm px-3 py-1 rounded-full"
                  style={{ backgroundColor: a.accent, color: "#fff" }}
                >
                  {a.price}
                </span>
              </div>

              <div className="flex flex-col flex-1 p-5">
                <h3
                  className="font-[var(--font-hp-display)] uppercase text-white"
                  style={{
                    fontSize: "clamp(16px, 2.5vw, 20px)",
                    letterSpacing: "1.5px",
                    marginBottom: "4px",
                    textShadow: `0 0 20px ${a.accent}40`,
                  }}
                >
                  {a.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-xs uppercase tracking-wider mb-3" style={{ color: a.accent }}>
                  {a.tagline}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed flex-1 mb-4">
                  {a.description}
                </p>
                {a.external ? (
                  <BookingLink
                    href={a.ctaHref}
                    className="inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:scale-105"
                    style={{ backgroundColor: a.accent, boxShadow: `0 0 16px ${a.accent}40` }}
                  >
                    {a.cta}
                  </BookingLink>
                ) : (
                  <Link
                    href={a.ctaHref}
                    className="inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:scale-105"
                    style={{ backgroundColor: a.accent, boxShadow: `0 0 16px ${a.accent}40` }}
                  >
                    {a.cta}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="text-center mt-10">
          <Link
            href="/hp/naples/attractions"
            className="inline-flex items-center gap-2 font-[var(--font-hp-body)] text-white/60 hover:text-white text-sm uppercase tracking-wider transition-colors"
          >
            View All Attractions
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </section>

      {/* ====== VIP EXPERIENCE ====== */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover hidden md:block"
          poster="https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg"
        >
          <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hyperbowling.mp4" type="video/mp4" />
        </video>
        <Image
          src="https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg"
          alt="HyperBowling VIP experience"
          fill
          className="object-cover md:hidden"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a1628]/70 via-[#0a1628]/50 to-[#0a1628]/80" />

        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <p className="font-[var(--font-hp-body)] text-[#FFD700] text-xs uppercase tracking-[0.3em] mb-3">
            Exclusive to HeadPinz
          </p>
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 60px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "16px",
              textShadow: "0 0 40px rgba(255,215,0,0.3)",
            }}
          >
            The VIP Experience
          </h2>
          <div className="mx-auto h-1 w-24 rounded-full mb-10" style={{ background: "linear-gradient(90deg, #FFD700, #fd5b56)" }} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
            <div
              className="rounded-lg p-8 text-left transition-all hover:scale-[1.01]"
              style={{
                backgroundColor: "rgba(7,16,39,0.6)",
                border: "1.78px dashed rgba(255,215,0,0.35)",
                backdropFilter: "blur(4px)",
                WebkitBackdropFilter: "blur(4px)",
              }}
            >
              <span className="inline-block font-[var(--font-hp-body)] text-[10px] uppercase tracking-[0.2em] text-[#0a1628] bg-[#FFD700] px-3 py-1 rounded-full mb-4 font-bold">
                VIP Exclusive
              </span>
              <h3
                className="font-[var(--font-hp-display)] uppercase text-white tracking-wider mb-3"
                style={{ fontSize: "clamp(18px, 3vw, 24px)", textShadow: "0 0 20px rgba(255,215,0,0.25)" }}
              >
                NeoVerse
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                Interactive LED video wall that transforms your bowling experience.
                Exclusive to VIP lanes.
              </p>
            </div>

            <div
              className="rounded-lg p-8 text-left transition-all hover:scale-[1.01]"
              style={{
                backgroundColor: "rgba(7,16,39,0.6)",
                border: "1.78px dashed rgba(0,226,229,0.35)",
                backdropFilter: "blur(4px)",
                WebkitBackdropFilter: "blur(4px)",
              }}
            >
              <span className="inline-block font-[var(--font-hp-body)] text-[10px] uppercase tracking-[0.2em] text-[#0a1628] bg-[#00E2E5] px-3 py-1 rounded-full mb-4 font-bold">
                VIP Exclusive
              </span>
              <h3
                className="font-[var(--font-hp-display)] uppercase text-white tracking-wider mb-3"
                style={{ fontSize: "clamp(18px, 3vw, 24px)", textShadow: "0 0 20px rgba(0,226,229,0.25)" }}
              >
                HyperBowling
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                LED targets in the bumpers — hit them for points while you bowl.
                Skill meets spectacle.
              </p>
            </div>
          </div>

          <BookingLink
            href="https://www.mybowlingpassport.com/2/3148/book"
            className="inline-flex items-center bg-[#FFD700] hover:bg-[#ffe44d] text-[#0a1628] font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105"
            style={{ boxShadow: "0 0 24px rgba(255,215,0,0.35)" }}
          >
            Book VIP Lanes
          </BookingLink>
        </div>
      </section>

      {/* ====== WEEKLY SPECIALS ====== */}
      <section id="specials" className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 30% 20%, rgba(18,48,117,0.2) 0%, transparent 60%), radial-gradient(ellipse at 70% 80%, rgba(253,91,86,0.08) 0%, transparent 50%), #0a1628" }} />
        <div className="relative z-10">
          <div className="text-center" style={{ marginBottom: "16px" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{
                fontSize: "clamp(28px, 6vw, 52px)",
                letterSpacing: "3px",
                marginBottom: "12px",
                textShadow: "0 0 30px rgba(253,91,86,0.25)",
              }}
            >
              Weekly Specials
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: "linear-gradient(90deg, #fd5b56, #123075)" }} />
          </div>
          <p className="font-[var(--font-hp-body)] text-white/50 text-center text-sm mb-10 max-w-lg mx-auto">
            Bowling specials run all week long. All prices per lane, 1.5 hours unless noted.
          </p>

          <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {specials.map((s) => (
              <div
                key={s.name}
                className="rounded-lg p-6 transition-all duration-300 hover:scale-[1.01]"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgba(253,91,86,0.25)",
                }}
              >
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-1">
                  {s.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs uppercase tracking-wider mb-4">
                  {s.when}
                </p>
                <div className="flex items-baseline gap-4 mb-3">
                  <div>
                    <span className="font-[var(--font-hp-display)] text-[#fd5b56]" style={{ fontSize: "28px" }}>
                      {s.regular}
                    </span>
                    <span className="font-[var(--font-hp-body)] text-white/40 text-xs ml-1">regular</span>
                  </div>
                  <div>
                    <span className="font-[var(--font-hp-display)] text-[#00E2E5]" style={{ fontSize: "28px" }}>
                      {s.vip}
                    </span>
                    <span className="font-[var(--font-hp-body)] text-white/40 text-xs ml-1">VIP</span>
                  </div>
                </div>
                {s.note && (
                  <p className="font-[var(--font-hp-body)] text-white/50 text-xs">
                    {s.note}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="max-w-5xl mx-auto mt-8 flex flex-wrap justify-center gap-4">
            {weeklyEvents.map((e) => (
              <div
                key={e.day + e.event}
                className="flex items-center gap-3 rounded-full px-5 py-2.5"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${e.color}35`,
                }}
              >
                <span className="font-[var(--font-hp-body)] text-white/80 text-sm font-bold">
                  {e.day}
                </span>
                <span className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: e.color }}>
                  {e.event}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== GALLERY STRIP ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(40px, 6vw, 60px)" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp", alt: "HeadPinz entertainment" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_5.webp", alt: "HeadPinz fun" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_6.webp", alt: "HeadPinz action" },
            { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_7.webp", alt: "HeadPinz venue" },
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

      {/* ====== NEMO'S FOOD & DRINKS ====== */}
      <section id="menu" className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 70% 30%, rgba(253,91,86,0.08) 0%, transparent 50%), radial-gradient(ellipse at 20% 70%, rgba(18,48,117,0.15) 0%, transparent 60%), #0a1628" }} />
        <div className="relative z-10 max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
            <div>
              <h2
                className="font-[var(--font-hp-display)] uppercase text-white"
                style={{
                  fontSize: "clamp(28px, 6vw, 52px)",
                  letterSpacing: "3px",
                  marginBottom: "12px",
                  textShadow: "0 0 30px rgba(253,91,86,0.25)",
                }}
              >
                Nemo&apos;s Food &amp; Drinks
              </h2>
              <div className="h-1 w-24 rounded-full mb-6" style={{ background: "linear-gradient(90deg, #fd5b56, #123075)" }} />
              <p
                className="font-[var(--font-hp-body)] text-white/70 mb-8"
                style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "500px", lineHeight: "1.6" }}
              >
                Fresh cooked pizza, famous jumbo wings, and a full menu of appetizers,
                burgers, wraps and more. Pair it with craft beers, cocktails, or
                signature mocktails.
              </p>
              <Link
                href="/menu"
                className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
                style={{ boxShadow: "0 0 20px rgba(253,91,86,0.3)" }}
              >
                View Full Menu
              </Link>
            </div>
            <div
              className="relative rounded-lg overflow-hidden"
              style={{ aspectRatio: "4/3", border: "1.78px dashed rgba(253,91,86,0.3)" }}
            >
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png"
                alt="Nemo's famous jumbo wings"
                fill
                className="object-cover"
                sizes="(max-width: 768px) 100vw, 50vw"
                unoptimized
              />
            </div>
          </div>
        </div>
      </section>

      {/* ====== BOTTOM CTA ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(350px, 50vh, 500px)" }}>
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Caronchi_Photography_190226_4755-2048x1365-1-1024x683.webp"
          alt="HeadPinz bowling wide view"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-black/50 to-black/30" />
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#123075] via-white/60 to-[#fd5b56]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(350px, 50vh, 500px)" }}>
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white"
            style={{
              fontSize: "clamp(24px, 5vw, 44px)",
              letterSpacing: "3px",
              marginBottom: "12px",
              textShadow: "0 0 30px rgba(253,91,86,0.3)",
            }}
          >
            Ready for Some Fun?
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-8 max-w-md mx-auto">
            Reserve your lanes, book your battles, or just show up and play. We&apos;re open 7 days a week.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <BookingLink
              href="https://www.mybowlingpassport.com/2/3148/book"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3 rounded-full transition-all hover:scale-105"
              style={{ boxShadow: "0 0 16px rgba(253,91,86,0.3)" }}
            >
              Book Bowling
            </BookingLink>
            <Link
              href="/book/laser-tag"
              className="inline-flex items-center bg-white/10 hover:bg-white/20 border border-white/20 hover:border-[#fd5b56]/40 text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3 rounded-full transition-all hover:scale-105"
            >
              Book Laser Tag
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
