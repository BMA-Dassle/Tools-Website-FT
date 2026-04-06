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
    registerUrl: "https://www.kidsbowlfree.com/center.php?alley_id=5581",
    accent: "#00E2E5",
  },
];

export default function KBFRegisterPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO ====== */}
      <section
        className="relative flex flex-col items-center justify-center text-center px-4"
        style={{ paddingTop: "clamp(120px, 18vw, 180px)", paddingBottom: "clamp(40px, 6vw, 60px)" }}
      >
        <div className="relative mb-4" style={{ width: "80px", height: "80px" }}>
          <Image src={`${BLOB}/images/headpinz/kbf-logo.png`} alt="Kids Bowl Free" fill className="object-contain" sizes="80px" unoptimized />
        </div>

        <h1
          className="font-[var(--font-hp-hero)] font-black uppercase text-white"
          style={{ fontSize: "clamp(28px, 7vw, 56px)", lineHeight: "1.05", letterSpacing: "-1px", marginBottom: "12px", textShadow: "0 0 40px rgba(253,91,86,0.35)" }}
        >
          Register Your Kids
        </h1>
        <p className="font-[var(--font-hp-body)] text-white/60 text-sm max-w-lg mx-auto mb-2">
          The first step is registering each child through the Kids Bowl Free portal at your preferred location. Once registered, you&apos;ll receive weekly passes via email or in the KBF mobile app.
        </p>
        <div className="mx-auto h-1 w-24 rounded-full mt-4" style={{ background: "linear-gradient(90deg, #fd5b56, #FFD700)" }} />
      </section>

      {/* ====== ELIGIBILITY ====== */}
      <section style={{ padding: "clamp(20px, 4vw, 40px) clamp(16px, 4vw, 32px) clamp(40px, 6vw, 60px)" }}>
        <div
          className="max-w-3xl mx-auto rounded-lg p-6"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
        >
          <h2 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-4" style={{ color: "#FFD700" }}>
            Who Can Register?
          </h2>
          <ul className="space-y-2">
            {[
              "Children must be 15 years old or younger",
              "Parents or grandparents must complete registration",
              "Each child must be registered individually",
              "Passes must be shown at check-in (email or KBF app)",
              "Registration must be completed before booking a lane",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-[#FFD700]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span className="font-[var(--font-hp-body)] text-white/70 text-sm">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ====== LOCATION REGISTRATION CARDS ====== */}
      <section style={{ padding: "clamp(40px, 6vw, 60px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(253,91,86,0.25)" }}
            >
              Choose Your Location
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              Select a location to register your child at the Kids Bowl Free portal
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {locations.map((loc) => (
              <div
                key={loc.name}
                className="rounded-lg p-6 text-center flex flex-col"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${loc.accent}30` }}
              >
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-2">
                  {loc.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-1">{loc.address}</p>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-5">{loc.phone}</p>
                <a
                  href={loc.registerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto inline-flex items-center justify-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-full transition-all hover:scale-105"
                  style={{ backgroundColor: loc.accent, boxShadow: `0 0 16px ${loc.accent}30` }}
                >
                  Register Here
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== NEXT STEP ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-3xl mx-auto text-center">
          <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-4">
            Already registered?
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
