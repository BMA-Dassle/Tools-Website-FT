"use client";

import { useState } from "react";
import Image from "next/image";
import SignupModal from "./SignupModal";
import SeoFaq from "@/components/headpinz/SeoFaq";

const coral = "#fd5b56";
const gold = "#FFD700";
const bg = "#0a1628";

export default function HaveABallPage() {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ backgroundColor: bg }}>
      {/* HERO */}
      <section className="relative overflow-hidden" style={{ minHeight: "70vh" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
          alt="HeadPinz Fort Myers bowling lanes"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, rgba(10,22,40,0.85) 0%, rgba(10,22,40,0.65) 50%, rgba(253,91,86,0.3) 100%)",
          }}
        />
        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "70vh" }}
        >
          <p
            className="font-body text-white uppercase tracking-[0.3em] mb-3 px-4 py-1.5 rounded-full"
            style={{ backgroundColor: "rgba(253,91,86,0.2)", border: `1px solid ${coral}60`, fontSize: "12px" }}
          >
            HeadPinz Fort Myers · New League
          </p>
          <h1
            className="font-heading font-black uppercase text-white"
            style={{
              fontSize: "clamp(44px, 10vw, 96px)",
              lineHeight: "1.02",
              letterSpacing: "-1px",
              marginBottom: "12px",
              textShadow: `0 0 40px rgba(253,91,86,0.35)`,
            }}
          >
            Have-A-Ball
            <br />
            League
          </h1>
          <p className="font-body text-white/80 max-w-xl" style={{ fontSize: "clamp(16px, 2.5vw, 20px)" }}>
            12 weeks of bowling. And yes — <span style={{ color: gold }}>you take home a new ball</span>.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 justify-center">
            <button
              onClick={() => setOpen(true)}
              className="inline-flex items-center font-body font-bold uppercase tracking-widest text-white px-8 py-4 rounded-full transition-all hover:scale-105"
              style={{ backgroundColor: coral, boxShadow: `0 0 30px ${coral}60`, fontSize: "14px" }}
            >
              Reserve Your Spot · $20/week
            </button>
            <a
              href="#details"
              className="inline-flex items-center font-body font-bold uppercase tracking-widest text-white/80 px-6 py-4 rounded-full border border-white/20 hover:border-white/40 transition-all"
              style={{ fontSize: "13px" }}
            >
              League Details ↓
            </a>
          </div>
        </div>
      </section>

      {/* KEY FACTS STRIP */}
      <section className="border-y border-white/10" style={{ backgroundColor: "rgba(255,255,255,0.02)" }}>
        <div className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          {[
            { label: "Starts", value: "May 26" },
            { label: "Time", value: "6:30 PM" },
            { label: "Length", value: "12 Weeks" },
            { label: "Weekly Fee", value: "$20" },
          ].map((f) => (
            <div key={f.label}>
              <p className="text-white/40 text-xs uppercase tracking-widest mb-1">{f.label}</p>
              <p className="font-heading font-black text-white uppercase" style={{ fontSize: "clamp(20px, 3vw, 28px)" }}>
                {f.value}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="details" className="px-4 py-16 md:py-24">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[#fd5b56] text-xs font-bold uppercase tracking-widest mb-2">How It Works</p>
            <h2
              className="font-heading font-black uppercase text-white"
              style={{ fontSize: "clamp(32px, 6vw, 56px)", letterSpacing: "-0.5px" }}
            >
              Roll Up,
              <br />
              <span style={{ color: coral }}>Keep the Ball.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <Card title="Pick Your Team" num="1" accent={coral}>
              Register solo and enter a team name or who you&apos;re bowling with — we&apos;ll group you. Doubles or trios (trios preferred).
            </Card>
            <Card title="Bowl 12 Weeks" num="2" accent={gold}>
              Show up every Tuesday at 6:30 PM. Weekly fee is $20, auto-billed to your card. $14.50 lineage, $5.50 toward your ball.
            </Card>
            <Card title="Take the Ball" num="3" accent="#00E2E5">
              At the end of the season, pick your new bowling ball — Brunswick T-Zone or Columbia White Dot, four colors.
            </Card>
          </div>
          <div className="text-center mt-10">
            <CtaButton onClick={() => setOpen(true)}>Reserve Your Spot</CtaButton>
          </div>
        </div>
      </section>

      {/* FEE BREAKDOWN */}
      <section className="px-4 py-12" style={{ backgroundColor: "#071027" }}>
        <div className="max-w-3xl mx-auto">
          <p className="text-[#fd5b56] text-xs font-bold uppercase tracking-widest mb-2 text-center">Fee Breakdown</p>
          <h2 className="font-heading font-black uppercase text-white text-center mb-6" style={{ fontSize: "clamp(24px, 4vw, 36px)" }}>
            $20 · Per Person · Per Week
          </h2>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <Row label="Lineage (lanes + shoes)" value="$14.50" />
            <Row label="Toward Your Ball" value="$5.50" />
            <div className="border-t border-white/10 px-5 py-3 flex justify-between bg-white/[0.05]">
              <span className="text-white font-bold">Weekly Total</span>
              <span className="text-white font-bold">$20.00</span>
            </div>
            <div className="px-5 py-3 flex justify-between text-white/40 text-sm">
              <span>Over 12 weeks</span>
              <span>$240.00</span>
            </div>
          </div>
          <p className="text-white/40 text-xs mt-4 text-center">
            Your card is charged $20 automatically each week starting May 26, 2026. No charge today.
          </p>
          <div className="text-center mt-8">
            <CtaButton onClick={() => setOpen(true)}>Reserve My Spot · $20/week</CtaButton>
          </div>
        </div>
      </section>

      {/* BALL CHOICE */}
      <section className="px-4 py-16">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <div>
            <p className="text-[#FFD700] text-xs font-bold uppercase tracking-widest mb-2">The Best Part</p>
            <h2 className="font-heading font-black uppercase text-white mb-4" style={{ fontSize: "clamp(30px, 5vw, 48px)", letterSpacing: "-0.5px" }}>
              A Brand New Ball, Yours to Keep
            </h2>
            <p className="text-white/70 leading-relaxed mb-4">
              Choose between the <strong className="text-white">Brunswick T-Zone</strong> or <strong className="text-white">Columbia White Dot</strong> — two
              of the most popular recreational balls on the planet. Four color choices each. Ball selection opens after the league starts — we&apos;ll email
              you the picker.
            </p>
            <ul className="text-white/60 text-sm space-y-1 mb-6">
              <li>· Brunswick T-Zone — classic polyester, smooth roll</li>
              <li>· Columbia White Dot — softer coverstock, more hook potential</li>
              <li>· Four colors per model (details coming soon)</li>
            </ul>
            <CtaButton onClick={() => setOpen(true)}>Sign Up Now</CtaButton>
          </div>
          <div
            className="relative rounded-2xl overflow-hidden border border-white/10"
            style={{ aspectRatio: "4/3" }}
          >
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hyperbowling.jpg"
              alt="Bowlers at HeadPinz Fort Myers"
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 50vw"
              unoptimized
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "linear-gradient(135deg, rgba(253,91,86,0.15) 0%, transparent 50%), linear-gradient(225deg, rgba(255,215,0,0.12) 0%, transparent 60%)",
              }}
            />
          </div>
        </div>
      </section>

      {/* GALLERY STRIP */}
      <section className="px-4 pb-16">
        <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp", alt: "HeadPinz lanes during cosmic bowling" },
            { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-family-bowling.jpg", alt: "Group bowling together at HeadPinz" },
            { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hyperbowling.jpg", alt: "HeadPinz HyperBowling LED pins" },
            { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/headpinz-bowling-l7MEjKld7FsVtVvOASAbzaoBvXhBhi.jpg", alt: "Bowling ball on HeadPinz lane" },
          ].map((img) => (
            <div key={img.src} className="relative rounded-xl overflow-hidden border border-white/10" style={{ aspectRatio: "4/3" }}>
              <Image
                src={img.src}
                alt={img.alt}
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 640px) 50vw, 25vw"
                unoptimized
              />
            </div>
          ))}
        </div>
        <div className="text-center mt-8">
          <CtaButton onClick={() => setOpen(true)}>Join the League</CtaButton>
        </div>
      </section>

      {/* FAQ */}
      <SeoFaq
        title="Have-A-Ball · FAQ"
        items={[
          { q: "When does the league start?", a: "Tuesday, May 26, 2026 at 6:30 PM. The season runs 12 consecutive weeks." },
          { q: "How much does it cost?", a: "$20 per person per week for 12 weeks ($240 total). $14.50 goes to lineage (lanes + shoes), $5.50 goes toward your end-of-season ball. Your card is auto-charged each week — no big upfront payment." },
          { q: "Do I really get to keep the ball?", a: "Yes! Every bowler takes home a new Brunswick T-Zone or Columbia White Dot at the end of the season. Four colors to choose from when the league starts." },
          { q: "Can I join with a friend or as a team?", a: "Yes. Everyone signs up individually, but enter a team name or who you're bowling with so we can group you. Format is doubles or trios — trios preferred." },
          { q: "I'm a beginner — is this league for me?", a: "Absolutely. Have-A-Ball is built for bowlers at every skill level, including first-timers. It's more about fun than scores." },
          { q: "When will my card be charged?", a: "The first $20 charge runs on the league start date, May 26, 2026. Then $20 every week for 11 more weeks." },
          { q: "How do I cancel?", a: "Call or stop by HeadPinz Fort Myers. We'll handle it — just keep in mind the league is a team commitment, so cancellations mid-season may affect your teammates." },
        ]}
      />

      {/* FINAL CTA */}
      <section className="relative overflow-hidden" style={{ minHeight: "360px" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/cta-wide.webp"
          alt="HeadPinz bowling lanes"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(10,22,40,0.85), rgba(7,16,39,0.92))" }} />
        <div className="relative z-10 px-4 py-16 text-center flex flex-col items-center justify-center" style={{ minHeight: "360px" }}>
          <h2 className="font-heading font-black uppercase text-white mb-4" style={{ fontSize: "clamp(32px, 6vw, 54px)", letterSpacing: "-0.5px" }}>
            Lanes Fill Fast.
          </h2>
          <p className="text-white/70 max-w-lg mx-auto mb-8">
            Lock your spot in the Have-A-Ball league now — first charge runs May 26, not today.
          </p>
          <button
            onClick={() => setOpen(true)}
            className="inline-flex items-center font-body font-bold uppercase tracking-widest text-white px-10 py-4 rounded-full transition-all hover:scale-105"
            style={{ backgroundColor: coral, boxShadow: `0 0 30px ${coral}60`, fontSize: "14px" }}
          >
            Reserve Your Spot
          </button>
        </div>
      </section>

      {open && <SignupModal onClose={() => setOpen(false)} />}
    </div>
  );
}

function Card({ num, title, children, accent }: { num: string; title: string; children: React.ReactNode; accent: string }) {
  return (
    <div
      className="rounded-xl p-6"
      style={{ backgroundColor: "rgba(7,16,39,0.6)", border: `1.5px dashed ${accent}40` }}
    >
      <div
        className="inline-flex items-center justify-center rounded-md text-white font-display mb-4"
        style={{ backgroundColor: accent, width: 40, height: 48, fontSize: "18px" }}
      >
        {num}
      </div>
      <h3 className="font-heading uppercase text-white text-lg mb-2 tracking-wider">{title}</h3>
      <p className="text-white/60 text-sm leading-relaxed">{children}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-3 flex justify-between border-b border-white/5 last:border-0">
      <span className="text-white/70">{label}</span>
      <span className="text-white font-bold">{value}</span>
    </div>
  );
}

function CtaButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center font-body font-bold uppercase tracking-widest text-white px-8 py-4 rounded-full transition-all hover:scale-105"
      style={{ backgroundColor: "#fd5b56", boxShadow: "0 0 24px rgba(253,91,86,0.45)", fontSize: "14px" }}
    >
      {children}
    </button>
  );
}
