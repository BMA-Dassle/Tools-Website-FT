import Link from "next/link";
import Image from "next/image";
import BookingLink from "@/components/BookingLink";
import ComboTeaser from "~/components/features/combos/ComboTeaser";
import { megaDaysPhrase } from "~/features/racing/mega-calendar";
import {
  etDateIso,
  fasttraxHoursGroups,
  formatHoursClock,
  formatHoursGroupLabel,
} from "~/lib/constants/fasttrax-hours";

/**
 * Exact data from live site inspection.
 *
 * A FUNCTION, not a module const, for the same reason `hoursPills()` is: the
 * Mega card names the days Mega actually runs, and those are effective-DATED
 * (Thursdays join for the Sep–Oct 2026 season). A module-level const would
 * resolve `etDateIso()` once when the module first loaded — at BUILD time on a
 * statically rendered page — and freeze the copy on whatever day that was.
 */
function row1Cards() {
  const today = etDateIso();
  return [
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
      title: `MEGA TRACK ${megaDaysPhrase(today).toUpperCase()}`,
      desc: `Every ${megaDaysPhrase(today, "singular")}, we pull the barriers to create Florida's largest indoor racing circuit.`,
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
}

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

// Pill colors matching the live site exactly, in the same Mon-first order the
// hours registry groups the week into (Mon–Thu / Fri / Sat / Sun). Times come
// from src/lib/constants/fasttrax-hours.ts so the pills, the footer, the nav
// and the JSON-LD can never disagree. Extra groups (should the week ever split
// differently) cycle back through the palette rather than crashing.
const HOURS_PILL_COLORS = ["rgb(228,28,29)", "rgb(134,82,255)", "rgb(248,0,198)", "rgb(0,74,173)"];

function hoursPills() {
  return fasttraxHoursGroups(etDateIso()).map((group, i) => ({
    day: formatHoursGroupLabel(group),
    time: `${formatHoursClock(group.openMinutes)} – ${formatHoursClock(group.closeMinutes)}`,
    color: HOURS_PILL_COLORS[i % HOURS_PILL_COLORS.length],
    border: HOURS_PILL_COLORS[i % HOURS_PILL_COLORS.length],
  }));
}

function AttractionCard({
  card,
  wide = false,
}: {
  card: ReturnType<typeof row1Cards>[0];
  wide?: boolean;
}) {
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
          style={{
            color: card.border
              .replace("0.59", "1")
              .replace("rgba", "rgb")
              .replace(/,\s*[0-9.]+\)/, ")"),
            fontSize: "24px",
          }}
        >
          {card.title}
        </h3>
        <p
          style={{
            color: "rgba(245,236,238,0.8)",
            fontSize: "16px",
            fontFamily: "var(--font-body)",
            lineHeight: "1.5",
          }}
        >
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
    <section
      className="bg-[#000418]"
      style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
    >
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
          {hoursPills().map((h) => (
            <div
              key={h.day}
              className="flex items-center gap-3 px-4 py-3 rounded-xl"
              style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${h.border}` }}
            >
              <span
                style={{
                  color: h.color,
                  fontSize: "18px",
                  fontFamily: "var(--font-body)",
                  fontWeight: 600,
                }}
              >
                {h.day}
              </span>
              <span
                style={{
                  color: "rgb(245,236,238)",
                  fontSize: "16px",
                  fontFamily: "var(--font-body)",
                }}
              >
                {h.time}
              </span>
            </div>
          ))}
        </div>

        {/* Row 1: 3 cards */}
        <div className="flex flex-col sm:flex-row gap-8 mb-8 items-stretch">
          {row1Cards().map((card) => (
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

        {/* Combo specials teaser (registry-driven; hidden when flag is off) */}
        <ComboTeaser />
      </div>
    </section>
  );
}
