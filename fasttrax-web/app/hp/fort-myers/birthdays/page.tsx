"use client";

import { useState } from "react";
import Image from "next/image";

/* -- HeadPinz brand tokens -------------------------------- */

const coral = "#fd5b56";
const royalBlue = "#123075";
const bg = "#0a1628";

/* -- Data ------------------------------------------------- */

const packages = [
  {
    name: "Bronze Birthday",
    badge: null,
    accent: "rgba(255,255,255,0.15)",
    accentSolid: "#ffffff",
    startingAt: "$349",
    laneLabel: "2 lanes",
    featured: false,
    includes: [
      "2 hours party time + 1 hour bowling",
      "100-token game zone card per guest",
    ],
    pricing: [
      { lanes: "2 Lanes", price: "$349" },
      { lanes: "4 Lanes", price: "$698" },
      { lanes: "6 Lanes", price: "$1,047" },
    ],
    guestsNote: "Up to 6 guests per lane",
  },
  {
    name: "VIP Birthday",
    badge: "MOST POPULAR",
    accent: "rgba(253,91,86,0.15)",
    accentSolid: coral,
    startingAt: "$649",
    laneLabel: "2 lanes",
    featured: true,
    includes: [
      "3 hours party time + 1.5 hours bowling",
      "NeoVerse LED video screen in VIP section",
      "Two gel blaster sessions per guest",
      "200-token game zone card per guest",
    ],
    pricing: [
      { lanes: "2 Lanes", price: "$649" },
      { lanes: "4 Lanes", price: "$1,298" },
      { lanes: "6 Lanes", price: "$1,949" },
    ],
    guestsNote: "Up to 6 guests per lane",
  },
  {
    name: "Silver Birthday",
    badge: null,
    accent: "rgba(18,48,117,0.15)",
    accentSolid: royalBlue,
    startingAt: "$429",
    laneLabel: "2 lanes",
    featured: false,
    includes: [
      "2 hours party time + 1 hour bowling",
      "One gel blaster session per guest",
      "100-token game zone card per guest",
    ],
    pricing: [
      { lanes: "2 Lanes", price: "$429" },
      { lanes: "4 Lanes", price: "$858" },
      { lanes: "6 Lanes", price: "$1,287" },
    ],
    guestsNote: "Up to 6 guests per lane",
  },
];

const includedItems = [
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714a2.25 2.25 0 0 0 .659 1.591L19 14.5m-4.75-11.396c.251.023.501.05.75.082M12 21a8.966 8.966 0 0 0 5.982-2.275M12 21a8.966 8.966 0 0 1-5.982-2.275M15.75 3.186a24.394 24.394 0 0 1 2.364.402M6.886 3.588a24.27 24.27 0 0 1 2.364-.402" />
      </svg>
    ),
    label: "Party plates, tablecloths, napkins, cups & utensils",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
    label: "Dedicated birthday party ambassador",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
      </svg>
    ),
    label: "Large video screens over lanes with music",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
      </svg>
    ),
    label: "LED glow lighting atmosphere",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.871c1.355 0 2.697.056 4.024.166C17.155 8.51 18 9.473 18 10.608v2.513M15 8.25v-1.5m-6 1.5v-1.5m12 9.75-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 16.5m18-4.5-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 12" />
      </svg>
    ),
    label: "Food choice (one for all guests): Cheese or pepperoni pizza + soda, Hot dog + fries + soda, or Chicken tenders + fries + soda",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
      </svg>
    ),
    label: "Bowling shoes and balls",
  },
];

const galleryImages = [
  { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_1.webp", alt: "HeadPinz bowling lanes" },
  { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp", alt: "HeadPinz entertainment" },
  { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_4.webp", alt: "HeadPinz arcade" },
  { src: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_6.webp", alt: "HeadPinz action" },
];

const faqs = [
  {
    q: "What ages are birthday parties for?",
    a: "Our birthday party packages are designed for guests ages 17 and under.",
  },
  {
    q: "How many guests per lane?",
    a: "Each lane accommodates up to 6 guests. You can reserve 2, 4, or 6 lanes depending on your party size.",
  },
  {
    q: "Can adults attend?",
    a: "Absolutely! Adults are welcome to attend as guests. If you\u2019re looking for an adult birthday party, check out our group event packages for a custom experience.",
  },
  {
    q: "What food is included?",
    a: "Every package includes one food choice for all guests: cheese or pepperoni pizza + soda, hot dog + fries + soda, or chicken tenders + fries + soda.",
  },
  {
    q: "Can I add more activities?",
    a: "Yes! Ask our events team about add-ons like extra laser tag sessions, additional game zone tokens, and more to make the party even bigger.",
  },
  {
    q: "How far in advance should I book?",
    a: "We recommend booking at least 2 weeks in advance. Popular dates and weekends fill up quickly, so the earlier the better!",
  },
];

/* -- Component -------------------------------------------- */

export default function HeadPinzBirthdaysPage() {
  const [showForm, setShowForm] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      {/* ====== 1. HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 80vh, 800px)" }}>
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_4.webp"
          alt="HeadPinz birthday party"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "clamp(500px, 80vh, 800px)" }}
        >
          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "16px",
            }}
          >
            Birthday Parties
          </h1>
          <p
            className="font-[var(--font-hp-body)] text-white/70 max-w-xl mx-auto"
            style={{ fontSize: "clamp(14px, 2.5vw, 20px)", lineHeight: "1.5", marginBottom: "32px" }}
          >
            Make Their Special Day Unforgettable
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 shadow-[0_0_20px_rgba(253,91,86,0.3)] hover:shadow-[0_0_30px_rgba(253,91,86,0.5)] cursor-pointer"
          >
            Start Planning
          </button>
        </div>
      </section>

      {/* ====== 2. INTRO ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "16px",
            }}
          >
            The Ultimate Birthday Experience
          </h2>
          <div className="mx-auto h-1 w-24 rounded-full mb-6" style={{ background: "linear-gradient(90deg, #fd5b56, #123075)" }} />
          <p
            className="font-[var(--font-hp-body)] text-white/80 mx-auto mb-8"
            style={{ fontSize: "clamp(15px, 2vw, 18px)", lineHeight: "1.6", maxWidth: "640px" }}
          >
            LED glow bowling, laser tag, gel blasters, arcade, and more &mdash; all under
            one roof. Your dedicated party ambassador handles everything so you can enjoy the
            celebration.
          </p>

          {/* Ages badge */}
          <div
            className="inline-flex items-center rounded-full border border-[#123075]/40 bg-white/[0.05] px-5 py-2.5 mb-8"
          >
            <svg className="w-5 h-5 mr-2" style={{ color: coral }} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.871c1.355 0 2.697.056 4.024.166C17.155 8.51 18 9.473 18 10.608v2.513M15 8.25v-1.5m-6 1.5v-1.5m12 9.75-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 16.5m18-4.5-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 12" />
            </svg>
            <span className="font-[var(--font-hp-body)] font-bold text-white text-sm uppercase tracking-wider">
              Ages 17 and under
            </span>
          </div>

          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
              style={{ backgroundColor: coral, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              Start Planning
            </button>
            <a
              href="tel:+12393022155"
              className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: royalBlue, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              Call (239) 302-2155
            </a>
          </div>
        </div>
      </section>

      {/* ====== 3. PARTY PACKAGES ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a1628] via-[#0f1e38] to-[#0a1628]" />
        <div
          className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: "rgba(253,91,86,0.4) 0px 0px 30px",
            }}
          >
            Party Packages
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {packages.map((pkg) => (
              <div
                key={pkg.name}
                className="relative flex flex-col rounded-2xl border overflow-hidden transition-all duration-300 hover:scale-[1.01]"
                style={{
                  backgroundColor: "rgba(10,22,40,0.6)",
                  borderColor: pkg.featured ? `${coral}60` : "rgba(18,48,117,0.3)",
                  boxShadow: pkg.featured ? `0 0 30px rgba(253,91,86,0.15)` : "none",
                }}
              >
                {/* Badge */}
                {pkg.badge && (
                  <div
                    className="text-center font-[var(--font-hp-body)] font-bold text-xs uppercase tracking-widest text-white py-2"
                    style={{ backgroundColor: coral }}
                  >
                    {pkg.badge}
                  </div>
                )}

                <div className="p-6 flex flex-col flex-1">
                  {/* Name + price */}
                  <h3
                    className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-1"
                    style={{ fontSize: "clamp(20px, 3vw, 26px)", letterSpacing: "0.5px" }}
                  >
                    {pkg.name}
                  </h3>
                  <p className="font-[var(--font-hp-body)] text-white/50 text-xs uppercase tracking-wider mb-4">
                    Starting at {pkg.startingAt} ({pkg.laneLabel})
                  </p>

                  {/* Included list */}
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {pkg.includes.map((item) => (
                      <li key={item} className="flex items-start gap-2.5">
                        <svg
                          className="w-4 h-4 flex-shrink-0 mt-0.5"
                          style={{ color: pkg.accentSolid === "#ffffff" ? coral : pkg.accentSolid }}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        <span className="font-[var(--font-hp-body)] text-white/70 text-sm leading-snug">
                          {item}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* Pricing table */}
                  <div className="rounded-xl overflow-hidden border border-white/10 mb-5">
                    {pkg.pricing.map((row, i) => (
                      <div
                        key={row.lanes}
                        className="flex items-center justify-between px-4 py-2.5"
                        style={{
                          backgroundColor: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)",
                        }}
                      >
                        <span className="font-[var(--font-hp-body)] text-white/60 text-sm">
                          {row.lanes}
                        </span>
                        <span
                          className="font-[var(--font-hp-hero)] font-black text-lg"
                          style={{ color: pkg.accentSolid === "#ffffff" ? coral : pkg.accentSolid }}
                        >
                          {row.price}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="font-[var(--font-hp-body)] text-white/40 text-xs text-center mb-5">
                    {pkg.guestsNote}
                  </p>

                  {/* CTA */}
                  <button
                    onClick={() => setShowForm(true)}
                    className="w-full inline-flex items-center justify-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer rounded-full"
                    style={{
                      backgroundColor: pkg.featured ? coral : royalBlue,
                      padding: "14px 20px",
                      fontSize: "14px",
                    }}
                  >
                    Start Planning
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 4. WHAT'S INCLUDED IN EVERY PACKAGE ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: "rgba(18,48,117,0.5) 0px 0px 30px",
            }}
          >
            Included in Every Package
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {includedItems.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] p-5 flex items-start gap-4"
              >
                <div className="flex-shrink-0" style={{ color: coral }}>
                  {item.icon}
                </div>
                <p className="font-[var(--font-hp-body)] text-white/70 text-sm leading-relaxed">
                  {item.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 5. GALLERY ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(40px, 6vw, 60px)" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {galleryImages.map((img) => (
            <div key={img.src} className="relative overflow-hidden rounded-lg" style={{ aspectRatio: "4/3" }}>
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
      </section>

      {/* ====== 6. FAQ ACCORDION ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: "rgba(253,91,86,0.4) 0px 0px 30px",
            }}
          >
            Frequently Asked Questions
          </h2>
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <div
                key={i}
                className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] overflow-hidden"
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left cursor-pointer"
                >
                  <span className="font-[var(--font-hp-body)] font-bold text-white text-sm pr-4">
                    {f.q}
                  </span>
                  <svg
                    className="w-5 h-5 flex-shrink-0 transition-transform"
                    style={{
                      color: coral,
                      transform: openFaq === i ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div
                  className="overflow-hidden transition-all duration-300"
                  style={{
                    maxHeight: openFaq === i ? "300px" : "0px",
                    opacity: openFaq === i ? 1 : 0,
                  }}
                >
                  <div className="px-5 pb-4">
                    <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                      {f.a}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 7. START PLANNING CTA ====== */}
      <section className="relative overflow-hidden" id="plan">
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_4.webp"
          alt="HeadPinz birthday celebration"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-black/60 to-black/40" />
        <div
          className="relative z-10 max-w-3xl mx-auto px-6 lg:px-8 text-center"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "16px",
              textShadow: "rgba(18,48,117,0.5) 0px 0px 30px",
            }}
          >
            Ready to Plan the Best Birthday Ever?
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/70 mx-auto mb-10"
            style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "500px", lineHeight: "1.6" }}
          >
            Fill out our quick form and our events team will help you build the perfect party.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer hover:shadow-[0_0_30px_rgba(253,91,86,0.4)]"
            style={{ backgroundColor: coral, borderRadius: "555px", padding: "16px 28px", fontSize: "15px" }}
          >
            Start Planning
          </button>
          <p className="font-[var(--font-hp-body)] mt-5 text-white/50 text-sm">
            Prefer to talk? Call us at{" "}
            <a href="tel:+12393022155" className="hover:underline transition-colors" style={{ color: coral }}>
              (239) 302-2155
            </a>
          </p>
        </div>
      </section>

      {/* ====== COGNITO FORM MODAL ====== */}
      {showForm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(10,22,40,0.9)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <div
            className="relative w-full max-w-3xl rounded-2xl overflow-hidden"
            style={{ backgroundColor: bg, border: "2px solid rgba(253,91,86,0.4)", height: "90vh" }}
          >
            <button
              onClick={() => setShowForm(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <iframe
              src="https://www.cognitoforms.com/f/u3qiZTtd8UeGo_mV4yHewA/294"
              className="w-full h-full"
              style={{ border: "none" }}
              title="HeadPinz Birthday Party Request Form"
            />
          </div>
        </div>
      )}
    </>
  );
}
