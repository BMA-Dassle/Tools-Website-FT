"use client";

import { useState } from "react";
import Image from "next/image";

/* -- HeadPinz brand tokens -------------------------------- */

const coral = "#fd5b56";
const gold = "#FFD700";
const cyan = "#00E2E5";
const bg = "#0a1628";

/* -- Data ------------------------------------------------- */

const packages = [
  {
    name: "Bronze Birthday",
    badge: null,
    accent: coral,
    borderColor: "rgba(253,91,86,0.35)",
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
    accent: gold,
    borderColor: "rgba(255,215,0,0.4)",
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
    accent: cyan,
    borderColor: "rgba(0,226,229,0.35)",
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

const valueProps = [
  {
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.745 3.745 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
      </svg>
    ),
    title: "We Handle Everything",
    desc: "Your dedicated party ambassador takes care of setup, food, activities, and cleanup. You just show up and celebrate.",
    accent: coral,
  },
  {
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
      </svg>
    ),
    title: "Activities They'll Love",
    desc: "Bowling, laser tag, gel blasters, and 40+ arcade games — enough action to keep every kid entertained for hours.",
    accent: gold,
  },
  {
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
      </svg>
    ),
    title: "Memories That Last",
    desc: "LED glow bowling, cosmic lighting, big-screen video walls, and music create an atmosphere they'll never forget.",
    accent: cyan,
  },
];

const foodOptions = [
  {
    name: "Pizza Party",
    desc: "Cheese or pepperoni pizza",
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v-1.5m0 1.5c-1.355 0-2.697.056-4.024.166C6.845 8.51 6 9.473 6 10.608v2.513m6-4.871c1.355 0 2.697.056 4.024.166C17.155 8.51 18 9.473 18 10.608v2.513M15 8.25v-1.5m-6 1.5v-1.5m12 9.75-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 16.5m18-4.5-1.5.75a3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0 3.354 3.354 0 0 0-3 0 3.354 3.354 0 0 1-3 0L3 12" />
      </svg>
    ),
  },
  {
    name: "Hot Dogs & Fries",
    desc: "Classic hot dogs with crispy fries",
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
      </svg>
    ),
  },
  {
    name: "Chicken Tenders",
    desc: "Crispy tenders with fries",
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
      </svg>
    ),
  },
];

const addOns = [
  {
    name: "Extra Laser Tag",
    desc: "Additional session per guest",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
      </svg>
    ),
  },
  {
    name: "Arcade Boost",
    desc: "Extra 100 tokens per guest",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
  },
  {
    name: "Party Favor Bags",
    desc: "Take-home goody bags",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
      </svg>
    ),
  },
  {
    name: "Extra Time",
    desc: "Add 30 min to your party",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
  },
];

const includedItems = [
  "Party plates, tablecloths, napkins, cups & utensils",
  "Dedicated birthday party ambassador",
  "Large video screens over lanes with music",
  "LED glow lighting atmosphere",
  "Food + unlimited soda for every guest",
  "Bowling shoes and balls included",
];

const galleryImages = [
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-family-bowling.jpg", alt: "Family bowling birthday party" },
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-entertainment.webp", alt: "HeadPinz entertainment" },
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-girl-bowling.jpg", alt: "Birthday girl with bowling ball" },
  { src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-action.webp", alt: "HeadPinz action" },
];

const faqs = [
  { q: "What ages are birthday parties for?", a: "Our birthday party packages are designed for guests ages 17 and under." },
  { q: "How many guests per lane?", a: "Each lane accommodates up to 6 guests. You can reserve 2, 4, or 6 lanes depending on your party size." },
  { q: "Can adults attend?", a: "Absolutely! Adults are welcome to attend as guests. If you\u2019re looking for an adult birthday party, check out our group event packages." },
  { q: "What food is included?", a: "Every package includes one food choice for all guests: cheese or pepperoni pizza + soda, hot dog + fries + soda, or chicken tenders + fries + soda." },
  { q: "Can I add more activities?", a: "Yes! Ask our events team about add-ons like extra laser tag sessions, additional game zone tokens, party favor bags, and more." },
  { q: "How far in advance should I book?", a: "We recommend booking at least 2 weeks in advance. Popular dates and weekends fill up quickly, so the earlier the better!" },
  { q: "Can I bring my own cake?", a: "Yes! You\u2019re welcome to bring your own birthday cake or cupcakes. We\u2019ll provide the plates and utensils." },
];

/* -- Component -------------------------------------------- */

export default function HeadPinzBirthdaysPage() {
  const [showForm, setShowForm] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      {/* ====== 1. HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "100vh" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-girl-bowling.jpg"
          alt="HeadPinz birthday party"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "100vh" }}
        >
          <span
            className="inline-block font-[var(--font-hp-body)] text-[10px] uppercase tracking-[0.3em] px-4 py-1.5 rounded-full mb-6 font-bold"
            style={{ backgroundColor: `${coral}20`, color: coral, border: `1px solid ${coral}40` }}
          >
            Ages 17 &amp; Under
          </span>

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
            All the Fun.<br />None of the Stress.
          </h1>
          <p
            className="font-[var(--font-hp-body)] text-white/70 max-w-xl mx-auto"
            style={{ fontSize: "clamp(14px, 2.5vw, 20px)", lineHeight: "1.5", marginBottom: "32px" }}
          >
            We handle everything &mdash; you enjoy the party
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 cursor-pointer"
            style={{ boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
          >
            Start Planning
          </button>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== 2. STATS BAR ====== */}
      <section style={{ padding: "clamp(40px, 6vw, 60px) clamp(16px, 4vw, 32px)" }}>
        <div
          className="max-w-5xl mx-auto flex flex-wrap justify-center gap-x-8 gap-y-4 rounded-lg px-6 py-5"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(253,91,86,0.25)" }}
        >
          {[
            { label: "24 Bowling Lanes", color: coral },
            { label: "Laser Tag Arena", color: "#E41C1D" },
            { label: "Gel Blaster Arena", color: "#9b51e0" },
            { label: "40+ Arcade Games", color: cyan },
            { label: "Full Kitchen", color: gold },
          ].map((stat, i) => (
            <span key={stat.label} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: stat.color }} />
              <span className="font-[var(--font-hp-body)] text-white/80 text-sm font-bold uppercase tracking-wider whitespace-nowrap">
                {stat.label}
              </span>
              {i < 4 && <span className="text-white/20 ml-2 hidden sm:inline">&bull;</span>}
            </span>
          ))}
        </div>
      </section>

      {/* ====== 3. VALUE PROPS ====== */}
      <section style={{ padding: "clamp(20px, 4vw, 40px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
          {valueProps.map((vp) => (
            <div
              key={vp.title}
              className="rounded-lg p-6 text-center transition-all hover:scale-[1.01]"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${vp.accent}30` }}
            >
              <div className="flex justify-center mb-4" style={{ color: vp.accent }}>
                {vp.icon}
              </div>
              <h3
                className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-2"
                style={{ textShadow: `0 0 20px ${vp.accent}30` }}
              >
                {vp.title}
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                {vp.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ====== 4. PARTY PACKAGES ====== */}
      <section className="relative overflow-hidden">
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover"
          poster="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
        >
          <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-arcade.mp4" type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-[#0a1628]/92" />
        <div
          className="relative z-10 max-w-7xl mx-auto"
          style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}
        >
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{
                fontSize: "clamp(28px, 6vw, 52px)",
                letterSpacing: "3px",
                marginBottom: "12px",
                textShadow: "0 0 30px rgba(255,215,0,0.25)",
              }}
            >
              Party Packages
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${coral}, ${gold})` }} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {packages.map((pkg) => (
              <div
                key={pkg.name}
                className={`relative flex flex-col rounded-lg overflow-hidden transition-all duration-300 hover:scale-[1.01] ${pkg.featured ? "lg:-mt-4 lg:mb-4" : ""}`}
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${pkg.borderColor}`,
                  boxShadow: pkg.featured ? `0 0 30px ${pkg.accent}15` : "none",
                }}
              >
                {/* Badge */}
                {pkg.badge && (
                  <div
                    className="text-center font-[var(--font-hp-body)] font-bold text-xs uppercase tracking-widest py-2.5"
                    style={{ backgroundColor: pkg.accent, color: bg }}
                  >
                    {pkg.badge}
                  </div>
                )}

                <div className="p-6 flex flex-col flex-1">
                  <h3
                    className="font-[var(--font-hp-display)] uppercase text-white tracking-wider mb-1"
                    style={{ fontSize: "clamp(18px, 3vw, 24px)", textShadow: `0 0 20px ${pkg.accent}30` }}
                  >
                    {pkg.name}
                  </h3>
                  <p className="font-[var(--font-hp-body)] text-white/50 text-xs uppercase tracking-wider mb-5">
                    Starting at {pkg.startingAt} ({pkg.laneLabel})
                  </p>

                  {/* Included list */}
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {pkg.includes.map((item) => (
                      <li key={item} className="flex items-start gap-2.5">
                        <svg className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: pkg.accent }} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        <span className="font-[var(--font-hp-body)] text-white/70 text-sm leading-snug">{item}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Pricing table */}
                  <div className="rounded-lg overflow-hidden mb-5" style={{ border: `1px solid ${pkg.accent}20` }}>
                    {pkg.pricing.map((row, i) => (
                      <div
                        key={row.lanes}
                        className="flex items-center justify-between px-4 py-2.5"
                        style={{ backgroundColor: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}
                      >
                        <span className="font-[var(--font-hp-body)] text-white/60 text-sm">{row.lanes}</span>
                        <span className="font-[var(--font-hp-display)] text-lg" style={{ color: pkg.accent }}>{row.price}</span>
                      </div>
                    ))}
                  </div>
                  <p className="font-[var(--font-hp-body)] text-white/40 text-xs text-center mb-5">{pkg.guestsNote}</p>

                  <button
                    onClick={() => setShowForm(true)}
                    className="w-full inline-flex items-center justify-center font-[var(--font-hp-body)] font-bold uppercase tracking-wider transition-all hover:scale-105 cursor-pointer rounded-full text-sm py-3.5"
                    style={{
                      backgroundColor: pkg.accent,
                      color: pkg.featured ? bg : "#fff",
                      boxShadow: `0 0 16px ${pkg.accent}30`,
                    }}
                  >
                    Book This Package
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 5. WHAT'S INCLUDED ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: "0 0 30px rgba(0,226,229,0.25)" }}
            >
              Every Package Includes
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${cyan}, ${coral})` }} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {includedItems.map((item) => (
              <div
                key={item}
                className="rounded-lg p-4 flex items-center gap-3"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(0,226,229,0.2)" }}
              >
                <svg className="w-5 h-5 flex-shrink-0" style={{ color: cyan }} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span className="font-[var(--font-hp-body)] text-white/70 text-sm">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 6. FOOD MENU PREVIEW ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(24px, 4vw, 40px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: `0 0 30px ${gold}25` }}
            >
              Fuel the Fun
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              Pick one menu option for your whole party &mdash; all served with unlimited soda
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {foodOptions.map((food) => (
              <div
                key={food.name}
                className="rounded-lg p-6 text-center transition-all hover:scale-[1.01]"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}25` }}
              >
                <div className="flex justify-center mb-3" style={{ color: gold }}>{food.icon}</div>
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-1">
                  {food.name}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/50 text-sm">{food.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 7. ADD-ONS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(24px, 4vw, 40px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: `0 0 30px rgba(155,81,224,0.25)` }}
            >
              Make It Even Bigger
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              Ask our events team about these popular upgrades
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {addOns.map((addon) => (
              <div
                key={addon.name}
                className="rounded-lg p-5 text-center transition-all hover:scale-[1.02]"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(155,81,224,0.2)" }}
              >
                <div className="flex justify-center mb-2" style={{ color: "#9b51e0" }}>{addon.icon}</div>
                <h4 className="font-[var(--font-hp-body)] text-white font-bold text-sm mb-1">{addon.name}</h4>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs">{addon.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 8. GALLERY ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(40px, 6vw, 60px)" }}>
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

      {/* ====== 9. HOW IT WORKS ====== */}
      <section style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: `0 0 30px ${coral}25` }}
            >
              How It Works
            </h2>
            <div className="mx-auto h-1 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${coral}, ${gold})` }} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { step: "1", title: "Pick a Package", desc: "Choose Bronze, Silver, or VIP based on your group size and budget" },
              { step: "2", title: "Choose Your Date", desc: "Fill out our quick form and our events team will confirm availability" },
              { step: "3", title: "Show Up & Party!", desc: "We handle setup, food, activities, and cleanup. You just celebrate!" },
            ].map((s) => (
              <div
                key={s.step}
                className="rounded-lg p-6 text-center"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}25` }}
              >
                <span
                  className="inline-flex items-center justify-center w-12 h-12 rounded-full font-[var(--font-hp-display)] text-xl mb-4"
                  style={{ backgroundColor: `${coral}20`, color: coral, border: `1.78px solid ${coral}40` }}
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

      {/* ====== 10. FAQ ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-center" style={{ marginBottom: "clamp(32px, 6vw, 48px)" }}>
            <h2
              className="font-[var(--font-hp-display)] uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 52px)", letterSpacing: "3px", marginBottom: "12px", textShadow: `0 0 30px ${coral}25` }}
            >
              Questions?
            </h2>
          </div>
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <div
                key={i}
                className="rounded-lg overflow-hidden"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(253,91,86,0.2)" }}
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left cursor-pointer"
                >
                  <span className="font-[var(--font-hp-body)] font-bold text-white text-sm pr-4">{f.q}</span>
                  <svg
                    className="w-5 h-5 flex-shrink-0 transition-transform"
                    style={{ color: coral, transform: openFaq === i ? "rotate(180deg)" : "rotate(0deg)" }}
                    fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div
                  className="overflow-hidden transition-all duration-300"
                  style={{ maxHeight: openFaq === i ? "300px" : "0px", opacity: openFaq === i ? 1 : 0 }}
                >
                  <div className="px-5 pb-4">
                    <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">{f.a}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 11. FINAL CTA ====== */}
      <section className="relative overflow-hidden" id="plan">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-family-bowling.jpg"
          alt="HeadPinz birthday celebration"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-black/70 to-black/50" />
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#123075] via-white/60 to-[#fd5b56]" />

        <div
          className="relative z-10 max-w-3xl mx-auto text-center"
          style={{ padding: "clamp(80px, 12vw, 140px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(28px, 7vw, 56px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "16px",
              textShadow: `0 0 30px ${coral}40`,
            }}
          >
            Ready to Plan the Best Birthday Ever?
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/70 mx-auto mb-8"
            style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "500px", lineHeight: "1.6" }}
          >
            Fill out our quick form and our events team will help you build the perfect party.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer rounded-full"
              style={{ backgroundColor: coral, padding: "16px 28px", fontSize: "15px", boxShadow: `0 0 20px ${coral}40` }}
            >
              Start Planning
            </button>
            <a
              href="tel:+12394553755"
              className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 rounded-full border border-white/20 hover:border-white/40"
              style={{ padding: "16px 28px", fontSize: "15px", backgroundColor: "rgba(255,255,255,0.1)" }}
            >
              Call (239) 455-3755
            </a>
          </div>
        </div>
      </section>

      {/* ====== COGNITO FORM MODAL ====== */}
      {showForm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(10,22,40,0.9)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div
            className="relative w-full max-w-3xl rounded-lg overflow-hidden"
            style={{ backgroundColor: bg, border: `1.78px dashed ${coral}40`, height: "90vh" }}
          >
            <button
              onClick={() => setShowForm(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <iframe
              src="https://www.cognitoforms.com/f/u3qiZTtd8UeGo_mV4yHewA/21"
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
