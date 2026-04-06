import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

export const metadata: Metadata = {
  title: "Register for Kids Bowl Free | HeadPinz & FastTrax",
  description:
    "Register your child for Kids Bowl Free at HeadPinz Fort Myers, HeadPinz Naples, or FastTrax Fort Myers. Kids 15 and under get 2 free games every weekday.",
  alternates: { canonical: "https://headpinz.com/hp/kids-bowl-free/register" },
};

const locations = [
  {
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers, FL 33913",
    phone: "(239) 302-2155",
    registerUrl: "https://www.kidsbowlfree.com/center.php?alley_id=6363",
    accent: "#fd5b56",
  },
  {
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples, FL 34104",
    phone: "(239) 455-3755",
    registerUrl: "https://www.kidsbowlfree.com/center.php?alley_id=5662",
    accent: "#FFD700",
  },
  {
    name: "FastTrax Fort Myers",
    address: "14501 Global Pkwy, Fort Myers, FL 33913",
    phone: "(239) 481-9666",
    registerUrl: "https://www.kidsbowlfree.com/center.php?alley_id=7438",
    accent: "#00E2E5",
  },
];

export default function KBFRegisterPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "60vh" }}>
        <Image
          src={`${BLOB}/images/headpinz/kbf-banner.png`}
          alt="Kids Bowl Free registration"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "60vh" }}
        >
          <div className="relative mb-4" style={{ width: "80px", height: "80px" }}>
            <Image src={`${BLOB}/images/headpinz/kbf-logo.png`} alt="Kids Bowl Free" fill className="object-contain" sizes="80px" unoptimized />
          </div>

          <p className="font-[var(--font-hp-body)] text-[#FFD700] text-xs uppercase tracking-[0.3em] mb-3">
            Step 1 of 2
          </p>

          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 56px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "12px",
              textShadow: "0 0 40px rgba(253,91,86,0.35)",
            }}
          >
            Register Your Kids
          </h1>
          <p className="font-[var(--font-hp-body)] text-white/70 text-sm max-w-lg mx-auto">
            Sign up through the Kids Bowl Free portal, then book your lane. It only takes a minute per child.
          </p>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== HOW REGISTRATION WORKS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(255,215,0,0.25)" }}
            >
              How Registration Works
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: "linear-gradient(90deg, #fd5b56, #FFD700)" }} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { step: "1", title: "Choose a Location", desc: "Select your nearest center below and click Register. You'll be taken to the Kids Bowl Free portal.", accent: "#fd5b56" },
              { step: "2", title: "Sign Up Each Child", desc: "A parent or grandparent enters each child's info. Kids must be 15 or younger. Register each child separately.", accent: "#FFD700" },
              { step: "3", title: "Get Your Passes", desc: "You'll receive weekly passes via email or the Kids Bowl Free mobile app. Show them at check-in to bowl free!", accent: "#00E2E5" },
            ].map((s) => (
              <div
                key={s.step}
                className="rounded-lg p-6 text-center"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${s.accent}30` }}
              >
                <span
                  className="inline-flex items-center justify-center w-12 h-12 rounded-full font-[var(--font-hp-display)] text-xl mb-4"
                  style={{ backgroundColor: `${s.accent}20`, color: s.accent, border: `1.78px solid ${s.accent}40` }}
                >
                  {s.step}
                </span>
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2">
                  {s.title}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== ELIGIBILITY ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div
          className="max-w-3xl mx-auto rounded-lg p-6"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
        >
          <h2 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-4" style={{ textShadow: "0 0 15px rgba(255,215,0,0.2)" }}>
            Who Can Register?
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              "Children 15 years old or younger",
              "Parents or grandparents register",
              "Each child registered individually",
              "Show passes at check-in (email or app)",
              "Must register before booking a lane",
              "Free to sign up — no cost or obligation",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-[#FFD700]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span className="font-[var(--font-hp-body)] text-white/70 text-sm">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== SCHEDULE REMINDER ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div
          className="max-w-3xl mx-auto rounded-lg p-6"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(0,226,229,0.25)" }}
        >
          <h2 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-4" style={{ color: "#00E2E5" }}>
            When Can Kids Bowl?
          </h2>
          <div className="space-y-2">
            {[
              { day: "Monday \u2013 Thursday", time: "Open to Close", on: true },
              { day: "Friday", time: "Open to 5 PM", on: true },
              { day: "Saturday \u2013 Sunday", time: "Not Available", on: false },
            ].map((row) => (
              <div key={row.day} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <span className="font-[var(--font-hp-body)] text-white font-bold text-sm">{row.day}</span>
                <span className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: row.on ? "#00E2E5" : "rgba(255,255,255,0.3)" }}>
                  {row.time}
                </span>
              </div>
            ))}
          </div>
          <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-3">
            2 free games per child per day. Shoe rental not included.
          </p>
        </div>
      </section>

      {/* ====== LOCATION REGISTRATION CARDS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(253,91,86,0.25)" }}
            >
              Choose Your Location
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              You&apos;ll be taken to the Kids Bowl Free portal to complete registration
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {locations.map((loc) => (
              <div
                key={loc.name}
                className="rounded-lg overflow-hidden flex flex-col"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${loc.accent}35` }}
              >
                {/* Location color bar */}
                <div className="h-1.5" style={{ backgroundColor: loc.accent }} />

                <div className="p-6 text-center flex flex-col flex-1">
                  <h3
                    className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2"
                    style={{ textShadow: `0 0 15px ${loc.accent}25` }}
                  >
                    {loc.name}
                  </h3>
                  <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-1">{loc.address}</p>
                  <a href={`tel:${loc.phone.replace(/\D/g, "")}`} className="font-[var(--font-hp-body)] text-white/60 text-sm hover:text-white transition-colors mb-6">
                    {loc.phone}
                  </a>

                  <a
                    href={loc.registerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-auto w-full inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-3.5 rounded-full transition-all hover:scale-105"
                    style={{ backgroundColor: loc.accent, boxShadow: `0 0 16px ${loc.accent}35` }}
                  >
                    Register Here
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== NEXT STEP CTA ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(250px, 35vh, 350px)" }}>
        <Image
          src={`${BLOB}/images/headpinz/kbf-banner.png`}
          alt="Kids bowling"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-black/60 to-black/40" />
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#123075] via-white/60 to-[#fd5b56]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(250px, 35vh, 350px)" }}>
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{ fontSize: "clamp(24px, 5vw, 44px)", lineHeight: "1.05", letterSpacing: "-0.5px", marginBottom: "12px", textShadow: "0 0 30px rgba(253,91,86,0.3)" }}
          >
            Already Registered?
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-6">
            Step 2: Reserve your lane up to 24 hours in advance
          </p>
          <Link
            href="/hp/kids-bowl-free/book"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105"
            style={{ boxShadow: "0 0 20px rgba(253,91,86,0.3)" }}
          >
            Book a Lane
          </Link>
        </div>
      </section>
    </div>
  );
}
