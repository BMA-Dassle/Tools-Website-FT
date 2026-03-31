"use client";

import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";
import { useState } from "react";

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

      {/* ── Section: Speed Tiers ── */}
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
            Speed Tiers: The Ladder to Pro 3
          </h2>
          <p
            className="text-center mx-auto"
            style={{
              color: "rgba(255,255,255,0.898)",
              fontSize: "18px",
              fontFamily: "var(--font-poppins)",
              lineHeight: "1.6",
              maxWidth: "700px",
              marginBottom: "48px",
            }}
          >
            Every racer begins in our Starter heat. Once you prove your skill by
            hitting specific lap times, your racer profile is permanently
            upgraded.
          </p>

          {/* Table */}
          <div className="overflow-x-auto rounded-lg">
            <table
              className="w-full max-w-4xl mx-auto"
              style={{ borderCollapse: "collapse" }}
            >
              <thead>
                <tr>
                  {[
                    "Kart Class",
                    "Starter Speed",
                    "Intermediate Goal",
                    "Pro Goal",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left font-[var(--font-poppins)]"
                      style={{
                        fontSize: "18px",
                        fontWeight: 400,
                        color: "rgba(255,255,255,0.96)",
                        backgroundColor: "rgba(228,28,29,0.51)",
                        padding: "16px",
                        borderBottom:
                          "0.89px dashed rgba(187,187,187,0.31)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr
                  style={{
                    borderBottom: "0.89px dashed rgba(187,187,187,0.31)",
                  }}
                >
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Adult Karts (13+ / 59&quot;+)
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Default Entry
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Blue: 41.5s
                    <br />
                    Red: 47s
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Blue: 32.5s
                    <br />
                    Red: 37.25s
                  </td>
                </tr>
                <tr
                  style={{
                    borderBottom: "0.89px dashed rgba(187,187,187,0.31)",
                  }}
                >
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Junior Karts (7-12 / 49&quot;+)
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Default Entry
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Hit 1m 15s in Starter
                  </td>
                  <td
                    className="font-[var(--font-poppins)]"
                    style={{
                      fontSize: "18px",
                      fontWeight: 300,
                      color: "rgb(255,255,255)",
                      padding: "16px",
                    }}
                  >
                    Hit 45s in Intermediate
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/95 via-[#000418]/85 to-[#000418]/60" />
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
                desc: "Multi-level modular steel track.",
                borderColor: "rgb(228,28,29)",
              },
              {
                title: "The Machine (Biz-Karts EcoVolt GT)",
                desc: "100% instant torque, zero emissions.",
                borderColor: "rgb(0,74,173)",
              },
              {
                title: "The Intelligence (BMI Leisure): Smart Crash Detection.",
                desc: "Only karts within 75 feet of a wreck are automatically slowed. If you\u2019re on the other side of the track, you stay at full speed.",
                borderColor: "rgb(134,82,255)",
              },
            ].map((card) => (
              <div
                key={card.title}
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${card.borderColor}`,
                  borderRadius: "8px",
                  padding: "32px 24px",
                  textAlign: "center",
                }}
              >
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
            The Grid Rules (The &ldquo;Must-Knows&rdquo;)
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "The 45-Minute Window",
                desc: "Arrival time for Guest Services (Ground Floor).",
                borderColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Closed-Toe Shoes",
                desc: "Required. No exceptions.",
                borderColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "No Pocket Litter",
                desc: "Lockers provided for phones/keys.",
                borderColor: "rgb(134,82,255)",
              },
              {
                num: "4",
                title: "The Timer Guarantee",
                desc: "Red flags stop the clock. You get every second you paid for.",
                borderColor: "rgb(228,28,29)",
              },
            ].map((rule) => (
              <div
                key={rule.num}
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${rule.borderColor}`,
                  borderRadius: "8px",
                  padding: "32px 20px",
                  textAlign: "center",
                }}
              >
                <div
                  className="font-[var(--font-anton)]"
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    backgroundColor: rule.borderColor,
                    color: "white",
                    fontSize: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 16px",
                  }}
                >
                  {rule.num}
                </div>
                <h3
                  className="font-[var(--font-anton)] uppercase"
                  style={{
                    color: "rgb(255,255,255)",
                    fontSize: "20px",
                    letterSpacing: "1.2px",
                    marginBottom: "8px",
                  }}
                >
                  {rule.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.8)",
                    fontSize: "15px",
                    lineHeight: "1.5",
                  }}
                >
                  {rule.desc}
                </p>
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
            The Racer&apos;s Journey: Arriving to Drive
          </h2>

          {/* Journey step cards */}
          <div className="flex flex-col sm:flex-row gap-6 justify-center max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "Arrive 45 Minutes Early",
                desc: "Clear lines and verify waivers.",
                borderColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "The Pit Gate (Guest Services)",
                desc: "STOP HERE FIRST. Get your credentials and height check.",
                borderColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Trackside Check-In (1st Floor)",
                desc: "Rent your POV camera and enter the safety briefing.",
                borderColor: "rgb(134,82,255)",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="flex-1"
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
              marginBottom: "24px",
              textShadow: glowShadow,
            }}
          >
            THE RACER&apos;S JOURNEY ARRIVE TO DRIVE
          </h2>
          <p
            className="font-[var(--font-poppins)] mb-6"
            style={{
              color: "rgb(255,255,255)",
              fontSize: "18px",
              fontWeight: 700,
              letterSpacing: "0.9px",
              textTransform: "uppercase" as const,
            }}
          >
            [Check/Sign My Waiver]
          </p>
          <a
            href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{
              backgroundColor: "rgb(228,28,29)",
              borderRadius: "555px",
              padding: "16px 24px",
              fontSize: "14px",
            }}
          >
            SECURE YOUR HEAT
          </a>
        </div>
      </section>
    </>
  );
}
