import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "HeadPinz - Where Fun Comes Together | Fort Myers & Naples",
  description:
    "Choose your HeadPinz location. Premier bowling, laser tag, gel blasters, arcade games and dining in Fort Myers and Naples, Florida.",
};

const locations = [
  {
    name: "Fort Myers",
    address: "14513 Global Parkway",
    city: "Fort Myers, FL 33913",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    gradientFrom: "#240A2B",
    gradientTo: "#1a1a5e",
  },
  {
    name: "Naples",
    address: "8525 Radio Lane",
    city: "Naples, FL 34104",
    hours: "Sun-Thu 11AM-12AM",
    hoursWeekend: "Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    gradientFrom: "#1a1a5e",
    gradientTo: "#273370",
  },
];

export default function HeadPinzHome() {
  return (
    <div className="min-h-screen bg-[#0a0518] flex flex-col items-center justify-center px-4 py-16">
      {/* Logo */}
      <h1 className="font-[var(--font-hp-display)] text-5xl sm:text-6xl md:text-7xl uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-[#fd5b56] via-white to-[#9b51e0] mb-4 text-center">
        HEADPINZ
      </h1>

      {/* Tagline */}
      <p className="font-[var(--font-hp-body)] text-white/60 text-lg sm:text-xl mb-12 text-center">
        Where Fun Comes Together
      </p>

      {/* Location cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 max-w-4xl w-full">
        {locations.map((loc) => (
          <Link
            key={loc.name}
            href={loc.href}
            className="group relative rounded-2xl overflow-hidden border border-white/10 hover:border-[#fd5b56]/40 transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_40px_rgba(253,91,86,0.15)]"
          >
            {/* Gradient background (placeholder for future image) */}
            <div
              className="aspect-[4/3] w-full"
              style={{
                background: `linear-gradient(135deg, ${loc.gradientFrom}, ${loc.gradientTo})`,
              }}
            >
              {/* Overlay */}
              <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors duration-300" />

              {/* Content */}
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                <h2 className="font-[var(--font-hp-display)] text-3xl sm:text-4xl uppercase tracking-wider text-white mb-3">
                  {loc.name}
                </h2>
                <p className="font-[var(--font-hp-body)] text-white/70 text-sm mb-1">
                  {loc.address}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-1">
                  {loc.city}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-6">
                  {loc.hours} &bull; {loc.hoursWeekend}
                </p>
                <span className="inline-flex items-center gap-2 bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-colors group-hover:bg-[#ff7a77]">
                  Enter
                  <svg
                    className="w-4 h-4 transition-transform group-hover:translate-x-1"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Anniversary text */}
      <p className="font-[var(--font-hp-body)] text-white/30 text-sm mt-12 tracking-wider text-center">
        Celebrating 10 Years of Fun
      </p>
    </div>
  );
}
