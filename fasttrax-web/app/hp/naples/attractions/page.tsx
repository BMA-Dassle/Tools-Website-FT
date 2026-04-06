import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import BookingLink from "@/components/BookingLink";
import AttractionVideo from "@/components/headpinz/AttractionVideo";

export const metadata: Metadata = {
  title:
    "All Attractions - Bowling, Laser Tag, Gel Blasters, VIP, Arcade | HeadPinz Naples",
  description:
    "Explore everything at HeadPinz Naples: 24-lane premier bowling, NEXUS laser tag, NeoVerse, HyperBowling, and 40+ arcade games. Six attractions under one roof.",
  keywords: [
    "HeadPinz Naples attractions",
    "bowling Naples",
    "laser tag Naples",
    "NeoVerse Naples",
    "HyperBowling Naples",
    "arcade Naples",
    "things to do Naples",
    "family entertainment Naples",
    "VIP bowling Naples",
  ],
  openGraph: {
    title: "All Attractions - HeadPinz Naples",
    description:
      "Six attractions under one roof: premier bowling, NEXUS laser tag, NeoVerse, HyperBowling, and 40+ arcade games.",
    type: "website",
    url: "https://headpinz.com/hp/naples/attractions",
  },
  alternates: {
    canonical: "https://headpinz.com/hp/naples/attractions",
  },
};

/* ------------------------------------------------------------------ */
/*  Attraction data                                                    */
/* ------------------------------------------------------------------ */

const attractions = [
  {
    name: "Premier Bowling",
    subtitle: "24 State-of-the-Art Lanes",
    description:
      "24 state-of-the-art lanes with cosmic glow effects, VIP lounge lanes, and a full-service bar steps away.",
    details: "Up to 6 per lane \u2022 Shoes included \u2022 1.5hr sessions",
    pricing: "Starting at $12.99/person (Mon\u2013Thu before 6PM)",
    image:
      "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp",
    cta: "Reserve Lanes",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: null,
    accent: "#fd5b56",
    borderColor: "rgba(253,91,86,0.45)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-bowling.mp4",
  },
  {
    name: "NEXUS Laser Tag",
    subtitle: "2-Story Glow Arena",
    description:
      "Two-story glow-in-the-dark space-themed arena with immersive, objective-based missions.",
    details: "15 min sessions \u2022 Team-based missions",
    pricing: "$8.50/person",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    cta: "Book Laser Tag",
    ctaHref: "/book/laser-tag",
    external: false,
    badge: null,
    accent: "#E41C1D",
    borderColor: "rgba(228,28,29,0.45)",
  },
  {
    name: "NEXUS Gel Blasters",
    subtitle: "Zero Mess. Total Mayhem.",
    description:
      "State-of-the-art blasters with haptic vests and eco-friendly Gellets that evaporate on impact.",
    details: "Glow arena \u2022 Real-time scoring \u2022 Power-ups",
    pricing: "$12/person",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
    cta: "Book Gel Blasters",
    ctaHref: "/book/gel-blaster",
    external: false,
    badge: null,
    accent: "#9b51e0",
    borderColor: "rgba(155,81,224,0.45)",
  },
  {
    name: "NeoVerse",
    subtitle: "Interactive Video Wall Experience",
    description:
      "Interactive LED video wall that transforms your bowling experience into an immersive visual spectacle.",
    details: "Exclusive to VIP lanes \u2022 Immersive visuals",
    pricing: "Included with VIP",
    image: "https://headpinz.com/wp-content/uploads/2024/02/neoverse.jpg",
    cta: "Book VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: "VIP EXCLUSIVE",
    accent: "#FFD700",
    borderColor: "rgba(255,215,0,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-neoverse.mp4",
  },
  {
    name: "HyperBowling",
    subtitle: "Where Bowling Meets Gaming",
    description:
      "LED targets in the bumpers \u2014 hit them for points while you bowl. Skill meets spectacle.",
    details: "VIP lanes only \u2022 Dynamic scoring",
    pricing: "Included with VIP",
    image:
      "https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg",
    cta: "Book VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/3148/book",
    external: true,
    badge: "VIP EXCLUSIVE",
    accent: "#FFD700",
    borderColor: "rgba(255,215,0,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hyperbowling.mp4",
  },
  {
    name: "Game Zone",
    subtitle: "40+ Premier Arcade Games",
    description:
      "40+ premier arcade games, VR simulators, and The Winner\u2019s Circle prize center.",
    details: "Load any amount onto a Game Card at kiosks",
    pricing: "Game Cards available on-site",
    image:
      "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_6.webp",
    cta: "Learn More",
    ctaHref: "/hp/naples#specials",
    external: false,
    badge: null,
    accent: "#00E2E5",
    borderColor: "rgba(0,226,229,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-arcade.mp4",
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function NaplesAttractionsPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO — Video background ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "80vh" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp"
        >
          <source
            src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-bowling.mp4"
            type="video/mp4"
          />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "80vh" }}
        >
          <p
            className="font-[var(--font-hp-body)] text-[#fd5b56] uppercase tracking-[0.3em] mb-4"
            style={{ fontSize: "clamp(11px, 1.8vw, 14px)" }}
          >
            HeadPinz Naples
          </p>
          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(40px, 10vw, 90px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "16px",
              textShadow: "0 0 40px rgba(253,91,86,0.35)",
            }}
          >
            What&apos;s Inside
          </h1>
          <p
            className="font-[var(--font-hp-body)] text-white/70 uppercase tracking-widest"
            style={{
              fontSize: "clamp(12px, 2vw, 16px)",
              letterSpacing: "3px",
            }}
          >
            Six attractions under one roof
          </p>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== ATTRACTION CARDS — Alternating layout ====== */}
      <section
        style={{
          padding: "clamp(40px, 8vw, 80px) clamp(16px, 4vw, 32px)",
        }}
      >
        <div className="max-w-7xl mx-auto flex flex-col" style={{ gap: "clamp(40px, 8vw, 80px)" }}>
          {attractions.map((a, i) => {
            const isEven = i % 2 === 1;

            return (
              <div
                key={a.name}
                className={`relative rounded-lg overflow-hidden ${
                  isEven ? "md:flex-row-reverse" : ""
                }`}
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${a.borderColor}` }}
              >
                <div
                  className={`flex flex-col md:flex-row ${
                    isEven ? "md:flex-row-reverse" : ""
                  }`}
                >
                  {/* Image side */}
                  <div className="relative md:w-[60%] flex-shrink-0" style={{ minHeight: "400px" }}>
                    <Image
                      src={a.image}
                      alt={a.name}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, 60vw"
                      unoptimized
                    />
                    <div
                      className={`absolute inset-0 ${
                        isEven
                          ? "bg-gradient-to-l md:bg-gradient-to-r"
                          : "bg-gradient-to-r md:bg-gradient-to-l"
                      } from-transparent via-transparent to-[#0a1628]/90 hidden md:block`}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a1628]/90 md:hidden" />

                    {a.badge && (
                      <span
                        className="absolute top-4 left-4 text-white text-xs font-bold font-[var(--font-hp-body)] uppercase tracking-wider px-3 py-1.5 rounded-full"
                        style={{ backgroundColor: a.accent }}
                      >
                        {a.badge}
                      </span>
                    )}
                  </div>

                  {/* Text side */}
                  <div className="relative md:w-[40%] flex flex-col justify-center p-6 md:p-10 lg:p-14">
                    <div
                      className="h-1 w-16 rounded-full mb-5"
                      style={{ backgroundColor: a.accent }}
                    />

                    <h2
                      className="font-[var(--font-hp-hero)] font-black uppercase text-white"
                      style={{
                        fontSize: "clamp(24px, 4vw, 40px)",
                        lineHeight: "1.1",
                        marginBottom: "6px",
                        textShadow: `0 0 25px ${a.accent}50`,
                      }}
                    >
                      {a.name}
                    </h2>

                    <p
                      className="font-[var(--font-hp-body)] uppercase tracking-wider mb-4"
                      style={{ color: a.accent, fontSize: "clamp(11px, 1.5vw, 13px)" }}
                    >
                      {a.subtitle}
                    </p>

                    <p
                      className="font-[var(--font-hp-body)] text-white/70 leading-relaxed mb-4"
                      style={{ fontSize: "clamp(14px, 1.8vw, 17px)" }}
                    >
                      {a.description}
                    </p>

                    <p className="font-[var(--font-hp-body)] text-white/40 text-sm mb-2">
                      {a.details}
                    </p>

                    <p
                      className="font-[var(--font-hp-body)] font-bold mb-6"
                      style={{ color: a.accent, fontSize: "clamp(14px, 1.8vw, 17px)" }}
                    >
                      {a.pricing}
                    </p>

                    <div className="flex flex-wrap items-center gap-3">
                      {a.external ? (
                        <BookingLink
                          href={a.ctaHref}
                          className="inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
                          style={{
                            backgroundColor: a.accent,
                            boxShadow: `0 0 20px ${a.accent}50`,
                          }}
                        >
                          {a.cta}
                        </BookingLink>
                      ) : (
                        <Link
                          href={a.ctaHref}
                          className="inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
                          style={{
                            backgroundColor: a.accent,
                            boxShadow: `0 0 20px ${a.accent}50`,
                          }}
                        >
                          {a.cta}
                        </Link>
                      )}
                      {a.videoUrl && (
                        <AttractionVideo videoUrl={a.videoUrl} accent={a.accent} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ====== BOTTOM CTA ====== */}
      <section
        className="relative overflow-hidden"
        style={{ minHeight: "clamp(350px, 50vh, 500px)" }}
      >
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

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "clamp(350px, 50vh, 500px)" }}
        >
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 60px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "12px",
              textShadow: "0 0 30px rgba(253,91,86,0.3)",
            }}
          >
            Ready to Play?
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-8 max-w-md mx-auto">
            Reserve your lanes, book your battles, or just show up and play.
          </p>
          <BookingLink
            href="https://www.mybowlingpassport.com/2/3148/book"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 mb-4"
            style={{ boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
          >
            Book Now
          </BookingLink>
          <a
            href="tel:+12394553755"
            className="font-[var(--font-hp-body)] text-white/50 hover:text-white transition-colors text-sm"
          >
            Or call (239) 455-3755
          </a>
        </div>
      </section>
    </div>
  );
}
