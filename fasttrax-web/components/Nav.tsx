"use client";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

const schedule: Record<number, { day: string; open: string; close: string }> = {
  0: { day: "SUNDAY", open: "11:00 AM", close: "11:00 PM" },
  1: { day: "MONDAY", open: "3:00 PM", close: "11:00 PM" },
  2: { day: "TUESDAY", open: "3:00 PM", close: "11:00 PM" },
  3: { day: "WEDNESDAY", open: "3:00 PM", close: "11:00 PM" },
  4: { day: "THURSDAY", open: "3:00 PM", close: "11:00 PM" },
  5: { day: "FRIDAY", open: "3:00 PM", close: "12:00 AM" },
  6: { day: "SATURDAY", open: "11:00 AM", close: "12:00 AM" },
};

function getTodayHours() {
  const estDay = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" }).format(new Date());
  const dayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(estDay);
  const entry = schedule[dayIndex];
  return `${entry.day} ${entry.open} – ${entry.close}`;
}

const links = [
  { label: "Racing", href: "/racing" },
  { label: "Attractions", href: "/attractions" },
  { label: "Group Events", href: "/group-events" },
  { label: "Pricing", href: "/pricing" },
  { label: "Nemo's Brickyard", href: "/menu" },
  { label: "Leaderboards", href: "/leaderboards" },
];

export default function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [todayHours, setTodayHours] = useState("");
  const pathname = usePathname();

  useEffect(() => {
    setTodayHours(getTodayHours());
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      {/* Top bar */}
      <div className={`text-xs text-white/60 px-4 py-1.5 flex items-center justify-between transition-colors duration-300 ${scrolled ? "bg-[#010A20]" : "bg-transparent"}`}>
        <div className="flex items-center gap-4">
          <a href="https://www.facebook.com/FastTraxFM" target="_blank" rel="noopener noreferrer" className="hover:text-[#00E2E5] transition-colors" aria-label="Facebook">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>
          </a>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          <span className="font-[var(--font-poppins)] font-semibold text-white tracking-wider text-xs">{todayHours}</span>
        </div>
      </div>

      {/* Main nav - glass pill */}
      <nav className="px-4 lg:px-8 py-2">
        <div
          className="max-w-7xl mx-auto flex items-center justify-between"
          style={{
            backgroundColor: "rgba(0,4,24,0.24)",
            backdropFilter: "blur(6.6px)",
            WebkitBackdropFilter: "blur(6.6px)",
            border: "0.89px solid rgba(255,252,252,0.08)",
            borderRadius: "44px",
            boxShadow: "rgba(0,0,0,0.1) 0px 4px 30px 0px",
            padding: "14px 14px 14px 24px",
            gap: "20px",
          }}
        >
          {/* Logo */}
          <Link href="/" className="flex items-center shrink-0">
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png"
              alt="FastTrax Entertainment"
              width={140}
              height={52}
              className="h-12 w-auto object-contain"
              priority
            />
          </Link>

          {/* Desktop links */}
          <div className="hidden lg:flex items-center gap-5">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="font-[var(--font-poppins)] font-semibold uppercase tracking-wider transition-colors whitespace-nowrap"
                style={{
                  fontSize: "14px",
                  color: pathname === l.href ? "rgb(228,28,29)" : "rgb(255,255,255)",
                }}
              >
                {l.label}
              </Link>
            ))}
          </div>

          {/* Book Now + hamburger */}
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center gap-2 bg-[#E41C1D] hover:bg-[#c62828] text-white font-[var(--font-poppins)] font-bold uppercase tracking-wider transition-colors"
              style={{ fontSize: "14px", padding: "16px 24px", borderRadius: "166px" }}
            >
              Book Now
            </a>
            <button
              onClick={() => setOpen(!open)}
              className="lg:hidden flex flex-col gap-1.5 p-2"
              aria-label="Toggle menu"
            >
              <span className={`block w-6 h-0.5 bg-white transition-all duration-300 ${open ? "rotate-45 translate-y-2" : ""}`} />
              <span className={`block w-6 h-0.5 bg-white transition-all duration-300 ${open ? "opacity-0" : ""}`} />
              <span className={`block w-6 h-0.5 bg-white transition-all duration-300 ${open ? "-rotate-45 -translate-y-2" : ""}`} />
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <div className={`lg:hidden overflow-hidden transition-all duration-300 ${open ? "max-h-screen" : "max-h-0"}`}>
          <div className="bg-[#010A20] px-4 pb-6 pt-2 flex flex-col gap-4">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="font-[var(--font-poppins)] font-semibold uppercase tracking-wider text-sm py-2 border-b border-white/10 transition-colors"
                style={{ color: pathname === l.href ? "rgb(228,28,29)" : "rgba(255,255,255,0.8)" }}
              >
                {l.label}
              </Link>
            ))}
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 bg-[#E41C1D] text-white font-[var(--font-poppins)] font-bold text-sm px-5 py-3 rounded-full text-center uppercase tracking-wider"
            >
              Book Now
            </a>
          </div>
        </div>
      </nav>
    </header>
  );
}
