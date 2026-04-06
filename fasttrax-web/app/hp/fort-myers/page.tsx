import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import BookingLink from "@/components/BookingLink";

export const metadata: Metadata = {
  title: "HeadPinz Fort Myers - Bowling, Laser Tag, Gel Blasters, Arcade & Dining",
  description:
    "Premier bowling, NEXUS laser tag, gel blaster arena, NeoVerse, HyperBowling, arcade gaming & Nemo's dining at HeadPinz Fort Myers. 14513 Global Parkway. Book now!",
  keywords: [
    "HeadPinz Fort Myers",
    "bowling Fort Myers",
    "laser tag Fort Myers",
    "gel blasters Fort Myers",
    "arcade Fort Myers",
    "HyperBowling",
    "NeoVerse",
    "things to do Fort Myers",
    "family entertainment Fort Myers",
    "bowling alley Fort Myers",
    "glow bowling Fort Myers",
  ],
  openGraph: {
    title: "HeadPinz Fort Myers - Bowling, Laser Tag, Arcade & More",
    description:
      "Premier bowling, NEXUS laser tag, gel blaster arena, arcade gaming & Nemo's dining at HeadPinz Fort Myers.",
    type: "website",
    url: "https://headpinz.com/hp/fort-myers",
  },
  alternates: {
    canonical: "https://headpinz.com/hp/fort-myers",
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
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: null,
    color: "#fd5b56",
  },
  {
    name: "NEXUS Laser Tag",
    tagline: "2-Story Glow Arena",
    description: "Immersive, multi-level space-themed combat. Haptic vests and precision sensors for objective-based missions.",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    price: "$10/person",
    cta: "Join the Mission",
    ctaHref: "/book/laser-tag",
    external: false,
    badge: null,
    color: "#fd5b56",
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
    color: "#9b51e0",
  },
  {
    name: "NeoVerse",
    tagline: "Interactive Video Wall Experience",
    description: "Step into a 360-degree immersive projection world. Touch-reactive walls, dynamic games, and mind-bending visuals.",
    image: "https://headpinz.com/wp-content/uploads/2024/02/neoverse.jpg",
    price: "Select VIP",
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: "VIP ONLY",
    color: "#9b51e0",
  },
  {
    name: "HyperBowling",
    tagline: "Where Bowling Meets Gaming",
    description: "LED-integrated bumper targets turn every throw into a scoring challenge. Dynamic gameplay meets physical skill.",
    image: "https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg",
    price: "Select VIP",
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: "VIP ONLY",
    color: "#fd5b56",
  },
  {
    name: "Game Zone",
    tagline: "40+ Premier Arcade Games",
    description: "The latest titles, VR simulators, and a prize center. Load any amount onto a Game Card at our kiosks and play.",
    image: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_4.webp",
    price: "Game Cards",
    cta: "Learn More",
    ctaHref: "#specials",
    external: false,
    badge: null,
    color: "#fd5b56",
  },
];

const specials = [
  {
    name: "Fun 4 All Day",
    when: "Mon-Thu before 6PM",
    regular: "$12.99",
    vip: "$14.99",
    note: "1.5 hours per lane",
    icon: "sun",
  },
  {
    name: "Fun 4 Night",
    when: "Mon-Thu 6PM-12AM",
    regular: "$15.99",
    vip: "$17.99",
    note: "1.5 hours per lane",
    icon: "moon",
  },
  {
    name: "Fri-Sat Bowling",
    when: "All day & night",
    regular: "$15.99",
    vip: "$17.99",
    note: "1.5 hours per lane",
    icon: "star",
  },
  {
    name: "Late Night Madness",
    when: "Fri-Sat 11PM-1AM",
    regular: "$11.99",
    vip: "$13.99",
    note: "2 hours unlimited",
    icon: "bolt",
  },
  {
    name: "Sunday Pizza Bowl",
    when: "Sundays all day",
    regular: "$64.95",
    vip: "$79.95",
    note: "2 hrs + shoes + pizza + soda per lane",
    icon: "pizza",
  },
];

const weeklyEvents = [
  { day: "Monday", event: "BOGO Laser Tag", color: "#fd5b56" },
  { day: "Tuesday", event: "Double Token Days", color: "#9b51e0" },
  { day: "Thursday", event: "Double Token Days", color: "#9b51e0" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function FortMyersPage() {
  return (
    <div className="bg-[#0a0518]">
      {/* ====== HERO — Video background ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 80vh, 800px)" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://headpinz.com/wp-content/uploads/2023/10/Caronchi_Photography_190226_4716-2048x1365-1.webp"
        >
          <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hero.mp4" type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a0518]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(500px, 80vh, 800px)" }}>
          {/* Logo */}
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
            style={{ fontSize: "clamp(36px, 8vw, 80px)", lineHeight: "1.05", letterSpacing: "-1px", marginBottom: "12px" }}
          >
            Fort Myers
          </h1>

          <p
            className="font-[var(--font-hp-body)] text-white/70 uppercase tracking-widest"
            style={{ fontSize: "clamp(11px, 1.8vw, 15px)", marginBottom: "20px", letterSpacing: "3px" }}
          >
            Bowling &bull; Laser Tag &bull; Gel Blasters &bull; Arcade &bull; Dining
          </p>

          <div className="mb-8" />

          <BookingLink
            href="https://www.mybowlingpassport.com/2/9172/book"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 hover:shadow-[0_0_30px_rgba(253,91,86,0.4)]"
          >
            Book Now
          </BookingLink>
        </div>
      </section>

      {/* ====== WHAT'S INSIDE — Attraction Cards ====== */}
      <section id="attractions" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <h2
          className="font-[var(--font-hp-display)] uppercase text-white text-center"
          style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "clamp(32px, 6vw, 56px)" }}
        >
          What&apos;s Inside
        </h2>

        <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {attractions.map((a) => (
            <div
              key={a.name}
              className="group relative flex flex-col rounded-2xl overflow-hidden border border-white/10 hover:border-[#fd5b56]/40 transition-all duration-300 hover:scale-[1.01]"
              style={{ backgroundColor: "rgba(10,5,24,0.6)" }}
            >
              {/* Card image */}
              <div className="relative overflow-hidden" style={{ height: "clamp(180px, 28vw, 240px)" }}>
                <Image
                  src={a.image}
                  alt={a.name}
                  fill
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  unoptimized
                />
                {/* Bottom gradient for text bleed */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0518] via-transparent to-transparent" />

                {/* Badge */}
                {a.badge && (
                  <span
                    className="absolute top-3 right-3 text-white text-xs font-bold font-[var(--font-hp-body)] uppercase tracking-wider px-3 py-1.5 rounded-full"
                    style={{ backgroundColor: "#9b51e0" }}
                  >
                    {a.badge}
                  </span>
                )}

                {/* Price badge */}
                <span
                  className="absolute bottom-3 left-4 font-[var(--font-hp-body)] font-bold text-sm px-3 py-1 rounded-full"
                  style={{ backgroundColor: a.color, color: "#fff" }}
                >
                  {a.price}
                </span>
              </div>

              {/* Card content */}
              <div className="flex flex-col flex-1 p-5">
                <h3
                  className="font-[var(--font-hp-display)] uppercase text-white"
                  style={{ fontSize: "clamp(16px, 2.5vw, 20px)", letterSpacing: "1.5px", marginBottom: "4px" }}
                >
                  {a.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-xs uppercase tracking-wider mb-3">
                  {a.tagline}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed flex-1 mb-4">
                  {a.description}
                </p>
                {a.external ? (
                  <BookingLink
                    href={a.ctaHref}
                    className="inline-flex items-center justify-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:shadow-[0_0_20px_rgba(253,91,86,0.3)]"
                  >
                    {a.cta}
                  </BookingLink>
                ) : (
                  <Link
                    href={a.ctaHref}
                    className="inline-flex items-center justify-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:shadow-[0_0_20px_rgba(253,91,86,0.3)]"
                  >
                    {a.cta}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ====== WEEKLY SPECIALS ====== */}
      <section id="specials" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <h2
          className="font-[var(--font-hp-display)] uppercase text-white text-center"
          style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "16px" }}
        >
          Weekly Specials
        </h2>
        <p className="font-[var(--font-hp-body)] text-white/50 text-center text-sm mb-10 max-w-lg mx-auto">
          Bowling specials run all week long. All prices per lane, 1.5 hours unless noted.
        </p>

        {/* Specials cards */}
        <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {specials.map((s) => (
            <div
              key={s.name}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 hover:border-[#fd5b56]/30 transition-all duration-300"
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
                  <span className="font-[var(--font-hp-display)] text-[#9b51e0]" style={{ fontSize: "28px" }}>
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

        {/* Weekly events row */}
        <div className="max-w-5xl mx-auto mt-8 flex flex-wrap justify-center gap-4">
          {weeklyEvents.map((e) => (
            <div
              key={e.day + e.event}
              className="flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5"
            >
              <span className="font-[var(--font-hp-body)] text-white/80 text-sm font-bold">
                {e.day}
              </span>
              <span
                className="font-[var(--font-hp-body)] text-sm font-bold"
                style={{ color: e.color }}
              >
                {e.event}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ====== GALLERY STRIP ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(40px, 6vw, 60px)" }}>
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
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_1.webp"
          alt="HeadPinz dining area"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-[#0a0518]/85" />
        <div className="relative z-10 max-w-4xl mx-auto text-center">
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white"
            style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "16px" }}
          >
            Nemo&apos;s Food &amp; Drinks
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/70 mx-auto mb-8"
            style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "600px", lineHeight: "1.6" }}
          >
            Fresh cooked pizza, famous jumbo wings, and a full menu of appetizers,
            burgers, wraps and more. Pair it with craft beers, cocktails, or
            signature mocktails.
          </p>
          <Link
            href="/menu"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105 hover:shadow-[0_0_30px_rgba(253,91,86,0.4)]"
          >
            View Full Menu
          </Link>
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
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0518] via-black/50 to-black/30" />
        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(350px, 50vh, 500px)" }}>
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white"
            style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px" }}
          >
            Ready for Some Fun?
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-8 max-w-md mx-auto">
            Reserve your lanes, book your battles, or just show up and play. We&apos;re open 7 days a week.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <BookingLink
              href="https://www.mybowlingpassport.com/2/9172/book"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3 rounded-full transition-all hover:scale-105"
            >
              Book Bowling
            </BookingLink>
            <Link
              href="/book/laser-tag"
              className="inline-flex items-center bg-white/10 hover:bg-white/20 border border-white/20 hover:border-[#fd5b56]/40 text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3 rounded-full transition-all hover:scale-105"
            >
              Book Laser Tag
            </Link>
            <Link
              href="/book/gel-blaster"
              className="inline-flex items-center bg-white/10 hover:bg-white/20 border border-white/20 hover:border-[#9b51e0]/40 text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3 rounded-full transition-all hover:scale-105"
            >
              Book Gel Blasters
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
