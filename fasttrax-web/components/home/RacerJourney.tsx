"use client";

import Link from "next/link";
import Image from "next/image";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { trackBookingClick } from "@/lib/analytics";

// Exact data from live site: 3 step cards with precise colors
const steps = [
  {
    num: "1",
    title: "ARRIVE 30 MINUTES EARLY",
    desc: 'Give yourself the "Pre-Race Window." This ensures you clear the lines and get cleared for the pits without losing track time.',
    titleColor: "rgb(228,28,29)",
    badgeBg: "rgb(228,28,29)",
    borderColor: "rgb(228,28,29)",
  },
  {
    num: "2",
    title: "THE PIT GATE (GUEST SERVICES) - MAIN ENTRY",
    desc: "STOP HERE FIRST. This is where we verify waivers, check heights/ages, and issue your racing credentials.",
    titleColor: "rgb(0,74,173)",
    badgeBg: "rgb(0,74,173)",
    borderColor: "rgb(0,74,173)",
  },
  {
    num: "3",
    title: "TRACKSIDE CHECK-IN (1ST FLOOR)",
    desc: "Rent your POV camera and enter the safety briefing.",
    titleColor: "rgb(134,82,255)",
    badgeBg: "rgb(134,82,255)",
    borderColor: "rgb(134,82,255)",
  },
];

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

export default function RacerJourney() {
  const trackData = useTrackStatus();

  return (
    <section className="relative overflow-hidden" style={{ backgroundColor: "#000418" }}>
      {/* Background image */}
      <Image
        src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/racer-journey-bg.webp"
        alt="Racer on track"
        fill
        className="object-cover object-center"
        sizes="100vw"
      />
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/90 via-[#000418]/75 to-[#000418]/55" />

      {/* Inner layout — 2 equal columns, padding 0 32px, gap 24px */}
      <div
        className="relative z-10 flex flex-col lg:flex-row gap-6 max-w-7xl mx-auto"
        style={{ padding: "clamp(40px, 8vw, 80px) clamp(16px, 4vw, 32px)" }}
      >

        {/* LEFT COL: Heading + Track Status + CTAs */}
        <div className="flex-1 flex flex-col gap-6 justify-center">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white leading-[0.9]"
            style={{ fontSize: "clamp(2.5rem, 6vw, 72px)" }}
          >
            THE RACER&apos;S JOURNEY ARRIVE TO DRIVE
          </h2>

          {/* Live Track Status */}
          <div>
            <p
              className="font-[var(--font-anton)] italic uppercase mb-3"
              style={{ color: "rgba(255,255,255,0.898)", fontSize: "clamp(22px, 5vw, 32px)" }}
            >
              LIVE TRACK STATUS
            </p>
            <div className="flex flex-col gap-2">
              {trackData?.megaTrackEnabled && (
                <div
                  className="flex items-center justify-between px-4 py-3 rounded-xl"
                  style={{ backgroundColor: "rgba(1,10,32,0.6)", border: "1px solid rgba(134,82,255,0.5)" }}
                >
                  <span style={{ color: "rgb(134,82,255)", fontSize: "18px", fontFamily: "var(--font-poppins)", fontWeight: 600 }}>Mega Track</span>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span style={{ color: "rgb(245,236,238)", fontSize: "16px", fontFamily: "var(--font-poppins)" }}>Active</span>
                  </div>
                </div>
              )}
              {trackData?.tracks.map((t) => (
                <div
                  key={t.trackName}
                  className="flex items-center justify-between px-4 py-3 rounded-xl"
                  style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}80` }}
                >
                  <span style={{ color: t.colors.trackIdentity, fontSize: "18px", fontFamily: "var(--font-poppins)", fontWeight: 600 }}>{t.trackName}</span>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dotColor(t.status)} animate-pulse`} />
                    <span style={{ color: "rgb(245,236,238)", fontSize: "16px", fontFamily: "var(--font-poppins)" }}>{t.delayFormatted}</span>
                  </div>
                </div>
              ))}
              {!trackData && (
                <>
                  <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ backgroundColor: "rgba(1,10,32,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <span className="font-[var(--font-poppins)] text-white/30 text-sm">Loading status...</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              onClick={trackBookingClick}
              className="font-[var(--font-poppins)] font-bold uppercase text-white px-6 py-4 rounded-full text-sm tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(228,28,29)" }}
            >
              BOOK YOUR RACE NOW
            </a>
            <Link
              href="/attractions"
              className="font-[var(--font-poppins)] font-bold uppercase text-white px-6 py-4 rounded-full text-sm tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(0,74,173)" }}
            >
              EXPLORE DESTINATION COMBOS
            </Link>
          </div>
        </div>

        {/* RIGHT COL: 3 step cards */}
        <div className="flex-1 flex flex-col gap-4">
          {steps.map((s) => (
            <div
              key={s.num}
              className="flex gap-4 items-start"
              style={{
                backgroundColor: "rgba(7,16,39,0.6)",
                border: `1.78px dashed ${s.borderColor}`,
                borderRadius: "44px",
                padding: "clamp(16px, 3vw, 28px) clamp(12px, 2vw, 16px)",
              }}
            >
              {/* Number badge */}
              <div
                className="shrink-0 flex items-center justify-center font-[var(--font-anton)] text-white text-2xl"
                style={{
                  backgroundColor: s.badgeBg,
                  borderRadius: "8px",
                  width: "48px",
                  height: "64px",
                }}
              >
                {s.num}
              </div>

              {/* Text */}
              <div>
                <h3
                  className="font-[var(--font-anton)] uppercase mb-2"
                  style={{ color: s.titleColor, fontSize: "24px" }}
                >
                  {s.title}
                </h3>
                <p style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", fontFamily: "var(--font-poppins)", lineHeight: "1.5" }}>
                  {s.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
