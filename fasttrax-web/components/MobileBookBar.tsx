"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useChatAvailable } from "@/hooks/useChatAvailable";
import { trackBookingClick } from "@/lib/analytics";
import { modalBackdropProps } from "@/lib/a11y";

export default function MobileBookBar() {
  const [showContact, setShowContact] = useState(false);
  const agentsOnline = useChatAvailable();
  const pathname = usePathname();

  // Hide on booking pages — user is already booking
  if (pathname?.startsWith("/book")) return null;

  return (
    <>
      {/* Contact popup */}
      {showContact && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          {...modalBackdropProps(() => setShowContact(false))}
        >
          <div className="absolute bottom-20 right-3 bg-[#071027] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden">
            <a
              href="tel:+12394819666"
              className="flex items-center gap-3 px-5 py-3.5 text-white hover:bg-white/5 transition-colors border-b border-white/10"
            >
              <svg className="w-5 h-5 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              <span className="font-body font-semibold text-sm">Call Us</span>
            </a>
            <a
              href="sms:+12394819666"
              className="flex items-center gap-3 px-5 py-3.5 text-white hover:bg-white/5 transition-colors"
            >
              <svg className="w-5 h-5 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span className="font-body font-semibold text-sm">Text Us</span>
            </a>
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[#000418]/95 backdrop-blur border-t border-white/10 p-3 safe-area-inset-bottom">
        <div className="flex gap-2">
          <Link
            href="/book/race"
            onClick={trackBookingClick}
            className="flex-1 block bg-[#E53935] hover:bg-[#c62828] text-white font-body font-bold text-sm py-3.5 rounded-full text-center uppercase tracking-widest transition-colors"
          >
            Book Now
          </Link>
          {agentsOnline && (
            <button
              type="button"
              onClick={() => setShowContact(!showContact)}
              className="flex items-center justify-center bg-[#071027] hover:bg-[#0d1a3a] text-white py-3.5 px-4 rounded-full transition-colors border border-white/10"
              aria-label="Contact us"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </>
  );
}
