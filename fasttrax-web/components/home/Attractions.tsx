import Link from "next/link";
import Image from "next/image";
import BookingLink from "@/components/BookingLink";

// Exact data from live site inspection
const row1 = [
  {
    title: "HIGH-POWERED RACING",
    desc: "Experience our high-performance electric karts on our dual Blue and Red tracks.",
    cta: "CHECK OUT RACING",
    ctaBg: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06577.webp",
    href: "/racing",
  },
  {
    title: "MEGA TRACK TUESDAYS",
    desc: "Every Tuesday, we pull the barriers to create Florida's largest indoor racing circuit.",
    cta: "BOOK THE MEGA TRACK",
    ctaBg: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06538.webp",
    href: "/racing",
  },
  {
    title: "THE GAME ZONE",
    desc: "50+ arcade titles & VR experiences for the ultimate gaming adventure.",
    cta: "LOAD A GAME CARD",
    ctaBg: "rgb(0,74,173)",
    border: "rgba(0,74,173,0.59)",
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06445.webp",
    href: "/attractions",
  },
];

const row2 = [
  {
    title: "NEMO'S TRACKSIDE",
    desc: "Full-service dining and trackside lounge. Watch the action while you dine in style.",
    cta: "VIEW THE MENU",
    ctaBg: "rgb(0,74,173)",
    border: "rgba(0,74,173,0.59)",
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06481.webp",
    href: "/menu",
  },
  {
    title: "DUCKPIN BOWLING",
    desc: "Fast-paced social bowling. No rental shoes required!",
    cta: "RESERVE A LANE",
    ctaBg: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06561.webp",
    href: "/book/duck-pin",
  },
];

// Hours data matching live site colors exactly
const hours = [
  { day: "Mon–Thu", time: "3:00 PM – 11:00 PM", color: "rgb(228,28,29)", border: "rgb(228,28,29)" },
  { day: "Fri",     time: "3:00 PM – 12:00 AM",  color: "rgb(134,82,255)", border: "rgb(134,82,255)" },
  { day: "Sat",     time: "11:00 AM – 12:00 AM", color: "rgb(248,0,198)",  border: "rgb(248,0,198)" },
  { day: "Sun",     time: "11:00 AM – 11:00 PM", color: "rgb(0,74,173)",   border: "rgb(0,74,173)" },
];

function AttractionCard({ card, wide = false }: { card: typeof row1[0]; wide?: boolean }) {
  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden h-full"
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${card.border}`,
        borderRadius: "8px",
        flex: wide ? "1" : undefined,
      }}
    >
      {/* Photo */}
      <div className="relative h-[180px] md:h-[246px] w-full">
        <Image
          src={card.img}
          alt={card.title}
          fill
          className="object-cover"
          sizes="(max-width: 768px) 100vw, 33vw"
        />
      </div>

      {/* Text content */}
      <div className="flex flex-col gap-3 p-5 flex-1">
        <h3
          className="font-heading uppercase"
          style={{ color: card.border.replace("0.59", "1").replace("rgba", "rgb").replace(/,\s*[0-9.]+\)/, ")"), fontSize: "24px" }}
        >
          {card.title}
        </h3>
        <p style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", fontFamily: "var(--font-body)", lineHeight: "1.5" }}>
          {card.desc}
        </p>
        <div className="mt-auto">
          {card.href.startsWith("http") ? (
            <BookingLink
              href={card.href}
              className="inline-block font-body font-bold uppercase text-white transition-all hover:scale-105"
              style={{
                backgroundColor: card.ctaBg,
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
                letterSpacing: "0.05em",
              }}
            >
              {card.cta}
            </BookingLink>
          ) : (
            <a
              href={card.href}
              className="inline-block font-body font-bold uppercase text-white transition-all hover:scale-105"
              style={{
                backgroundColor: card.ctaBg,
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
                letterSpacing: "0.05em",
              }}
            >
              {card.cta}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Attractions() {
  return (
    <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
      <div className="max-w-7xl mx-auto">

        {/* Title */}
        <h2
          className="font-heading font-black uppercase text-white text-center mb-8"
          style={{ fontSize: "clamp(2.5rem, 6vw, 72px)" }}
        >
          THE ATTRACTION POWER-GRID
        </h2>

        {/* Hours bar */}
        <div className="flex flex-wrap justify-center gap-3 mb-12">
          {hours.map((h) => (
            <div
              key={h.day}
              className="flex items-center gap-3 px-4 py-3 rounded-xl"
              style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${h.border}` }}
            >
              <span style={{ color: h.color, fontSize: "18px", fontFamily: "var(--font-body)", fontWeight: 600 }}>{h.day}</span>
              <span style={{ color: "rgb(245,236,238)", fontSize: "16px", fontFamily: "var(--font-body)" }}>{h.time}</span>
            </div>
          ))}
        </div>

        {/* Row 1: 3 cards */}
        <div className="flex flex-col sm:flex-row gap-8 mb-8 items-stretch">
          {row1.map((card) => (
            <div key={card.title} className="flex-1 flex flex-col">
              <AttractionCard card={card} />
            </div>
          ))}
        </div>

        {/* Row 2: 2 cards */}
        <div className="flex flex-col sm:flex-row gap-8 items-stretch">
          {row2.map((card) => (
            <div key={card.title} className="flex-1 flex flex-col">
              <AttractionCard card={card} wide />
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
