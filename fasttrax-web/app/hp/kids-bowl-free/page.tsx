import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

export const metadata: Metadata = {
  title: "Kids Bowl Free - Free Summer Bowling for Kids | HeadPinz & FastTrax",
  description:
    "Kids 15 and under bowl 2 free games every weekday this summer at HeadPinz Fort Myers, HeadPinz Naples, and FastTrax Fort Myers. Register today!",
  openGraph: {
    title: "Kids Bowl Free - HeadPinz & FastTrax",
    description: "2 free games every weekday for kids 15 and under. Three locations in Southwest Florida.",
    type: "website",
    url: "https://headpinz.com/hp/kids-bowl-free",
  },
  alternates: { canonical: "https://headpinz.com/hp/kids-bowl-free" },
};

const features = [
  {
    image: `${BLOB}/images/headpinz/kbf-feature1.png`,
    title: "2 Free Games Daily",
    desc: "Every registered child gets 2 free games every weekday, Monday through Friday.",
  },
  {
    image: `${BLOB}/images/headpinz/kbf-feature2.png`,
    title: "3 Locations",
    desc: "HeadPinz Fort Myers, HeadPinz Naples, and FastTrax Fort Myers — pick whichever is closest.",
  },
  {
    image: `${BLOB}/images/headpinz/kbf-feature3.png`,
    title: "Easy Registration",
    desc: "Sign up online, get weekly passes via email or the KBF mobile app, then book a lane.",
  },
];

export default function KidsBowlFreePage() {
  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "80vh" }}>
        <Image
          src={`${BLOB}/images/headpinz/kbf-banner.png`}
          alt="Kids Bowl Free at HeadPinz"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "80vh" }}
        >
          <div className="relative mb-6" style={{ width: "clamp(80px, 15vw, 120px)", height: "clamp(80px, 15vw, 120px)" }}>
            <Image
              src={`https://www.kidsbowlfree.com/img/kbf-logo-23.png`}
              alt="Kids Bowl Free"
              fill
              className="object-contain"
              sizes="120px"
              unoptimized
            />
          </div>

          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "16px",
              textShadow: "0 0 40px rgba(253,91,86,0.35)",
            }}
          >
            Kids Bowl Free
          </h1>
          <p
            className="font-[var(--font-hp-body)] text-white/80 max-w-xl mx-auto"
            style={{ fontSize: "clamp(14px, 2.5vw, 20px)", lineHeight: "1.5", marginBottom: "12px" }}
          >
            2 free games every weekday for kids 15 &amp; under
          </p>
          <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-8">
            HeadPinz Fort Myers &bull; HeadPinz Naples &bull; FastTrax Fort Myers
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/hp/kids-bowl-free/register"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105"
              style={{ boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
            >
              Register Now
            </Link>
            <Link
              href="/hp/kids-bowl-free/book"
              className="inline-flex items-center text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 border border-white/20 hover:border-white/40"
              style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
            >
              Book a Lane
            </Link>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== HOW IT WORKS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(253,91,86,0.25)" }}
            >
              How It Works
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: "linear-gradient(90deg, #fd5b56, #FFD700)" }} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { step: "1", title: "Register Your Kids", desc: "Sign up through the Kids Bowl Free portal. Each child must be registered individually. Ages 15 and under.", accent: "#fd5b56" },
              { step: "2", title: "Get Weekly Passes", desc: "You'll receive weekly passes via email or in the Kids Bowl Free mobile app throughout the summer.", accent: "#FFD700" },
              { step: "3", title: "Book & Bowl", desc: "Reserve a lane online up to 24 hours in advance. Show your pass at check-in and enjoy 2 free games!", accent: "#00E2E5" },
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

      {/* ====== FEATURE CARDS ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-lg overflow-hidden"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(253,91,86,0.2)" }}
            >
              <div className="relative" style={{ height: "200px" }}>
                <Image src={f.image} alt={f.title} fill className="object-cover" sizes="33vw" unoptimized />
              </div>
              <div className="p-5">
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-2">
                  {f.title}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ====== SCHEDULE ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(24px, 4vw, 40px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(255,215,0,0.25)" }}
            >
              When Can Kids Bowl Free?
            </h2>
          </div>

          <div
            className="rounded-lg p-6"
            style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
          >
            <div className="space-y-3">
              {[
                { day: "Monday \u2013 Thursday", time: "Open to Close", available: true },
                { day: "Friday", time: "Open to 5 PM", available: true },
                { day: "Saturday \u2013 Sunday", time: "Not Available", available: false },
              ].map((row) => (
                <div key={row.day} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                  <span className="font-[var(--font-hp-body)] text-white font-bold text-sm">{row.day}</span>
                  <span
                    className="font-[var(--font-hp-body)] text-sm font-bold"
                    style={{ color: row.available ? "#FFD700" : "rgba(255,255,255,0.3)" }}
                  >
                    {row.time}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ====== LOCATIONS ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(24px, 4vw, 40px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(0,226,229,0.25)" }}
            >
              Participating Locations
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              { name: "HeadPinz Fort Myers", address: "14513 Global Pkwy, Fort Myers, FL 33913", phone: "(239) 302-2155", phoneTel: "+12393022155" },
              { name: "HeadPinz Naples", address: "8525 Radio Ln, Naples, FL 34104", phone: "(239) 455-3755", phoneTel: "+12394553755" },
              { name: "FastTrax Fort Myers", address: "14501 Global Pkwy, Fort Myers, FL 33913", phone: "(239) 481-9666", phoneTel: "+12394819666" },
            ].map((loc) => (
              <div
                key={loc.name}
                className="rounded-lg p-5 text-center"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(0,226,229,0.25)" }}
              >
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-2" style={{ color: "#00E2E5" }}>
                  {loc.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-1">{loc.address}</p>
                <a href={`tel:${loc.phoneTel}`} className="font-[var(--font-hp-body)] text-white/70 text-sm hover:text-white transition-colors">
                  {loc.phone}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== CTA ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(300px, 40vh, 400px)" }}>
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

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(300px, 40vh, 400px)" }}>
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{ fontSize: "clamp(28px, 6vw, 52px)", lineHeight: "1.05", letterSpacing: "-1px", marginBottom: "16px", textShadow: "0 0 30px rgba(253,91,86,0.3)" }}
          >
            Ready to Sign Up?
          </h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/hp/kids-bowl-free/register"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
              style={{ boxShadow: "0 0 20px rgba(253,91,86,0.3)" }}
            >
              Register Now
            </Link>
            <Link
              href="/hp/kids-bowl-free/book"
              className="inline-flex items-center text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105 border border-white/20 hover:border-white/40"
              style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
            >
              Book a Lane
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
