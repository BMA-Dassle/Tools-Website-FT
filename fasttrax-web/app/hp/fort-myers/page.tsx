import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "HeadPinz Fort Myers - Bowling, Laser Tag, Arcade & More",
  description:
    "Premier bowling, NEXUS laser tag, gel blaster arena, arcade gaming & Nemo's dining at HeadPinz Fort Myers. 14513 Global Parkway, Fort Myers FL. Book now!",
};

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const quickActions = [
  {
    label: "Book Bowling",
    href: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
  },
  { label: "Laser Tag", href: "/book/laser-tag", external: false },
  { label: "Gel Blasters", href: "/book/gel-blaster", external: false },
  { label: "Game Zone", href: "#attractions", external: false },
  { label: "View Menu", href: "#menu", external: false },
];

const attractions = [
  {
    name: "Premier Bowling",
    description: "Modern lanes with glow bowl effects",
    pricing: "Weekday $12.99-$15.99 | Weekend $15.99-$17.99 | VIP +$2",
    details: "1.5 hours, up to 6 per lane",
    cta: "Reserve Lanes",
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: null,
    gradient: "from-[#240A2B] to-[#1a1a5e]",
  },
  {
    name: "NEXUS Laser Tag",
    description: "2-story glow-in-the-dark space-themed arena",
    pricing: "$10/person, 15 min sessions",
    details: null,
    cta: "Book Now",
    ctaHref: "/book/laser-tag",
    external: false,
    badge: null,
    gradient: "from-[#1a1a5e] to-[#0693e3]",
  },
  {
    name: "NEXUS Gel Blaster Arena",
    description: "State-of-the-art blasters with haptic vests",
    pricing: "$12/person",
    details: null,
    cta: "Book Now",
    ctaHref: "/book/gel-blaster",
    external: false,
    badge: null,
    gradient: "from-[#273370] to-[#9b51e0]",
  },
  {
    name: "Game Zone",
    description: "40+ premier arcade games",
    pricing: "Load any amount onto a Game Card at our kiosks",
    details: null,
    cta: "Learn More",
    ctaHref: "#attractions",
    external: false,
    badge: null,
    gradient: "from-[#0a0518] to-[#240A2B]",
  },
  {
    name: "NeoVerse",
    description: "Interactive video wall experience",
    pricing: "Select VIP when booking bowling",
    details: null,
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: "VIP ONLY",
    gradient: "from-[#9b51e0] to-[#fd5b56]",
  },
  {
    name: "HyperBowling",
    description: "LED-integrated bumper targets",
    pricing: "Dynamic scoring meets physical skill",
    details: null,
    cta: "Reserve VIP",
    ctaHref: "https://www.mybowlingpassport.com/2/9172/book",
    external: true,
    badge: "VIP ONLY",
    gradient: "from-[#fd5b56] to-[#ff7a77]",
  },
];

const specials = [
  {
    name: "Mon-Thu Fun 4 All Day",
    time: "Before 6PM",
    regular: "$12.99",
    vip: "$14.99",
    note: null,
  },
  {
    name: "Mon-Thu Fun 4 Night",
    time: "6PM-12AM",
    regular: "$15.99",
    vip: "$17.99",
    note: null,
  },
  {
    name: "Fri-Sat Late Night Madness",
    time: "11PM-1AM",
    regular: "$11.99",
    vip: "$13.99",
    note: "2 hours unlimited",
  },
  {
    name: "Sunday Pizza Bowl",
    time: "All day",
    regular: "$64.95/lane",
    vip: "$79.95/lane",
    note: "2 hrs + shoes + pizza + soda",
  },
];

const weeklyEvents = [
  { day: "Monday", event: "BOGO Laser Tag" },
  { day: "Tuesday", event: "Double Token Days" },
  { day: "Thursday", event: "Double Token Days" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function FortMyersPage() {
  return (
    <div className="bg-[#0a0518]">
      {/* ====== HERO ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#240A2B] via-[#1a1a5e] to-[#273370]" />
        <div className="absolute inset-0 bg-black/30" />
        <div className="relative max-w-7xl mx-auto px-4 py-20 sm:py-28 lg:py-36 text-center">
          <h1 className="font-[var(--font-hp-display)] text-4xl sm:text-5xl lg:text-6xl uppercase tracking-wider text-white mb-4">
            HeadPinz Fort Myers
          </h1>
          <p className="font-[var(--font-hp-body)] text-white/70 text-base sm:text-lg mb-2">
            14513 Global Parkway, Fort Myers, FL 33913
          </p>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-1">
            <a
              href="tel:+12393022155"
              className="hover:text-white transition-colors"
            >
              (239) 302-2155
            </a>
          </p>
          <p className="font-[var(--font-hp-body)] text-white/40 text-sm mb-8">
            Sun-Thu 11AM-12AM &bull; Fri-Sat 11AM-2AM
          </p>
          <a
            href="https://www.mybowlingpassport.com/2/9172/book"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-3.5 rounded-full transition-colors"
          >
            Book Now
          </a>
        </div>
      </section>

      {/* ====== QUICK ACTIONS ====== */}
      <section className="bg-[#0a0518] border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-5">
          <div className="flex flex-wrap items-center justify-center gap-3">
            {quickActions.map((a) =>
              a.external ? (
                <a
                  key={a.label}
                  href={a.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 hover:border-[#fd5b56]/40 text-white font-[var(--font-hp-body)] text-sm px-5 py-2 rounded-full transition-all"
                >
                  {a.label}
                </a>
              ) : (
                <Link
                  key={a.label}
                  href={a.href}
                  className="inline-flex items-center bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 hover:border-[#fd5b56]/40 text-white font-[var(--font-hp-body)] text-sm px-5 py-2 rounded-full transition-all"
                >
                  {a.label}
                </Link>
              ),
            )}
          </div>
        </div>
      </section>

      {/* ====== ATTRACTIONS GRID ====== */}
      <section id="attractions" className="max-w-7xl mx-auto px-4 py-16 sm:py-20">
        <h2 className="font-[var(--font-hp-display)] text-3xl sm:text-4xl uppercase tracking-wider text-white text-center mb-12">
          Attractions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {attractions.map((a) => (
            <div
              key={a.name}
              className="group relative rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden hover:border-[#fd5b56]/30 transition-all duration-300"
            >
              {/* Image placeholder (gradient) */}
              <div
                className={`h-40 sm:h-48 bg-gradient-to-br ${a.gradient} relative`}
              >
                {a.badge && (
                  <span className="absolute top-3 right-3 bg-[#9b51e0] text-white text-xs font-bold font-[var(--font-hp-body)] uppercase tracking-wider px-3 py-1 rounded-full">
                    {a.badge}
                  </span>
                )}
              </div>

              {/* Card content */}
              <div className="p-5">
                <h3 className="font-[var(--font-hp-display)] text-lg uppercase tracking-wider text-white mb-2">
                  {a.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-3">
                  {a.description}
                </p>
                <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm font-bold mb-1">
                  {a.pricing}
                </p>
                {a.details && (
                  <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-4">
                    {a.details}
                  </p>
                )}
                <div className="mt-4">
                  {a.external ? (
                    <a
                      href={a.ctaHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-5 py-2 rounded-full transition-colors"
                    >
                      {a.cta}
                    </a>
                  ) : (
                    <Link
                      href={a.ctaHref}
                      className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-5 py-2 rounded-full transition-colors"
                    >
                      {a.cta}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ====== WEEKLY SPECIALS ====== */}
      <section
        id="specials"
        className="max-w-7xl mx-auto px-4 py-16 sm:py-20"
      >
        <h2 className="font-[var(--font-hp-display)] text-3xl sm:text-4xl uppercase tracking-wider text-white text-center mb-12">
          Weekly Specials
        </h2>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          {/* Bowling specials table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="font-[var(--font-hp-display)] text-sm uppercase tracking-wider text-white/60 px-5 py-4">
                    Special
                  </th>
                  <th className="font-[var(--font-hp-display)] text-sm uppercase tracking-wider text-white/60 px-5 py-4">
                    Time
                  </th>
                  <th className="font-[var(--font-hp-display)] text-sm uppercase tracking-wider text-white/60 px-5 py-4">
                    Regular
                  </th>
                  <th className="font-[var(--font-hp-display)] text-sm uppercase tracking-wider text-white/60 px-5 py-4">
                    VIP
                  </th>
                </tr>
              </thead>
              <tbody>
                {specials.map((s) => (
                  <tr
                    key={s.name}
                    className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-5 py-4">
                      <p className="font-[var(--font-hp-body)] text-white text-sm font-bold">
                        {s.name}
                      </p>
                      {s.note && (
                        <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-0.5">
                          {s.note}
                        </p>
                      )}
                    </td>
                    <td className="font-[var(--font-hp-body)] text-white/60 text-sm px-5 py-4">
                      {s.time}
                    </td>
                    <td className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm font-bold px-5 py-4">
                      {s.regular}
                    </td>
                    <td className="font-[var(--font-hp-body)] text-[#9b51e0] text-sm font-bold px-5 py-4">
                      {s.vip}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Weekly events */}
          <div className="border-t border-white/10 px-5 py-5">
            <h3 className="font-[var(--font-hp-display)] text-sm uppercase tracking-wider text-white/60 mb-3">
              Weekly Events
            </h3>
            <div className="flex flex-wrap gap-4">
              {weeklyEvents.map((e) => (
                <div key={e.day + e.event} className="flex items-center gap-2">
                  <span className="font-[var(--font-hp-body)] text-white/80 text-sm font-bold">
                    {e.day}:
                  </span>
                  <span className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm">
                    {e.event}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ====== FOOD / NEMO'S ====== */}
      <section id="menu" className="max-w-7xl mx-auto px-4 py-16 sm:py-20">
        <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#240A2B]/50 to-[#273370]/50 p-8 sm:p-12 text-center">
          <h2 className="font-[var(--font-hp-display)] text-3xl sm:text-4xl uppercase tracking-wider text-white mb-4">
            Nemo&apos;s Food &amp; Drinks
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-base sm:text-lg mb-8 max-w-2xl mx-auto">
            Fresh cooked pizza, famous jumbo wings, and a full menu of appetizers,
            burgers, wraps and more. Pair it with craft beers, cocktails, or
            signature mocktails.
          </p>
          <Link
            href="/menu"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-3.5 rounded-full transition-colors"
          >
            View Full Menu
          </Link>
        </div>
      </section>
    </div>
  );
}
