"use client";

import SubpageHero from "@/components/SubpageHero";
import TrackStatus from "@/components/home/TrackStatus";
import Image from "next/image";
import { useState } from "react";
import { trackBookingClick } from "@/lib/analytics";

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";
const blueGlow = "rgba(0,12,255,0.4) 0px 0px 30px";
const redGlow = "rgba(255,0,0,0.4) 0px 0px 30px";

export default function RacingPage() {
  const [activeTrack, setActiveTrack] = useState<"split" | "mega">("split");

  return (
    <>
      <SubpageHero
        title="Racing & Qualifications"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/qualifications-hero.webp"
      />

      <TrackStatus />

      {/* ── Section: Race Types & Qualifications ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Race Types &amp; Qualifications
          </h2>
          <p
            className="text-center mx-auto mb-10 font-[var(--font-poppins)]"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
          >
            Every racer starts in Starter. Prove your speed to unlock faster tiers.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {[
              {
                title: "Adult Starter",
                color: "rgb(228,28,29)",
                border: "rgba(228,28,29,0.59)",
                age: "13+ / 59\u201d+",
                qual: "None \u2014 all racers start here",
                desc: "Fun meets friendly competition. Perfect for families, casual drivers, and first-timers.",
              },
              {
                title: "Adult Intermediate",
                color: "rgb(0,74,173)",
                border: "rgba(0,74,173,0.59)",
                age: "16+ / 59\u201d+",
                qual: "Lap time of 41.5s (Blue) or 47s (Red) in Starter",
                desc: "For serious drivers. High-speed karts, competitive lap tracking, challenging layout.",
              },
              {
                title: "Adult Pro",
                color: "rgb(134,82,255)",
                border: "rgba(134,82,255,0.59)",
                age: "16+ / 59\u201d+",
                qual: "Lap time of 32.25s (Blue) or 37.25s (Red) in Intermediate",
                desc: "Ultimate test of skill and speed. Fastest karts, precision timing, most demanding config.",
              },
              {
                title: "Junior Starter",
                color: "rgb(228,28,29)",
                border: "rgba(228,28,29,0.59)",
                age: "7\u201313 / 49\u201d\u201370\u201d",
                qual: "None \u2014 all juniors start here",
                desc: "Speed-controlled karts, easy track layout, team supervision.",
              },
              {
                title: "Junior Intermediate",
                color: "rgb(0,74,173)",
                border: "rgba(0,74,173,0.59)",
                age: "7\u201313 / 49\u201d\u201370\u201d",
                qual: "Lap time of 1:15 in Junior Starter",
                desc: "Faster karts, more challenging layout, real competition.",
              },
              {
                title: "Junior Pro",
                color: "rgb(134,82,255)",
                border: "rgba(134,82,255,0.59)",
                age: "7\u201313 / 49\u201d\u201370\u201d",
                qual: "Lap time of 45s in Junior Intermediate",
                desc: "Fastest junior karts, precision timing, most demanding config.",
              },
            ].map((rt) => (
              <div
                key={rt.title}
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${rt.border}`,
                  borderRadius: "8px",
                  padding: "24px 20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: rt.color, fontSize: "24px", letterSpacing: "1.2px" }}>
                  {rt.title}
                </h3>
                <div className="font-[var(--font-poppins)] mb-3 flex flex-col gap-1" style={{ fontSize: "14px" }}>
                  <p style={{ color: "rgba(245,236,238,0.6)" }}>
                    <strong style={{ color: "rgba(245,236,238,0.9)" }}>Age/Height:</strong> {rt.age}
                  </p>
                  <p style={{ color: "rgba(245,236,238,0.6)" }}>
                    <strong style={{ color: "rgba(245,236,238,0.9)" }}>Qualification:</strong> {rt.qual}
                  </p>
                </div>
                <p className="font-[var(--font-poppins)] flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.5" }}>
                  {rt.desc}
                </p>
              </div>
            ))}
          </div>

          <p
            className="font-[var(--font-poppins)] text-center mt-10 mx-auto"
            style={{
              color: "rgb(255,193,7)",
              fontSize: "15px",
              lineHeight: "1.5",
              maxWidth: "700px",
              padding: "16px 20px",
              backgroundColor: "rgba(255,193,7,0.08)",
              borderRadius: "8px",
              border: "1px solid rgba(255,193,7,0.25)",
            }}
          >
            All racers must start in Starter — you cannot skip levels. To unlock Intermediate, you must hit the qualifying lap time in Starter. To unlock Pro, you must qualify in Intermediate first.
          </p>
        </div>
      </section>

      {/* ── Section: Racer Requirements ── */}
      <section className="bg-[#000418]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Racer Requirements
          </h2>
          <p
            className="text-center mx-auto mb-10 font-[var(--font-poppins)]"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
          >
            All racers must meet the age and height requirements for their kart class. A $4.99 Racing License (valid for one year) is required.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {[
              {
                title: "Adult Karts",
                color: "rgb(228,28,29)",
                border: "rgba(228,28,29,0.59)",
                items: [
                  { label: "Ages", value: "13+" },
                  { label: "Min Height", value: "59\u201d (4\u20199\u201d)" },
                ],
              },
              {
                title: "Junior Karts",
                color: "rgb(0,74,173)",
                border: "rgba(0,74,173,0.59)",
                items: [
                  { label: "Ages", value: "7\u201313" },
                  { label: "Height", value: "49\u201d to 70\u201d" },
                  { label: "Track", value: "Blue Track only" },
                  { label: "Note", value: "First-time Junior races not available on Mega Track Tuesdays" },
                ],
              },
              {
                title: "Mini Karts",
                color: "rgb(134,82,255)",
                border: "rgba(134,82,255,0.59)",
                items: [
                  { label: "Ages", value: "3\u20136" },
                  { label: "Height", value: "No minimum" },
                  { label: "Hours", value: "Close at 10:00 PM daily" },
                ],
              },
            ].map((kart) => (
              <div
                key={kart.title}
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${kart.border}`,
                  borderRadius: "8px",
                  padding: "24px 20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-4" style={{ color: kart.color, fontSize: "24px", letterSpacing: "1.2px" }}>
                  {kart.title}
                </h3>
                <div className="flex flex-col gap-2">
                  {kart.items.map((item) => (
                    <div key={item.label} className="font-[var(--font-poppins)] flex justify-between gap-3" style={{ fontSize: "15px", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "8px" }}>
                      <span style={{ color: "rgba(245,236,238,0.6)" }}>{item.label}</span>
                      <span style={{ color: "rgba(245,236,238,0.95)", fontWeight: 500, textAlign: "right" }}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p
            className="font-[var(--font-poppins)] text-center mt-10 mx-auto"
            style={{
              color: "rgb(255,193,7)",
              fontSize: "15px",
              lineHeight: "1.5",
              maxWidth: "700px",
              padding: "16px 20px",
              backgroundColor: "rgba(255,193,7,0.08)",
              borderRadius: "8px",
              border: "1px solid rgba(255,193,7,0.25)",
            }}
          >
            FastTrax has strict age guidelines for your safety. Misrepresenting age may result in removal from the facility.
          </p>
        </div>
      </section>

      {/* ── Section: Performance Hub & Racing App ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/racing-app-bg.webp"
          alt="Racing app"
          fill
          className="object-cover object-right-bottom"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/70 via-[#000418]/50 to-transparent" />
        <div
          className="relative z-10 max-w-7xl mx-auto"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "32px",
              textShadow: glowShadow,
            }}
          >
            The Performance Hub &amp; Racing App
          </h2>
          <div className="flex flex-col gap-4 max-w-2xl">
            {[
              {
                title: "01. View Live Timing",
                desc: "See real-time leaderboards from your phone while you wait for your heat.",
              },
              {
                title: "02. Track Your Progress",
                desc: "Monitor your ProSkill\u2122 ranking and see how close you are to unlocking the next Speed Tier.",
              },
              {
                title: "03. Race History",
                desc: "Access a permanent archive of every lap you\u2019ve ever driven at FastTrax.",
              },
              {
                title: "04. Express Check-In",
                desc: "Use your personal QR code for faster check-in at Guest Services.",
              },
            ].map((f) => (
              <div
                key={f.title}
                style={{
                  backgroundColor: "rgba(7,16,39,0.6)",
                  borderLeft: "1.78px solid rgb(134,82,255)",
                  borderTop: "0.89px dashed rgb(134,82,255)",
                  borderRight: "0.89px dashed rgb(134,82,255)",
                  borderBottom: "0.89px dashed rgb(134,82,255)",
                  borderRadius: "12px",
                  padding: "16px 20px",
                }}
              >
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgb(134,82,255)",
                    fontSize: "18px",
                    fontWeight: 600,
                    marginBottom: "4px",
                  }}
                >
                  {f.title}
                </p>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgb(245,236,238)",
                    fontSize: "16px",
                    fontWeight: 500,
                    lineHeight: "1.5",
                  }}
                >
                  {f.desc}
                </p>
              </div>
            ))}
          </div>

          {/* App Store Buttons */}
          <div className="flex gap-4 mt-8">
            <a
              href="https://smstim.in/headpinzftmyers"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(134,82,255)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              Download on the App Store
            </a>
            <a
              href="https://smstim.in/headpinzftmyers"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(134,82,255)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              Get it on Google Play
            </a>
          </div>
        </div>
      </section>

      {/* ── Section: World-Class Partnerships ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: glowShadow,
            }}
          >
            World-Class Partnerships: The FastTrax Tech Stack
          </h2>

          {/* Partnership Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {[
              {
                title: "The Engineering (360Karting)",
                desc: "360Karting is a world leader in indoor karting track design and manufacturing. Their multi-level modular steel structures are engineered for maximum racing excitement with banked turns, elevation changes, and a layout built for competitive racing at every speed tier.",
                borderColor: "rgb(228,28,29)",
                logo: "https://360karting.com/wp-content/uploads/2023/07/360-KARTING_PRIMARY-01.png",
              },
              {
                title: "The Machine (Biz-Karts EcoVolt GT)",
                desc: "Biz-Karts is a premier electric kart manufacturer delivering high-performance, zero-emission racing machines. The EcoVolt GT features 10.5 kW brushless motors with instant torque, an F1-style digital steering display, smart LED halo lighting, and adjustable pedals and seats for racers ages 3+.",
                borderColor: "rgb(0,74,173)",
                logo: "https://bizkarts.com/wp-content/uploads/2023/02/logo-dark.svg",
              },
              {
                title: "The Intelligence (BMI Leisure)",
                desc: "BMI Leisure powers our precision lap timing, live leaderboards, and race management systems. Their technology also delivers Smart Crash Detection \u2014 only karts within 75 feet of a wreck are automatically slowed. If you\u2019re on the other side of the track, you stay at full speed.",
                borderColor: "rgb(134,82,255)",
                logo: "https://bmileisure.com/wp-content/uploads/2025/10/BMI-logo-black-1.jpg",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${card.borderColor}`,
                  borderRadius: "8px",
                  padding: "32px 24px",
                  textAlign: "center",
                }}
              >
                {/* Vendor Logo */}
                <div className="mb-4 flex justify-center" style={{ height: "48px" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={card.logo}
                    alt={card.title}
                    style={{ maxHeight: "48px", maxWidth: "160px", objectFit: "contain", borderRadius: "555px", backgroundColor: "rgba(255,255,255,0.92)", padding: "6px 16px" }}
                  />
                </div>
                <h3
                  className="font-[var(--font-anton)] uppercase"
                  style={{
                    color: card.borderColor,
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                    marginBottom: "12px",
                  }}
                >
                  {card.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.898)",
                    fontSize: "16px",
                    lineHeight: "1.6",
                    fontWeight: 400,
                  }}
                >
                  {card.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Track Layouts ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "32px",
              textShadow: glowShadow,
            }}
          >
            Florida&apos;s Premier Track Layouts
          </h2>

          {/* Tab labels */}
          <div className="flex justify-center gap-8 mb-8">
            <button
              onClick={() => setActiveTrack("split")}
              className="font-[var(--font-anton)] uppercase cursor-pointer bg-transparent border-none"
              style={{
                fontSize: "24px",
                letterSpacing: "1.2px",
                color:
                  activeTrack === "split"
                    ? "rgb(255,255,255)"
                    : "rgba(255,255,255,0.35)",
                transition: "color 0.3s",
              }}
            >
              Red/Blue Track
            </button>
            <button
              onClick={() => setActiveTrack("mega")}
              className="font-[var(--font-anton)] uppercase cursor-pointer bg-transparent border-none"
              style={{
                fontSize: "24px",
                letterSpacing: "1.2px",
                color:
                  activeTrack === "mega"
                    ? "rgb(255,255,255)"
                    : "rgba(255,255,255,0.35)",
                transition: "color 0.3s",
              }}
            >
              Mega Track
            </button>
          </div>

          {/* Track card - Red/Blue */}
          {activeTrack === "split" && (
            <div
              className="max-w-4xl mx-auto"
              style={{
                backgroundColor: "rgba(7,16,39,0.6)",
                border: "1.78px dashed rgba(221,221,221,0.18)",
                borderRadius: "44px",
                padding: "clamp(20px, 5vw, 44px)",
                backdropFilter: "blur(6.6px)",
                boxShadow: "rgba(0,0,0,0.1) 0px 4px 30px 0px",
              }}
            >
              <div className="flex flex-col lg:flex-row gap-11">
                {/* Blue Track */}
                <div className="flex-1 flex flex-col gap-3">
                  <h3
                    className="font-[var(--font-anton)] uppercase"
                    style={{
                      color: "rgb(0,74,173)",
                      fontSize: "24px",
                      letterSpacing: "3px",
                      textShadow: blueGlow,
                    }}
                  >
                    The Blue Track (1,095 ft)
                  </h3>
                  <p
                    className="font-[var(--font-poppins)]"
                    style={{
                      color: "rgba(245,236,238,0.898)",
                      fontSize: "18px",
                    }}
                  >
                    Technical &amp; Counter-clockwise.
                  </p>
                </div>
                {/* Red Track */}
                <div className="flex-1 flex flex-col gap-3">
                  <h3
                    className="font-[var(--font-anton)] uppercase"
                    style={{
                      color: "rgb(228,28,29)",
                      fontSize: "24px",
                      letterSpacing: "1px",
                      textShadow: redGlow,
                    }}
                  >
                    The Red Track (1,013 ft)
                  </h3>
                  <p
                    className="font-[var(--font-poppins)]"
                    style={{
                      color: "rgba(245,236,238,0.898)",
                      fontSize: "18px",
                    }}
                  >
                    High-speed &amp; Clockwise.
                  </p>
                </div>
              </div>

              {/* Track GIF */}
              <div className="mt-8 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/track-layout-1.gif"
                  alt="Red and Blue track layout animation"
                  className="rounded-2xl max-w-full"
                  style={{ maxHeight: "400px" }}
                />
              </div>
            </div>
          )}

          {/* Track card - Mega Track */}
          {activeTrack === "mega" && (
            <div
              className="max-w-4xl mx-auto"
              style={{
                backgroundColor: "rgba(7,16,39,0.6)",
                border: "1.78px dashed rgba(221,221,221,0.18)",
                borderRadius: "44px",
                padding: "clamp(20px, 5vw, 44px)",
                backdropFilter: "blur(6.6px)",
                boxShadow: "rgba(0,0,0,0.1) 0px 4px 30px 0px",
              }}
            >
              <div className="flex flex-col gap-3">
                <h3
                  className="font-[var(--font-anton)] uppercase"
                  style={{
                    color: "rgb(134,82,255)",
                    fontSize: "24px",
                    letterSpacing: "3px",
                    textShadow: "rgba(134,82,255,0.4) 0px 0px 30px",
                  }}
                >
                  The Mega Track (2,108 ft)
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.898)",
                    fontSize: "18px",
                  }}
                >
                  Tuesdays Only: Florida&apos;s longest multi-level track.
                </p>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgb(255,193,7)",
                    fontSize: "16px",
                    lineHeight: "1.5",
                    marginTop: "8px",
                    padding: "12px 16px",
                    backgroundColor: "rgba(255,193,7,0.1)",
                    borderRadius: "8px",
                    border: "1px solid rgba(255,193,7,0.3)",
                  }}
                >
                  &#9888;&#65039; Junior Notice: First-time Juniors cannot race
                  the Mega Track. You must qualify on a split-track day first.
                </p>
              </div>

              {/* Track GIF */}
              <div className="mt-8 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/mega-track-layout.gif"
                  alt="Mega track layout animation"
                  className="rounded-2xl max-w-full"
                  style={{ maxHeight: "400px" }}
                />
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="text-center mt-10">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              onClick={trackBookingClick}
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(228,28,29)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              Book Your Race Now
            </a>
          </div>
        </div>
      </section>

      {/* ── Section: The Grid Rules ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Racing background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/60 via-[#000418]/30 to-transparent" />
        <div
          className="relative z-10 max-w-7xl mx-auto flex flex-col lg:flex-row gap-8 lg:gap-16 items-start lg:items-center"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          {/* Left: Title */}
          <div className="lg:w-2/5 shrink-0">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{
                fontSize: "clamp(32px, 8vw, 72px)",
                lineHeight: "1",
                letterSpacing: "3px",
                textShadow: glowShadow,
              }}
            >
              The Grid Rules
            </h2>
          </div>

          {/* Right: Rule cards stacked */}
          <div className="flex flex-col gap-4 flex-1 w-full">
            {[
              {
                num: "1",
                title: "The 30-Minute Window",
                desc: "Arrival time for Guest Services (Ground Floor).",
                bg: "rgba(228,28,29,0.25)",
                borderColor: "rgba(228,28,29,0.6)",
                badgeColor: "rgb(228,28,29)",
                titleColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Closed-Toe Shoes",
                desc: "Required. No exceptions.",
                bg: "rgba(0,74,173,0.25)",
                borderColor: "rgba(0,74,173,0.6)",
                badgeColor: "rgb(0,74,173)",
                titleColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "No Pocket Litter",
                desc: "Lockers provided for phones/keys.",
                bg: "rgba(134,82,255,0.25)",
                borderColor: "rgba(134,82,255,0.6)",
                badgeColor: "rgb(134,82,255)",
                titleColor: "rgb(134,82,255)",
              },
              {
                num: "4",
                title: "The Timer Guarantee",
                desc: "Red flags stop the clock. You get every second you paid for.",
                bg: "rgba(228,28,150,0.25)",
                borderColor: "rgba(228,28,150,0.6)",
                badgeColor: "rgb(228,28,150)",
                titleColor: "rgb(228,28,150)",
              },
            ].map((rule) => (
              <div
                key={rule.num}
                className="flex items-center gap-5 backdrop-blur-sm"
                style={{
                  backgroundColor: rule.bg,
                  border: `1.78px dashed ${rule.borderColor}`,
                  borderRadius: "16px",
                  padding: "clamp(16px, 3vw, 24px) clamp(16px, 3vw, 28px)",
                }}
              >
                <div
                  className="font-[var(--font-anton)] shrink-0"
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "8px",
                    backgroundColor: rule.badgeColor,
                    color: "white",
                    fontSize: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {rule.num}
                </div>
                <div>
                  <h3
                    className="font-[var(--font-anton)] uppercase"
                    style={{
                      color: rule.titleColor,
                      fontSize: "clamp(16px, 3vw, 22px)",
                      letterSpacing: "1.2px",
                      marginBottom: "2px",
                    }}
                  >
                    {rule.title}
                  </h3>
                  <p
                    className="font-[var(--font-poppins)]"
                    style={{
                      color: "rgba(255,255,255,0.9)",
                      fontSize: "clamp(14px, 2.5vw, 16px)",
                      lineHeight: "1.4",
                    }}
                  >
                    {rule.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: The Racer's Journey ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "40px",
              textShadow: glowShadow,
            }}
          >
            The Racer&apos;s Journey
          </h2>

          {/* Journey step cards */}
          <div className="flex flex-col sm:flex-row gap-6 justify-center max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "Arrive 30 Minutes Early",
                desc: "Clear lines and verify waivers.",
                borderColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "The Pit Gate",
                desc: "Guest Services \u2014 STOP HERE FIRST. Get your credentials and height check.",
                borderColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Trackside Check-In",
                desc: "1st Floor \u2014 Rent your POV camera and enter the safety briefing.",
                borderColor: "rgb(134,82,255)",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="flex-1 flex flex-col"
                style={{
                  border: `1.78px dashed ${step.borderColor}`,
                  borderRadius: "44px",
                  padding: "16px 12px 32px",
                  textAlign: "center",
                }}
              >
                <div
                  className="font-[var(--font-anton)]"
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    backgroundColor: step.borderColor,
                    color: "white",
                    fontSize: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 16px",
                  }}
                >
                  {step.num}
                </div>
                <h3
                  className="font-[var(--font-anton)] uppercase mb-2"
                  style={{
                    color: "rgb(255,255,255)",
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  {step.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.8)",
                    fontSize: "16px",
                    lineHeight: "1.5",
                  }}
                >
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Bottom CTA with background image ── */}
      <section
        className="relative overflow-hidden"
        style={{ minHeight: "656px" }}
      >
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/bottom-cta-bg.webp"
          alt="Racing"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/80 via-[#000418]/60 to-[#000418]/40" />
        <div className="relative z-10 flex flex-col items-center justify-center text-center h-full px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "32px",
              textShadow: glowShadow,
            }}
          >
            Ready to Race?
          </h2>
          <a
            href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
            target="_blank"
            rel="noopener noreferrer"
            onClick={trackBookingClick}
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{
              backgroundColor: "rgb(228,28,29)",
              borderRadius: "555px",
              padding: "20px 48px",
              fontSize: "16px",
            }}
          >
            BOOK NOW
          </a>
        </div>
      </section>
    </>
  );
}
