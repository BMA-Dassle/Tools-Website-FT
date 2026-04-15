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
    subtitle: "",
    desc: "Give yourself the \"Pre-Race Window.\" Arriving early gives you time for any unexpected lines at check-in so you're cleared for the pits without losing a second of track time.",
    titleColor: "rgb(228,28,29)",
    badgeBg: "rgb(228,28,29)",
    borderColor: "rgb(228,28,29)",
  },
  {
    num: "2",
    title: "THE PIT GATE",
    subtitle: "Guest Services \u2014 2nd Floor",
    desc: "STOP HERE FIRST. This is where we verify waivers, check heights/ages, and issue your racing credentials. On weekends, additional team members are at our event check-in desk on the 1st floor.",
    titleColor: "rgb(0,74,173)",
    badgeBg: "rgb(0,74,173)",
    borderColor: "rgb(0,74,173)",
  },
  {
    num: "3",
    title: "TRACKSIDE CHECK-IN",
    subtitle: "1st Floor Karting Counter",
    desc: "Your race time is the close of karting check-in for your heat \u2014 not the start. Be at the 1st floor karting counter at least 5 minutes before your scheduled time to rent your POV camera and enter the safety briefing.",
    titleColor: "rgb(134,82,255)",
    badgeBg: "rgb(134,82,255)",
    borderColor: "rgb(134,82,255)",
  },
];

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

export default function RacerJourney() {
  const result = useTrackStatus();
  const trackData = result?.trackStatus ?? null;
  const currentRaces = result?.currentRaces ?? null;

  return (
    <section id="racers-journey" className="relative overflow-hidden" style={{ backgroundColor: "#000418" }}>
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
            className="font-heading font-black uppercase text-white leading-[0.9]"
            style={{ fontSize: "clamp(2.5rem, 6vw, 72px)" }}
          >
            THE RACER&apos;S JOURNEY ARRIVE TO DRIVE
          </h2>

          {/* Live Track Status */}
          <div>
            <p
              className="font-heading font-black uppercase mb-3"
              style={{ color: "rgba(255,255,255,0.898)", fontSize: "clamp(22px, 5vw, 32px)" }}
            >
              LIVE TRACK STATUS
            </p>
            <div className="flex flex-col gap-2">
              {trackData?.tracks.map((t) => {
                const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as "blue" | "red" | "mega";
                const race = currentRaces?.[key] ?? null;
                return (
                  <div
                    key={t.trackName}
                    className="px-4 py-3 rounded-xl"
                    style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}80` }}
                  >
                    <div className="flex items-center justify-between">
                      <span style={{ color: t.colors.trackIdentity, fontSize: "18px", fontFamily: "var(--font-body)", fontWeight: 600 }}>{t.trackName}</span>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${dotColor(t.status)} animate-pulse`} />
                        <span style={{ color: "rgb(245,236,238)", fontSize: "16px", fontFamily: "var(--font-body)" }}>{t.delayFormatted}</span>
                      </div>
                    </div>
                    {race && (
                      <p className="text-amber-400 text-xs font-bold mt-1 animate-pulse">
                        Checking In: Heat #{race.heatNumber} — {race.raceType}
                      </p>
                    )}
                  </div>
                );
              })}
              {!trackData && (
                <>
                  <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ backgroundColor: "rgba(1,10,32,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <span className="font-body text-white/30 text-sm">Loading status...</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3">
            <a
              href="/book/race"
              onClick={trackBookingClick}
              className="font-body font-bold uppercase text-white px-6 py-4 rounded-full text-sm tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(228,28,29)" }}
            >
              BOOK YOUR RACE NOW
            </a>
            <Link
              href="/attractions"
              className="font-body font-bold uppercase text-white px-6 py-4 rounded-full text-sm tracking-wider transition-all hover:scale-105"
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
                className="shrink-0 flex items-center justify-center font-heading text-white text-2xl"
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
                  className="font-heading uppercase"
                  style={{ color: s.titleColor, fontSize: "24px", marginBottom: s.subtitle ? "4px" : "8px" }}
                >
                  {s.title}
                </h3>
                {s.subtitle && (
                  <p style={{ color: "rgba(245,236,238,0.5)", fontSize: "13px", fontFamily: "var(--font-body)", marginBottom: "8px" }}>
                    {s.subtitle}
                  </p>
                )}
                <p style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", fontFamily: "var(--font-body)", lineHeight: "1.5" }}>
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
