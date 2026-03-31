"use client";

import { useEffect, useState } from "react";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

const BMI_KEY =
  "aGVhZHBpbnpmdG15ZXJzOjAxYzg3YzM1LTY0YzEtNGRlMC1hYjM3LTI5NDI5Yjk3NTJhZQ==";

function liveSrc(resourceId: string) {
  return `https://modules.bmileisure.com/Livetiming/?key=${encodeURIComponent(BMI_KEY)}&resourceId=${resourceId}`;
}

const bestTimesSrc = `https://modules.bmileisure.com/BestTimes/?key=${encodeURIComponent(BMI_KEY)}`;

export default function LeaderboardsPage() {
  const [isTuesday, setIsTuesday] = useState(false);

  useEffect(() => {
    setIsTuesday(new Date().getDay() === 2);
  }, []);

  return (
    <>
      <SubpageHero
        title="Live Leaderboards & Standings"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-hero.webp"
      />

      {/* ── Section: Intro ── */}
      <section className="bg-[#000418]" style={{ padding: "120px 0" }}>
        <div className="max-w-7xl mx-auto px-8 flex flex-col lg:flex-row gap-10 items-center">
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{
                fontSize: "72px",
                lineHeight: "72px",
                letterSpacing: "3px",
                marginBottom: "16px",
                textShadow: glowShadow,
              }}
            >
              Who&apos;s Leading the Pack?
            </h2>
            <p
              className="mb-8 font-[var(--font-poppins)]"
              style={{
                color: "rgba(255,255,255,0.898)",
                fontSize: "18px",
                lineHeight: "1.6",
                maxWidth: "700px",
              }}
            >
              Real-time performance data straight from the timing line. Track
              every apex and every overtake as it happens.
            </p>
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/"
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
              Book today
            </a>
          </div>
          <div
            className="flex-1 relative rounded-2xl overflow-hidden"
            style={{ minHeight: "400px" }}
          >
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-inline1.webp"
              alt="Racing at FastTrax"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: The Live Timing ── */}
      <section className="bg-[#000418]" style={{ padding: "120px 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "72px",
              lineHeight: "72px",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: "rgba(255,30,0,0.4) 0px 0px 30px",
            }}
          >
            The Live Timing
          </h2>

          <div className="flex flex-col gap-8">
            {/* Live Timing — dynamic based on day */}
            {isTuesday ? (
              /* Tuesday: Mega Track only */
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgba(134,82,255,0.63)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3
                  className="font-[var(--font-anton)] uppercase mb-6"
                  style={{
                    color: "rgb(134,82,255)",
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  Mega Track Tuesday
                </h3>
                <div className="text-center">
                  <h4
                    className="font-[var(--font-anton)] uppercase mb-4"
                    style={{
                      color: "rgb(255,42,42)",
                      fontSize: "24px",
                      letterSpacing: "1.2px",
                    }}
                  >
                    MEGA TRACK LIVE
                  </h4>
                  <iframe
                    src={liveSrc("-1")}
                    className="w-full rounded-lg"
                    style={{ height: "500px", border: "none" }}
                    title="Mega Track Live Timing"
                  />
                </div>
              </div>
            ) : (
              /* Wed–Mon: Blue Track + Red Track */
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgba(228,28,29,0.59)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3
                  className="font-[var(--font-anton)] uppercase mb-6"
                  style={{
                    color: "rgb(228,28,29)",
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  Live Race Timing
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="text-center">
                    <h4
                      className="font-[var(--font-anton)] uppercase mb-4"
                      style={{
                        color: "rgb(255,42,42)",
                        fontSize: "24px",
                        letterSpacing: "1.2px",
                      }}
                    >
                      BLUE TRACK LIVE
                    </h4>
                    <iframe
                      src={liveSrc("11208654")}
                      className="w-full rounded-lg"
                      style={{ height: "500px", border: "none" }}
                      title="Blue Track Live Timing"
                    />
                  </div>
                  <div className="text-center">
                    <h4
                      className="font-[var(--font-anton)] uppercase mb-4"
                      style={{
                        color: "rgb(255,42,42)",
                        fontSize: "24px",
                        letterSpacing: "1.2px",
                      }}
                    >
                      RED TRACK LIVE
                    </h4>
                    <iframe
                      src={liveSrc("11208660")}
                      className="w-full rounded-lg"
                      style={{ height: "500px", border: "none" }}
                      title="Red Track Live Timing"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Hall of Fame — always visible */}
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(134,82,255,0.63)",
                borderRadius: "8px",
                padding: "20px",
              }}
            >
              <p
                className="font-[var(--font-anton)] text-white mb-2"
                style={{ fontSize: "24px" }}
              >
                3
              </p>
              <h3
                className="font-[var(--font-anton)] uppercase mb-6"
                style={{
                  color: "rgb(134,82,255)",
                  fontSize: "24px",
                  letterSpacing: "1.2px",
                }}
              >
                Persistent (All Days)
              </h3>
              <div className="text-center">
                <h4
                  className="font-[var(--font-anton)] uppercase mb-4"
                  style={{
                    color: "rgb(255,42,42)",
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  HALL OF FAME
                </h4>
                <iframe
                  src={bestTimesSrc}
                  className="w-full rounded-lg"
                  style={{ height: "500px", border: "none" }}
                  title="Hall of Fame Best Times"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Performance Journey ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div
          className="relative z-10 max-w-7xl mx-auto"
          style={{ padding: "120px 32px" }}
        >
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "72px",
              lineHeight: "72px",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: "rgba(255,30,0,0.4) 0px 0px 30px",
            }}
          >
            Performance Journey: Beyond the Lap
          </h2>
          <div className="flex flex-col sm:flex-row gap-6 justify-center max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "Personal Stats",
                desc: "Want to see your full history? Log into the FastTrax Racing App to view every heat you\u2019ve ever run, your average g-force, and your personal bests.",
                borderColor: "rgba(228,28,29,0.59)",
                titleColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Daily Top 10",
                desc: "Check the \u2018Daily\u2019 tab to see if you\u2019ve cracked today\u2019s leaderboard. The top times of the day are featured on the big screens at Nemo\u2019s Brickyard Bistro.",
                borderColor: "rgba(0,74,173,0.59)",
                titleColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Unlock Speed Tiers",
                desc: "Top times aren\u2019t just for bragging rights. Consistent, fast, and safe laps are the only way to unlock Intermediate and Pro speeds.",
                borderColor: "rgba(134,82,255,0.63)",
                titleColor: "rgb(134,82,255)",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="flex-1"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${step.borderColor}`,
                  borderRadius: "8px",
                  padding: "20px",
                  textAlign: "center",
                }}
              >
                <p
                  className="font-[var(--font-anton)] text-white mb-2"
                  style={{ fontSize: "24px" }}
                >
                  {step.num}
                </p>
                <h3
                  className="font-[var(--font-anton)] uppercase mb-3"
                  style={{
                    color: step.titleColor,
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

      {/* ── Section: Track Information Alert ── */}
      <section className="bg-[#000418]" style={{ padding: "120px 32px" }}>
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-10 items-center">
          <div
            className="flex-1 relative rounded-2xl overflow-hidden"
            style={{ minHeight: "300px" }}
          >
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-inline2.webp"
              alt="Track leaderboard display"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{
                fontSize: "72px",
                lineHeight: "72px",
                letterSpacing: "3px",
                marginBottom: "32px",
                textShadow: glowShadow,
              }}
            >
              Track Information Alert
            </h2>
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgb(134,82,255)",
                borderRadius: "8px",
                padding: "20px",
              }}
            >
              <h3
                className="font-[var(--font-anton)] uppercase mb-3"
                style={{
                  color: "rgb(134,82,255)",
                  fontSize: "30px",
                  letterSpacing: "1.5px",
                }}
              >
                Tuesday Mega Track
              </h3>
              <p
                className="font-[var(--font-poppins)]"
                style={{
                  color: "rgb(245,236,238)",
                  fontSize: "18px",
                  lineHeight: "1.5",
                }}
              >
                Tuesday Mega Track: Every Tuesday, we combine the Red and Blue
                tracks into one massive multi-level circuit. Standings for
                Tuesdays are recorded on a dedicated Mega Track leaderboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Think you can beat the best? (Bottom CTA) ── */}
      <section className="relative overflow-hidden" style={{ height: "788px" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-cta.webp"
          alt="Racing action"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/40" />
        <div className="relative z-10 flex flex-col items-center justify-center text-center h-full px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "72px",
              lineHeight: "72px",
              letterSpacing: "3px",
              marginBottom: "32px",
              textShadow: glowShadow,
            }}
          >
            Think you can beat the best?
          </h2>
          <div className="flex flex-wrap gap-4 justify-center">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(228,28,29)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              BOOK YOUR HEAT NOW
            </a>
            <a
              href="https://smstim.in/headpinzftmyers"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(0,74,173)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              DOWNLOAD THE APP
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
