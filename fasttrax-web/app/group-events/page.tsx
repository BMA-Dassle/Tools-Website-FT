"use client";

import { useState } from "react";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

const eventFormats = [
  {
    title: "Full Facility Buyouts",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    desc: (
      <>
        <strong>The Vibe:</strong> Complete privacy. The building is yours.
        <br />
        <strong>The Perks:</strong> Exclusive track access, branding
        opportunities throughout the facility.
      </>
    ),
  },
  {
    title: "Exclusive Racing Heats",
    color: "rgb(0,74,173)",
    borderColor: "rgb(0,74,173)",
    desc: (
      <>
        <strong>The Vibe:</strong> Reserved grid spots for your group.
        <br />
        <strong>The Perks:</strong> Unlike standard public racing,{" "}
        <strong>Exclusive Heats</strong> ensure your group only races against
        each other. No outside racers will be added to your heat. Includes the
        FastTrax License.
        <br />
        <strong>Availability:</strong> Primary bookings hosted{" "}
        <strong>Monday through Thursday</strong>.
      </>
    ),
  },
];

const vipAmenities = [
  {
    title: "The In-Field (VIP Area)",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    desc: "Get closer to the metal. This exclusive VIP zone puts your group right in the heart of the racing circuit. Perfect for high-impact social gatherings where you want to feel the breeze and hear the torque of the karts as they fly by.",
  },
  {
    title: "VIP Viewing Areas",
    color: "rgb(134,82,255)",
    borderColor: "rgba(134,82,255,0.59)",
    desc: "Watch the hairpins and high-speed straights from our exclusive elevated vantage points. Perfect for spectators to cheer on their team with a drink in hand while tracking live stats on our massive displays.",
  },
  {
    title: "Nemo\u2019s Brickyard Bistro",
    color: "rgb(0,74,173)",
    borderColor: "rgb(0,74,173)",
    desc: "High-end social space overlooking the Red and Blue tracks. Ideal for \u2018home base\u2019 during a rotation-style event.",
  },
  {
    title: "The Boardroom",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    desc: "Professional, climate-controlled meeting space with full A/V integration for presentations before the green flag drops.",
  },
];

export default function GroupEventsPage() {
  const [showForm, setShowForm] = useState(false);
  return (
    <>
      <SubpageHero
        title="Group Events & Team Building"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/group-events-hero.webp"
      />

      {/* ── Section: Host an Unforgettable Event ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Host an Unforgettable Event at the Destination.
          </h2>
          <p
            className="font-[var(--font-poppins)] mb-8"
            style={{
              color: "rgba(255,255,255,0.898)",
              fontSize: "17px",
              lineHeight: "1.6",
              maxWidth: "700px",
            }}
          >
            From executive buyouts to high-octane team building. Southwest
            Florida&apos;s premier event campus offers 113,000 sq. ft. of
            adrenaline, elite catering, and VIP amenities for groups of 14 to
            1,000+
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
            style={{
              backgroundColor: "rgb(0,74,173)",
              borderRadius: "555px",
              padding: "16px 24px",
              fontSize: "14px",
            }}
          >
            REQUEST AN EVENT QUOTE
          </button>
        </div>
      </section>

      {/* ── Section: Event Formats ── */}
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
          className="relative z-10 max-w-7xl mx-auto px-8"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: "rgba(255,30,0,0.4) 0px 0px 30px",
            }}
          >
            Event Formats: Elite Access
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {eventFormats.map((e) => (
              <div
                key={e.title}
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${e.borderColor}`,
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3
                  className="font-[var(--font-anton)] uppercase mb-3"
                  style={{
                    color: e.color,
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  {e.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.8)",
                    fontSize: "16px",
                    lineHeight: "1.5",
                  }}
                >
                  {e.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: VIP Amenities ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: glowShadow,
            }}
          >
            VIP Amenities: The In-Field &amp; Viewing Zones
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {vipAmenities.map((a) => (
              <div
                key={a.title}
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${a.borderColor}`,
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3
                  className="font-[var(--font-anton)] uppercase mb-3"
                  style={{
                    color: a.color,
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  {a.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.8)",
                    fontSize: "16px",
                    lineHeight: "1.5",
                  }}
                >
                  {a.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Birthday Party Notice ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto text-center">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Birthday Party Notice
          </h2>
          <h3
            className="font-[var(--font-anton)] italic uppercase"
            style={{
              color: "rgb(134,82,255)",
              fontSize: "32px",
              lineHeight: "36px",
              letterSpacing: "2px",
              marginBottom: "24px",
            }}
          >
            Planning a Birthday?
          </h3>
          <p
            className="font-[var(--font-poppins)] mx-auto mb-8"
            style={{
              color: "rgba(255,255,255,0.898)",
              fontSize: "17px",
              lineHeight: "1.6",
              maxWidth: "700px",
            }}
          >
            Please note that Birthday Party Packages are not yet available at
            the FastTrax facility. However, our sister facility next door,
            HeadPinz Fort Myers, is the region&apos;s #1 destination for
            kids&apos; parties! Enjoy dedicated hosts, bowling, and a massive
            arcade just steps away.
          </p>
          <a
            href="/pricing"
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{
              backgroundColor: "rgb(134,82,255)",
              borderRadius: "555px",
              padding: "16px 24px",
              fontSize: "14px",
            }}
          >
            VIEW DESTINATION COMBOS
          </a>
        </div>
      </section>

      {/* ── Section: Junior Racing ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Junior Racing (Online Booking)
          </h2>
          <p
            className="font-[var(--font-poppins)] mb-8"
            style={{
              color: "rgba(255,255,255,0.898)",
              fontSize: "17px",
              lineHeight: "1.6",
              maxWidth: "700px",
            }}
          >
            Got a group of young speedsters? Junior Racing heats are available
            for online booking! Perfect for small groups of friends looking to
            hit the track together.
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
            BOOK JUNIOR HEATS NOW
          </a>
        </div>
      </section>

      {/* ── Quote Request Section ── */}
      <section
        id="quote-form"
        className="relative overflow-hidden"
      >
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/group-events-bg.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/80" />
        <div
          className="relative z-10 max-w-3xl mx-auto px-8 text-center"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 60px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: "rgba(28,0,255,0.4) 0px 0px 30px",
            }}
          >
            Start Your Quote
          </h2>
          <p
            className="mx-auto mb-10 font-[var(--font-poppins)]"
            style={{
              color: "rgba(255,255,255,0.898)",
              fontSize: "17px",
              lineHeight: "1.6",
              maxWidth: "600px",
            }}
          >
            Tell us about your event and our team will craft a custom package.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
            style={{
              backgroundColor: "rgb(228,28,29)",
              borderRadius: "555px",
              padding: "16px 24px",
              fontSize: "14px",
            }}
          >
            REQUEST AN EVENT QUOTE
          </button>
        </div>
      </section>

      {/* Cognito Form Modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,4,24,0.85)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div
            className="relative w-full max-w-3xl rounded-xl overflow-hidden"
            style={{
              backgroundColor: "#0a1128",
              border: "1.78px solid rgba(228,28,29,0.4)",
              height: "90vh",
            }}
          >
            <button
              onClick={() => setShowForm(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <iframe
              src="https://www.cognitoforms.com/f/u3qiZTtd8UeGo_mV4yHewA/21"
              className="w-full h-full"
              style={{ border: "none" }}
              title="Event Quote Request Form"
            />
          </div>
        </div>
      )}
    </>
  );
}
