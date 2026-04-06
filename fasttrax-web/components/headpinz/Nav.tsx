"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

const links = [
  { label: "Home", href: "/hp" },
  { label: "Fort Myers", href: "/hp/fort-myers" },
  { label: "Naples", href: "/hp/naples" },
  { label: "Specials", href: "/hp/fort-myers#specials" },
  { label: "Parties", href: "/hp/fort-myers#parties" },
  { label: "Menu", href: "/hp/fort-myers#menu" },
  { label: "Waiver", href: "https://kiosk.bmileisure.com/headpinzftmyers" },
];

export default function HeadPinzNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <nav
        className={`transition-all duration-300 ${
          scrolled
            ? "bg-gradient-to-r from-[#240A2B] to-[#273370] shadow-lg"
            : "bg-gradient-to-r from-[#240A2B]/80 to-[#273370]/80 backdrop-blur-md"
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 lg:px-8 flex items-center justify-between h-16 lg:h-20">
          {/* Logo */}
          <Link
            href="/hp"
            className="font-[var(--font-hp-display)] text-2xl lg:text-3xl uppercase tracking-widest text-white shrink-0"
          >
            HEADPINZ
          </Link>

          {/* Desktop links */}
          <div className="hidden lg:flex items-center gap-6">
            {links.map((l) =>
              l.href.startsWith("http") ? (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-[var(--font-hp-body)] text-sm uppercase tracking-wider text-white/80 hover:text-white transition-colors whitespace-nowrap"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`font-[var(--font-hp-body)] text-sm uppercase tracking-wider transition-colors whitespace-nowrap ${
                    pathname === l.href
                      ? "text-[#fd5b56]"
                      : "text-white/80 hover:text-white"
                  }`}
                >
                  {l.label}
                </Link>
              ),
            )}
          </div>

          {/* Book Now + hamburger */}
          <div className="flex items-center gap-3 shrink-0">
            <Link
              href="/hp/fort-myers#attractions"
              className="hidden sm:inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-colors"
            >
              Book Now
            </Link>
            <button
              onClick={() => setOpen(!open)}
              className="lg:hidden flex flex-col gap-1.5 p-2"
              aria-label="Toggle menu"
            >
              <span
                className={`block w-6 h-0.5 bg-white transition-all duration-300 ${
                  open ? "rotate-45 translate-y-2" : ""
                }`}
              />
              <span
                className={`block w-6 h-0.5 bg-white transition-all duration-300 ${
                  open ? "opacity-0" : ""
                }`}
              />
              <span
                className={`block w-6 h-0.5 bg-white transition-all duration-300 ${
                  open ? "-rotate-45 -translate-y-2" : ""
                }`}
              />
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <div
          className={`lg:hidden overflow-hidden transition-all duration-300 ${
            open ? "max-h-screen" : "max-h-0"
          }`}
        >
          <div className="bg-[#150825] px-4 pb-6 pt-2 flex flex-col gap-1">
            {links.map((l) =>
              l.href.startsWith("http") ? (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="font-[var(--font-hp-body)] text-sm uppercase tracking-wider py-3 border-b border-white/10 text-white/70 hover:text-white transition-colors"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={`font-[var(--font-hp-body)] text-sm uppercase tracking-wider py-3 border-b border-white/10 transition-colors ${
                    pathname === l.href
                      ? "text-[#fd5b56]"
                      : "text-white/70 hover:text-white"
                  }`}
                >
                  {l.label}
                </Link>
              ),
            )}
            <Link
              href="/hp/fort-myers#attractions"
              onClick={() => setOpen(false)}
              className="mt-3 bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm px-5 py-3 rounded-full text-center uppercase tracking-wider transition-colors"
            >
              Book Now
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}
