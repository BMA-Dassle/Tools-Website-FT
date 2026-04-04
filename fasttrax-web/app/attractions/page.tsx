import type { Metadata } from "next";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";
import Link from "next/link";
import BookingLink from "@/components/BookingLink";

export const metadata: Metadata = {
  title: "All Attractions – Go-Karts, Arcade, Bowling, Laser Tag & More | FastTrax & HeadPinz Fort Myers",
  description:
    "116,000 sq ft across two buildings: indoor go-kart racing, 50+ arcade games, duckpin bowling, laser tag, gel blaster arena, shuffleboard & trackside dining. Fort Myers' biggest entertainment campus — more to do than Dave & Buster's, GameTime, or 810 Bowling combined.",
  keywords: [
    "Fort Myers attractions",
    "things to do Fort Myers",
    "indoor entertainment Fort Myers",
    "arcade Fort Myers",
    "laser tag Fort Myers",
    "gel blaster Fort Myers",
    "duckpin bowling Fort Myers",
    "bowling Fort Myers",
    "go karts Fort Myers",
    "family entertainment Fort Myers",
    "HeadPinz Fort Myers",
    "Dave and Busters alternative Fort Myers",
    "GameTime alternative",
    "810 bowling alternative",
    "best arcade SWFL",
    "fun things to do Fort Myers",
    "indoor activities Fort Myers",
    "rainy day Fort Myers",
    "shuffleboard Fort Myers",
  ],
  openGraph: {
    title: "All Attractions – FastTrax & HeadPinz Fort Myers",
    description:
      "116,000 sq ft of indoor go-karts, arcade, bowling, laser tag, gel blaster & dining across two connected buildings in Fort Myers.",
    type: "website",
    url: "https://fasttraxent.com/attractions",
  },
  alternates: {
    canonical: "https://fasttraxent.com/attractions",
  },
};

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

/* ── Gallery images (3-across row) ── */
const galleryImages = [
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00273.webp", alt: "FastTrax interior view" },
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00281.webp", alt: "FastTrax racing action" },
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00401.webp", alt: "FastTrax entertainment" },
];

/* ── FastTrax attraction cards ── */
const fasttraxCards = [
  {
    title: "High-Powered Electric Racing",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06577.webp",
    desc: (
      <>
        <strong>The Tech:</strong> <strong>Biz-Karts EcoVolt GT</strong> karts on a <strong>360Karting</strong> multi-level structure.<br />
        <strong>The Experience: </strong>Florida&apos;s longest indoor multi-level circuit. Featuring instant torque and smart crash detection that only slows karts within 75ft of a wreck.
      </>
    ),
    cta: { label: "GO TO RACING PAGE", href: "/racing", color: "rgb(228,28,29)" },
  },
  {
    title: "The Game Zone at FastTrax",
    color: "rgb(134,82,255)",
    borderColor: "rgba(134,82,255,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06445.webp",
    desc: (
      <>
        <strong>The Experience:</strong> 50+ of the latest arcade titles, VR simulators, and &ldquo;The Winner&apos;s Circle&rdquo; prize center.<br />
        <strong>The Tech:</strong> Load any amount onto a Game Card at our kiosks and play.
      </>
    ),
    cta: { label: "LOAD A GAME CARD", href: "/pricing", color: "rgb(134,82,255)" },
  },
  {
    title: "FastTrax Duckpin Bowling",
    color: "rgb(0,74,173)",
    borderColor: "rgba(0,74,173,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06561.webp",
    desc: (
      <>
        <strong>The Vibe:</strong> Faster, social bowling with boutique lounge seating.<br />
        <strong>The Perk:</strong> <strong>No rental shoes required.</strong> Walk in and bowl.
      </>
    ),
    cta: { label: "RESERVE A LANE", href: "https://booking.bmileisure.com/headpinzftmyers?pageId=24909243", color: "rgb(0,74,173)" },
  },
  {
    title: "Shuffly at FastTrax",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06538.webp",
    desc: (
      <>
        <strong>The Vibe:</strong> A modern, high-energy take on a classic. Slide into some competitive fun with a chilled-out atmosphere. Perfect for groups between races.
      </>
    ),
    cta: { label: "BOOK SHUFFLY", href: "https://booking.bmileisure.com/headpinzftmyers?pageId=24908598", color: "rgb(228,28,29)" },
  },
];

/* ── HeadPinz attraction cards ── */
const headpinzCards = [
  {
    title: "HeadPinz Tactical Laser Tag",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-1.webp",
    desc: (
      <>
        <strong>The Vibe:</strong> Immersive, multi-level urban combat.<br />
        <strong>The Gear:</strong> Haptic vests and precision sensors for objective-based missions.
      </>
    ),
    cta: { label: "JOIN THE MISSION", href: "https://booking.bmileisure.com/headpinzftmyers?pageId=24909729", color: "rgb(228,28,29)" },
  },
  {
    title: "HeadPinz Gel Blaster Arena",
    color: "rgb(134,82,255)",
    borderColor: "rgba(134,82,255,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-2.webp",
    desc: (
      <>
        <strong>The Vibe:</strong> Combat sports with <strong>Zero Mess</strong>.<br />
        <strong>The Tech:</strong> Eco-friendly &ldquo;Gellets&rdquo; that evaporate on impact.
      </>
    ),
    cta: { label: "BOOK GEL BLASTER", href: "https://booking.bmileisure.com/headpinzftmyers?pageId=24909729", color: "rgb(134,82,255)" },
  },
  {
    title: "HeadPinz Premier Bowling",
    color: "rgb(0,74,173)",
    borderColor: "rgba(0,74,173,0.59)",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-4.webp",
    desc: (
      <>
        <strong>The Vibe:</strong> 24 state-of-the-art lanes including VIP lounge lanes with elite lighting and service.
      </>
    ),
    cta: { label: "BOOK A LANE", href: "https://www.mybowlingpassport.com/2/9172/book", color: "rgb(0,74,173)" },
  },
];

export default function AttractionsPage() {
  return (
    <>
      <SubpageHero
        title="Attractions"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/attractions-hero.webp"
      />

      {/* ── Section: Two Buildings Intro ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
          >
            Two Buildings. One Massive Destination
          </h2>
          <p
            className="font-[var(--font-poppins)]"
            style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
          >
            Explore over 113,000 sq. ft. of adrenaline-pumping action. Start at the high-speed racing hub of FastTrax, then step next door to the premier social entertainment of HeadPinz.
          </p>
        </div>
      </section>

      {/* ── Section: 3-Image Gallery ── */}
      <section className="bg-[#000418]" style={{ padding: "0 32px 120px" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
          {galleryImages.map((img) => (
            <div key={img.src} className="relative overflow-hidden rounded-lg" style={{ aspectRatio: "16/10" }}>
              <Image
                src={img.src}
                alt={img.alt}
                fill
                className="object-cover"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Section: FastTrax 63K Racing Hub ── */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowShadow }}
          >
            FastTrax: The 63,000 Sq. Ft. Racing Hub
          </h2>

          {/* 4-across grid of attraction cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {fasttraxCards.map((card) => (
              <div
                key={card.title}
                className="flex flex-col"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${card.borderColor}`,
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Card image */}
                <div className="relative flex-shrink-0" style={{ height: "clamp(150px, 25vw, 200px)" }}>
                  <Image src={card.image} alt={card.title} fill className="object-cover" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw" />
                </div>
                {/* Card content */}
                <div className="flex flex-col flex-1" style={{ padding: "24px 20px" }}>
                  <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: card.color, fontSize: "22px", letterSpacing: "1.2px" }}>
                    {card.title}
                  </h3>
                  <p className="font-[var(--font-poppins)] flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "14px", lineHeight: "1.5" }}>
                    {card.desc}
                  </p>
                  {card.cta && (
                    card.cta.href.startsWith("http") ? (
                      <BookingLink
                        href={card.cta.href}
                        className="inline-block mt-4 font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                        style={{ backgroundColor: card.cta.color, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                      >
                        {card.cta.label}
                      </BookingLink>
                    ) : (
                      <a
                        href={card.cta.href}
                        className="inline-block mt-4 font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                        style={{ backgroundColor: card.cta.color, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                      >
                        {card.cta.label}
                      </a>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: HeadPinz 50K Social Flagship ── */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/headpinz-interior.webp"
          alt="HeadPinz interior"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowShadow }}
          >
            headPinz: The 50,000 Sq. Ft. Social Flagship
          </h2>

          {/* HeadPinz cards: 3+2 layout */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {headpinzCards.map((card) => (
              <div
                key={card.title}
                className="flex flex-col"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${card.borderColor}`,
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Card image */}
                <div className="relative flex-shrink-0" style={{ height: "clamp(150px, 25vw, 200px)" }}>
                  <Image src={card.image} alt={card.title} fill className="object-cover" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" />
                </div>
                {/* Card content */}
                <div className="flex flex-col flex-1" style={{ padding: "24px 20px" }}>
                  <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: card.color, fontSize: "22px", letterSpacing: "1.2px" }}>
                    {card.title}
                  </h3>
                  <p className="font-[var(--font-poppins)] flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "14px", lineHeight: "1.5" }}>
                    {card.desc}
                  </p>
                  {card.cta && (
                    card.cta.href.startsWith("http") ? (
                      <BookingLink
                        href={card.cta.href}
                        className="inline-block mt-auto pt-4 font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                        style={{ backgroundColor: card.cta.color, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                      >
                        {card.cta.label}
                      </BookingLink>
                    ) : (
                      <a
                        href={card.cta.href}
                        className="inline-block mt-auto pt-4 font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                        style={{ backgroundColor: card.cta.color, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                      >
                        {card.cta.label}
                      </a>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Dining - Nemo's Trackside Bistro ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
            >
              Dining: Nemo&apos;s Trackside Bistro
            </h2>
            <p
              className="font-[var(--font-poppins)] mb-6"
              style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6", maxWidth: "600px" }}
            >
              Located on-site to serve both buildings, Nemo&apos;s is the campus&apos;s official fueling station.
            </p>
            <Link
              href="/menu"
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              VIEW MENU &amp; DINING
            </Link>
          </div>
          <div className="relative overflow-hidden rounded-lg" style={{ aspectRatio: "3/2" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00294.webp"
              alt="Nemo's Trackside Bistro dining"
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: Destination Combo Packages (bottom CTA) ── */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 80vh, 788px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/group-events-bg.webp"
          alt="Destination Combos"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/80 via-[#000418]/60 to-[#000418]/40" />
        <div className="relative z-10 flex flex-col items-center justify-center text-center h-full px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: "rgba(28,0,255,0.4) 0px 0px 30px" }}
          >
            Destination Combo Packages (Best Value)
          </h2>
          <p
            className="font-[var(--font-poppins)] mb-8 mx-auto"
            style={{ color: "rgb(255,255,255)", fontSize: "16px", lineHeight: "1.6", maxWidth: "600px" }}
          >
            Why limit the fun? Our Destination Combos let you mix and match FastTrax Racing with HeadPinz Bowling, Laser Tag, and Gaming
          </p>
          <Link
            href="/pricing"
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
          >
            VIEW DESTINATION COMBOS
          </Link>
        </div>
      </section>
    </>
  );
}
