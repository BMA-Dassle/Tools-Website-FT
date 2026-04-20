import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import BookingLink from "@/components/BookingLink";
import AttractionVideo from "@/components/headpinz/AttractionVideo";
import AutoplayVideo from "@/components/headpinz/AutoplayVideo";
import SeoFaq from "@/components/headpinz/SeoFaq";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

export const metadata: Metadata = {
  title:
    "All Attractions - Bowling, Laser Tag, Gel Blasters, VIP, Arcade | HeadPinz Fort Myers",
  description:
    "Explore everything at HeadPinz Fort Myers: 24-lane premier bowling, NEXUS laser tag, gel blaster arena, NeoVerse, HyperBowling, and 40+ arcade games. Six attractions under one roof.",
  keywords: [
    "HeadPinz Fort Myers attractions",
    "bowling Fort Myers",
    "laser tag Fort Myers",
    "gel blasters Fort Myers",
    "gel blaster arena Fort Myers",
    "NeoVerse Fort Myers",
    "HyperBowling Fort Myers",
    "arcade Fort Myers",
    "things to do Fort Myers",
    "family entertainment Fort Myers",
    "VIP bowling Fort Myers",
    "indoor activities Fort Myers",
    "cosmic bowling Fort Myers",
    "best bowling alley Fort Myers",
  ],
  openGraph: {
    title: "All Attractions - HeadPinz Fort Myers",
    description:
      "Six attractions under one roof: premier bowling, NEXUS laser tag, gel blasters, NeoVerse, HyperBowling, and 40+ arcade games.",
    type: "website",
    url: "https://headpinz.com/fort-myers/attractions",
  },
  alternates: {
    canonical: "https://headpinz.com/fort-myers/attractions",
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
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    cta: "Reserve Lanes",
    ctaHref: "/hp/book/bowling",
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
    pricing: "$10/person",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    cta: "Book Laser Tag",
    ctaHref: "/hp/book/laser-tag",
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
    ctaHref: "/hp/book/gel-blaster",
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
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/neoverse.jpg",
    cta: "Book VIP",
    ctaHref: "/hp/book/bowling",
    external: true,
    badge: "VIP EXCLUSIVE",
    accent: "#FFD700",
    borderColor: "rgba(255,215,0,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-neoverse-v2.mp4",
  },
  {
    name: "HyperBowling",
    subtitle: "Where Bowling Meets Gaming",
    description:
      "LED targets in the bumpers \u2014 hit them for points while you bowl. Skill meets spectacle.",
    details: "VIP lanes only \u2022 Dynamic scoring",
    pricing: "Included with VIP",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hyperbowling.jpg",
    cta: "Book VIP",
    ctaHref: "/hp/book/bowling",
    external: true,
    badge: "VIP EXCLUSIVE",
    accent: "#FFD700",
    borderColor: "rgba(255,215,0,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-hyperbowling-v2.mp4",
  },
  {
    name: "Shuffly Shuffleboard",
    subtitle: "Premium LED Shuffleboard Tables",
    description:
      "Full-size shuffleboard tables with LED scoring in a lounge setting. Perfect for groups, date nights, or casual competition.",
    details: "Up to 8 per table \u2022 $10/group",
    pricing: "$10/group",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg",
    cta: "Book Shuffly",
    ctaHref: "/hp/book/shuffly",
    external: false,
    badge: "FORT MYERS ONLY",
    accent: "#004AAD",
    borderColor: "rgba(0,74,173,0.45)",
  },
  {
    name: "Game Zone",
    subtitle: "40+ Premier Arcade Games",
    description:
      "40+ premier arcade games, VR simulators, and The Winner\u2019s Circle prize center.",
    details: "Load any amount onto a Game Card at kiosks",
    pricing: "Game Cards available on-site",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-action.webp",
    cta: "Learn More",
    ctaHref: "/hp/fort-myers#specials",
    external: false,
    badge: null,
    accent: "#00E2E5",
    borderColor: "rgba(0,226,229,0.35)",
    videoUrl: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-arcade-v2.mp4",
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AttractionsPage() {
  return (
    <div className="bg-[#0a1628]">
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Fort Myers", url: "https://headpinz.com/fort-myers" },
          { name: "Attractions", url: "https://headpinz.com/fort-myers/attractions" },
        ]}
      />
      {/* ====== HERO — Video background ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "80vh" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
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
            className="font-body text-[#fd5b56] uppercase tracking-[0.3em] mb-4"
            style={{ fontSize: "clamp(11px, 1.8vw, 14px)" }}
          >
            HeadPinz Fort Myers
          </p>
          <h1
            className="font-heading font-black uppercase text-white"
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
            className="font-body text-white/70 uppercase tracking-widest"
            style={{
              fontSize: "clamp(12px, 2vw, 16px)",
              letterSpacing: "3px",
            }}
          >
            Six attractions under one roof
          </p>
        </div>

        {/* Bottom accent gradient line */}
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
                  {/* Image/Video side */}
                  <div className="relative md:w-[60%] flex-shrink-0" style={{ minHeight: "400px" }}>
                    {a.videoUrl ? (
                      <AutoplayVideo
                        src={a.videoUrl}
                        poster={a.image}
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    ) : (
                      <Image
                        src={a.image}
                        alt={a.name}
                        fill
                        className="object-cover"
                        sizes="(max-width: 768px) 100vw, 60vw"
                        unoptimized
                      />
                    )}
                    {/* Gradient overlay — direction depends on side */}
                    <div
                      className={`absolute inset-0 ${
                        isEven
                          ? "bg-gradient-to-l md:bg-gradient-to-r"
                          : "bg-gradient-to-r md:bg-gradient-to-l"
                      } from-transparent via-transparent to-[#0a1628]/90 hidden md:block`}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a1628]/90 md:hidden" />

                    {/* Badge */}
                    {a.badge && (
                      <span
                        className="absolute top-4 left-4 text-white text-xs font-bold font-body uppercase tracking-wider px-3 py-1.5 rounded-full"
                        style={{ backgroundColor: a.accent }}
                      >
                        {a.badge}
                      </span>
                    )}
                  </div>

                  {/* Text side */}
                  <div className="relative md:w-[40%] flex flex-col justify-center p-6 md:p-10 lg:p-14">
                    {/* Accent line */}
                    <div
                      className="h-1 w-16 rounded-full mb-5"
                      style={{ backgroundColor: a.accent }}
                    />

                    <h2
                      className="font-heading font-black uppercase text-white"
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
                      className="font-body uppercase tracking-wider mb-4"
                      style={{ color: a.accent, fontSize: "clamp(11px, 1.5vw, 13px)" }}
                    >
                      {a.subtitle}
                    </p>

                    <p
                      className="font-body text-white/70 leading-relaxed mb-4"
                      style={{ fontSize: "clamp(14px, 1.8vw, 17px)" }}
                    >
                      {a.description}
                    </p>

                    {/* Details */}
                    <p className="font-body text-white/40 text-sm mb-2">
                      {a.details}
                    </p>

                    {/* Pricing */}
                    <p
                      className="font-body font-bold mb-6"
                      style={{ color: a.accent, fontSize: "clamp(14px, 1.8vw, 17px)" }}
                    >
                      {a.pricing}
                    </p>

                    {/* CTA Buttons */}
                    <div className="flex flex-wrap items-center gap-3">
                      {a.external ? (
                        <BookingLink
                          href={a.ctaHref}
                          className="inline-flex items-center justify-center text-white font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
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
                          className="inline-flex items-center justify-center text-white font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
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

      {/* ====== SEO CONTENT — Arcade + Bowling + Youth Leagues ====== */}
      <section
        className="bg-[#071027]"
        style={{ padding: "clamp(40px, 8vw, 80px) clamp(16px, 4vw, 32px)" }}
      >
        <div className="max-w-4xl mx-auto">
          <h2
            className="font-heading font-black uppercase text-white text-center mb-6"
            style={{ fontSize: "clamp(26px, 5vw, 44px)", letterSpacing: "-0.5px" }}
          >
            Arcade in Fort Myers
          </h2>
          <p
            className="font-body text-white/75 leading-relaxed text-center max-w-3xl mx-auto mb-10"
            style={{ fontSize: "clamp(15px, 2vw, 17px)" }}
          >
            One of the largest arcades in Fort Myers — 40+ premier arcade games, VR
            simulators, and The Winner&apos;s Circle redemption prize center. Everything
            runs off a single Game Card you can load at any kiosk, so there&apos;s no waiting
            in line for tokens. Located at 14513 Global Parkway, one minute from I-75 at
            Gateway Boulevard.
          </p>

          <h2
            className="font-heading font-black uppercase text-white text-center mb-6"
            style={{ fontSize: "clamp(26px, 5vw, 44px)", letterSpacing: "-0.5px" }}
          >
            Bowling Leagues &amp; Youth Programs
          </h2>
          <p
            className="font-body text-white/75 leading-relaxed text-center max-w-3xl mx-auto"
            style={{ fontSize: "clamp(15px, 2vw, 17px)" }}
          >
            HeadPinz Fort Myers hosts adult bowling leagues year-round plus seasonal
            youth bowling leagues for ages 5–17. Youth leagues run in 10-week sessions
            (fall, winter, spring) with USBC-certified coaches. Ask us about
            league signup, open play nights, and Kids Bowl Free summer passes.
          </p>
        </div>
      </section>

      <SeoFaq
        title="Arcade, Bowling &amp; Leagues — Fort Myers FAQ"
        items={[
          {
            q: "Where can I find arcades in Fort Myers?",
            a: "HeadPinz Fort Myers has one of the largest family arcades in Fort Myers with 40+ premier arcade games, VR simulators, and a prize redemption center. We're at 14513 Global Parkway, one minute off I-75 at the Gateway Boulevard exit.",
          },
          {
            q: "How much does the arcade cost at HeadPinz Fort Myers?",
            a: "There's no cover charge to enter the arcade — load any amount onto a Game Card at our kiosks and play. Most games run $1–$5 in Game Card credit per play. Ticket redemption is tracked automatically on your card.",
          },
          {
            q: "Do you have a youth bowling league?",
            a: "Yes. HeadPinz Fort Myers offers youth bowling leagues for ages 5 through 17 in fall, winter, and spring sessions. All leagues are USBC-certified and come with coaching. Ask at the front desk or call (239) 288-8385 for upcoming signup dates.",
          },
          {
            q: "Are you the best bowling alley in Fort Myers?",
            a: "We'd like to think so — 24 state-of-the-art lanes, VIP bowling with NeoVerse interactive walls, HyperBowling LED target bumpers, cosmic glow bowling, and Nemo's Sports Bistro for food and drinks all under one roof.",
          },
          {
            q: "Is HeadPinz Fort Myers open late?",
            a: "Yes. We're open until midnight Sunday through Thursday and until 2 AM on Friday and Saturday. Full bar and kitchen are open throughout all bowling hours.",
          },
          {
            q: "Do you take walk-ins or do I need to book ahead?",
            a: "Walk-ins are welcome. For guaranteed lane times on Friday nights, weekends, or for VIP lanes, we recommend booking online at headpinz.com/book/bowling. Groups of 10+ should always reserve ahead.",
          },
          {
            q: "Does HeadPinz Fort Myers have go-karts?",
            a: "HeadPinz doesn't have go-karts in Fort Myers, but our sister property FastTrax — right next door at 14501 Global Parkway — has a multi-level electric go-kart track, Nemo's Trackside sports bar, and more. Visit fasttraxent.com for racing info.",
          },
        ]}
      />

      {/* ====== BOTTOM CTA ====== */}
      <section
        className="relative overflow-hidden"
        style={{ minHeight: "clamp(350px, 50vh, 500px)" }}
      >
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/cta-wide.webp"
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
            className="font-heading font-black uppercase text-white"
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
          <p className="font-body text-white/60 text-sm mb-8 max-w-md mx-auto">
            Reserve your lanes, book your battles, or just show up and play.
          </p>
          <BookingLink
            href="/hp/book/bowling"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-body font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 shadow-[0_0_20px_rgba(253,91,86,0.3)] hover:shadow-[0_0_30px_rgba(253,91,86,0.5)] mb-4"
          >
            Book Now
          </BookingLink>
          <a
            href="tel:+12393022155"
            className="font-body text-white/50 hover:text-white transition-colors text-sm"
          >
            Or call (239) 302-2155
          </a>
        </div>
      </section>
    </div>
  );
}
