"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { modalBackdropProps } from "@/lib/a11y";

const locations: Record<string, { phone: string; phoneTel: string; booking: string }> = {
  "fort-myers": { phone: "(239) 302-2155", phoneTel: "+12393022155", booking: "/hp/book" },
  naples: { phone: "(239) 455-3755", phoneTel: "+12394553755", booking: "/hp/book?location=naples" },
};

export default function HeadPinzMobileBookBar() {
  const [showContact, setShowContact] = useState(false);
  const pathname = usePathname();

  // Hide on every booking page — user is already inside a booking
  // flow, a "Book Now" bar would either be a no-op or worse, kick
  // them back to the start of a different flow.
  if (pathname?.includes("/book/")) return null;
  if (pathname?.includes("/book")) return null;
  // Belt-and-suspenders explicit guards for the KBF wizard pages —
  // every step lives under .../book/kids-bowl-free/* but include
  // the slug match too in case a future deploy serves the route
  // from a non-/book/ path. KBF wizard has its own Continue / Back
  // CTAs at every step, so a floating Book Now bar would just stack
  // on top.
  if (pathname?.includes("kids-bowl-free")) return null;
  // Also hide on the booking hub itself (/book or /hp/book) — no point
  // showing a Book Now bar that would just re-load the page you're on.
  if (pathname === "/book" || pathname === "/hp/book") return null;
  // Hide on the HP landing / location-picker page. On prod this is "/"
  // (headpinz.com/); in dev / internal routing it's "/hp".
  if (pathname === "/" || pathname === "/hp" || pathname === "/hp/") return null;

  // Determine location from URL
  const loc = pathname?.includes("naples") ? locations.naples : locations["fort-myers"];

  return (
    <>
      {/* Contact popup */}
      {showContact && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          {...modalBackdropProps(() => setShowContact(false))}
        >
          <div
            className="absolute bottom-20 right-3 overflow-hidden rounded-lg shadow-2xl shadow-black/50"
            style={{ backgroundColor: "rgba(7,16,39,0.95)", border: "1.78px solid rgba(253,91,86,0.3)" }}
          >
            <a
              href={`tel:${loc.phoneTel}`}
              className="flex items-center gap-3 px-5 py-3.5 text-white hover:bg-white/5 transition-colors border-b border-white/10"
            >
              <svg className="w-5 h-5 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              <span className="font-body font-bold text-sm">Call {loc.phone}</span>
            </a>
            <a
              href={`sms:${loc.phoneTel}`}
              className="flex items-center gap-3 px-5 py-3.5 text-white hover:bg-white/5 transition-colors"
            >
              <svg className="w-5 h-5 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span className="font-body font-bold text-sm">Text Us</span>
            </a>
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 md:hidden p-3 safe-area-inset-bottom"
        style={{ backgroundColor: "rgba(10,22,40,0.95)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderTop: "1px solid rgba(255,255,255,0.1)" }}
      >
        <div className="flex gap-2">
          <a
            href={loc.booking}
            className="flex-1 block text-white font-body font-bold text-sm py-3.5 rounded-full text-center uppercase tracking-widest transition-colors"
            style={{ backgroundColor: "#fd5b56", boxShadow: "0 0 16px rgba(253,91,86,0.3)" }}
          >
            Book Now
          </a>
          <button
            type="button"
            onClick={() => setShowContact(!showContact)}
            className="flex items-center justify-center text-white py-3.5 px-4 rounded-full transition-colors border border-white/10 cursor-pointer"
            style={{ backgroundColor: "rgba(7,16,39,0.8)" }}
            aria-label="Contact us"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
