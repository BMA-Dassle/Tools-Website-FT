import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

export const metadata: Metadata = {
  title: "Book Kids Bowl Free Lane | HeadPinz & FastTrax",
  description:
    "Reserve your Kids Bowl Free lane online up to 24 hours in advance. Available at HeadPinz Fort Myers, HeadPinz Naples, and FastTrax Fort Myers.",
  keywords: [
    "book kids bowl free",
    "reserve bowling lane kids",
    "kids bowl free booking",
    "free bowling reservation",
  ],
  alternates: { canonical: "https://headpinz.com/kids-bowl-free/book" },
};

const locations = [
  {
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers, FL 33913",
    phone: "(239) 302-2155",
    bookingUrl: "https://www.mybowlingpassport.com/2/9172/book",
    accent: "#fd5b56",
  },
  {
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples, FL 34104",
    phone: "(239) 455-3755",
    bookingUrl: "https://www.mybowlingpassport.com/2/3148/book",
    accent: "#FFD700",
  },
  {
    name: "FastTrax Fort Myers",
    address: "14501 Global Pkwy, Fort Myers, FL 33913",
    phone: "(239) 481-9666",
    bookingUrl: "https://www.mybowlingpassport.com/2/9172/book",
    accent: "#00E2E5",
  },
];

const steps = [
  "Select 'Book Now' next to your preferred location below",
  "Choose your date, time, and number of bowlers",
  "Scroll to the bottom of the booking page and select 1 or 2 games",
  "Complete checkout to reserve your lane",
];

export default function KBFBookPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO ====== */}
      <section
        className="relative flex flex-col items-center justify-center text-center px-4"
        style={{ paddingTop: "clamp(120px, 18vw, 180px)", paddingBottom: "clamp(40px, 6vw, 60px)" }}
      >
        <div className="relative mb-4" style={{ width: "80px", height: "80px" }}>
          <Image src={`https://www.kidsbowlfree.com/img/kbf-logo-23.png`} alt="Kids Bowl Free" fill className="object-contain" sizes="80px" unoptimized />
        </div>

        <h1
          className="font-heading font-black uppercase text-white"
          style={{ fontSize: "clamp(28px, 7vw, 56px)", lineHeight: "1.05", letterSpacing: "-1px", marginBottom: "12px", textShadow: "0 0 40px rgba(253,91,86,0.35)" }}
        >
          Book a Lane
        </h1>
        <p className="font-body text-white/60 text-sm max-w-lg mx-auto mb-2">
          After you&apos;ve completed your Kids Bowl Free registration, reserve a lane online up to 24 hours in advance.
        </p>
        <div className="mx-auto h-1 w-24 rounded-full mt-4" style={{ background: "linear-gradient(90deg, #fd5b56, #FFD700)" }} />
      </section>

      {/* ====== HOW TO BOOK ====== */}
      <section style={{ padding: "clamp(20px, 4vw, 40px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div
          className="max-w-3xl mx-auto rounded-lg p-6"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
        >
          <h2 className="font-heading uppercase text-white text-base tracking-wider mb-4" style={{ color: "#FFD700" }}>
            How to Book
          </h2>
          <ol className="space-y-3">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className="inline-flex items-center justify-center w-7 h-7 rounded-full font-heading text-xs flex-shrink-0"
                  style={{ backgroundColor: "rgba(255,215,0,0.15)", color: "#FFD700", border: "1px solid rgba(255,215,0,0.3)" }}
                >
                  {i + 1}
                </span>
                <span className="font-body text-white/70 text-sm leading-relaxed pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ====== RULES ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div
          className="max-w-3xl mx-auto rounded-lg p-6"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(253,91,86,0.2)" }}
        >
          <h2 className="font-heading uppercase text-white text-base tracking-wider mb-4">
            Reservation Rules
          </h2>
          <ul className="space-y-2">
            {[
              "Available Monday\u2013Thursday: Open to Close",
              "Available Friday: Open to 5 PM only",
              "Not available on weekends",
              "Reservations accepted only up to 24 hours in advance",
              "Lanes are held for 5 minutes past your start time",
              "Call the center if you\u2019re running late",
              "Kids Bowl Free coupon must be presented at check-in (email or KBF app)",
            ].map((rule) => (
              <li key={rule} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-[#fd5b56]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <span className="font-body text-white/60 text-sm">{rule}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ====== LOCATION BOOKING CARDS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-heading uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(0,226,229,0.25)" }}
            >
              Choose Your Location
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {locations.map((loc) => (
              <div
                key={loc.name}
                className="rounded-lg p-6 text-center flex flex-col"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${loc.accent}30` }}
              >
                <h3 className="font-heading uppercase text-white text-sm tracking-wider mb-2">
                  {loc.name}
                </h3>
                <p className="font-body text-white/50 text-xs mb-1">{loc.address}</p>
                <p className="font-body text-white/50 text-xs mb-5">{loc.phone}</p>
                <a
                  href={loc.bookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto inline-flex items-center justify-center text-white font-body font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-full transition-all hover:scale-105"
                  style={{ backgroundColor: loc.accent, boxShadow: `0 0 16px ${loc.accent}30` }}
                >
                  Book Now
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== NOT REGISTERED YET ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-3xl mx-auto text-center">
          <p className="font-body text-white/50 text-sm mb-4">
            Haven&apos;t registered yet? You need to register before booking.
          </p>
          <Link
            href="/hp/kids-bowl-free/register"
            className="inline-flex items-center text-white font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105 border border-white/20 hover:border-white/40"
            style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
          >
            Register First
          </Link>
        </div>
      </section>
    </div>
  );
}
