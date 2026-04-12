"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { setBookingLocation } from "@/lib/booking-location";
import type { LocationKey } from "@/lib/attractions-data";
import Image from "next/image";

const locations = [
  { key: "fort-myers", label: "Fort Myers", shortLabel: "FM", href: "/hp/fort-myers", waiver: "https://kiosk.bmileisure.com/headpinzftmyers", booking: "/hp/book/bowling", leagues: "https://www.leaguesecretary.com/bowling-centers/headpinz-fort-myers/leagues/11934" },
  { key: "naples", label: "Naples", shortLabel: "NAP", href: "/hp/naples", waiver: "https://kiosk.bmileisure.com/headpinznaples", booking: "/hp/book/bowling?location=naples", leagues: "https://www.leaguesecretary.com/bowling-centers/headpinz-naples-naples-florida/dashboard/4318" },
];

const schedule: Record<number, { day: string; open: string; close: string }> = {
  0: { day: "SUNDAY", open: "11:00 AM", close: "12:00 AM" },
  1: { day: "MONDAY", open: "11:00 AM", close: "12:00 AM" },
  2: { day: "TUESDAY", open: "11:00 AM", close: "12:00 AM" },
  3: { day: "WEDNESDAY", open: "11:00 AM", close: "12:00 AM" },
  4: { day: "THURSDAY", open: "11:00 AM", close: "12:00 AM" },
  5: { day: "FRIDAY", open: "11:00 AM", close: "2:00 AM" },
  6: { day: "SATURDAY", open: "11:00 AM", close: "2:00 AM" },
};

function getTodayHours() {
  const estDay = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" }).format(new Date());
  const dayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(estDay);
  const entry = schedule[dayIndex];
  return `${entry.day} ${entry.open} – ${entry.close}`;
}

export default function HeadPinzNav() {
  const [open, setOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [todayHours, setTodayHours] = useState("");
  const pathname = usePathname();

  // Detect location from pathname, sessionStorage (booking flow), or default
  const bookingLoc = typeof window !== "undefined" ? sessionStorage.getItem("bookingLocation") : null;
  const pathLoc = locations.find(l => pathname.includes(l.key));
  const currentLoc = pathLoc
    || (bookingLoc ? locations.find(l => l.key === bookingLoc) : null)
    || locations[0];
  // Sync detected location to sessionStorage so booking flow inherits it
  if (typeof window !== "undefined" && pathLoc) {
    const bookingKey = pathLoc.key === "fort-myers" ? "headpinz" : pathLoc.key;
    setBookingLocation(bookingKey as LocationKey);
  }
  const navLinks = [
    { label: "Attractions", href: `${currentLoc.href}/attractions` },
    { label: "Birthdays", href: `${currentLoc.href}/birthdays` },
    { label: "Group Events", href: `${currentLoc.href}/group-events` },
    { label: "Specials", href: `${currentLoc.href}#specials` },
    { label: "Nemo's", href: "/hp/menu" },
    { label: "Leagues", href: currentLoc.leagues },
    { label: "Rewards", href: "/hp/rewards" },
    { label: "Gift Cards", href: "https://squareup.com/gift/2Z728TECCNWSE/order" },
    { label: "Waiver", href: currentLoc.waiver },
  ];

  useEffect(() => {
    setTodayHours(getTodayHours());
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { setOpen(false); setLocOpen(false); }, [pathname]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      {/* Top bar — hours + location selector */}
      <div className={`text-xs text-white/60 px-4 py-1.5 flex items-center justify-between transition-colors duration-300 ${scrolled ? "bg-[#0a1628]" : "bg-transparent"}`}>
        <div className="flex items-center gap-4">
          <a href="https://www.facebook.com/HeadPinzFortMyers" target="_blank" rel="noopener noreferrer" className="hover:text-[#fd5b56] transition-colors" aria-label="Facebook">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>
          </a>
          <a href="https://www.instagram.com/headpinzftmyers" target="_blank" rel="noopener noreferrer" className="hover:text-[#fd5b56] transition-colors" aria-label="Instagram">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
          </a>
        </div>
        <div className="flex items-center gap-3">
          {/* Location selector */}
          <div className="relative">
            <button
              onClick={() => setLocOpen(!locOpen)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-white/15 hover:border-[#fd5b56]/40 transition-colors"
            >
              <svg className="w-3 h-3 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="font-semibold text-white text-[13px] tracking-wider">{currentLoc.label}</span>
              <svg className={`w-3 h-3 transition-transform ${locOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {locOpen && (
              <div className="absolute right-0 top-full mt-1 z-[60] bg-[#0a1628] border border-[#123075]/50 rounded-lg overflow-hidden shadow-xl min-w-[160px]">
                {locations.map(loc => (
                  <Link
                    key={loc.key}
                    href={loc.href}
                    onClick={() => {
                      setLocOpen(false);
                      // Map nav location key to booking location key
                      const bookingKey = loc.key === "fort-myers" ? "headpinz" : loc.key;
                      setBookingLocation(bookingKey as LocationKey);
                    }}
                    className={`block px-4 py-2.5 text-xs font-semibold transition-colors ${loc.key === currentLoc.key ? "text-[#fd5b56] bg-[#fd5b56]/10" : "text-white/70 hover:text-white hover:bg-white/5"}`}
                  >
                    {loc.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <span className="text-white/20">|</span>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            <span className="font-body font-semibold text-white tracking-wider text-xs">{todayHours}</span>
          </div>
        </div>
      </div>

      {/* Main nav — glass pill (same style as FastTrax) */}
      <nav className="px-4 lg:px-8 py-2">
        <div
          className="max-w-7xl mx-auto flex items-center justify-between"
          style={{
            backgroundColor: "rgba(10,22,40,0.4)",
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
          <Link href="/hp" className="flex items-center shrink-0">
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp"
              alt="HeadPinz"
              width={140}
              height={48}
              className="h-10 w-auto object-contain"
              unoptimized
              priority
            />
          </Link>

          {/* Desktop links */}
          <div className="hidden lg:flex items-center gap-5">
            {navLinks.map((l) =>
              l.href.startsWith("http") ? (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-body font-semibold uppercase tracking-wider transition-colors whitespace-nowrap text-white hover:text-[#fd5b56]"
                  style={{ fontSize: "14px" }}
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  className="font-body font-semibold uppercase tracking-wider transition-colors whitespace-nowrap hover:text-[#fd5b56]"
                  style={{
                    fontSize: "14px",
                    color: pathname.includes(l.href.split("#")[0]) && !l.href.includes("#") ? "#fd5b56" : "rgb(255,255,255)",
                  }}
                >
                  {l.label}
                </Link>
              )
            )}
          </div>

          {/* Book Now + hamburger */}
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={currentLoc.booking}
              className="hidden sm:inline-flex items-center gap-2 bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-body font-bold uppercase tracking-wider transition-all hover:shadow-[0_0_20px_rgba(253,91,86,0.5)]"
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
          <div className="bg-[#0a1628] px-4 pb-6 pt-2 flex flex-col gap-4 rounded-b-2xl">
            {/* Location switcher in mobile */}
            <div className="flex gap-2 pb-2 border-b border-white/10">
              {locations.map(loc => (
                <Link
                  key={loc.key}
                  href={loc.href}
                  onClick={() => setOpen(false)}
                  className={`flex-1 py-2 rounded-lg text-center text-xs font-bold uppercase tracking-wider transition-colors ${loc.key === currentLoc.key ? "bg-[#fd5b56] text-white" : "bg-white/5 text-white/50 hover:text-white"}`}
                >
                  {loc.label}
                </Link>
              ))}
            </div>
            {navLinks.map((l) =>
              l.href.startsWith("http") ? (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="font-body font-semibold uppercase tracking-wider text-sm py-2 border-b border-white/10 transition-colors text-white/80 hover:text-[#fd5b56]"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="font-body font-semibold uppercase tracking-wider text-sm py-2 border-b border-white/10 transition-colors"
                  style={{ color: "rgba(255,255,255,0.8)" }}
                >
                  {l.label}
                </Link>
              )
            )}
            <a
              href={currentLoc.booking}
              className="mt-2 bg-[#fd5b56] text-white font-body font-bold text-sm px-5 py-3 rounded-full text-center uppercase tracking-wider"
            >
              Book Now
            </a>
          </div>
        </div>
      </nav>
    </header>
  );
}
