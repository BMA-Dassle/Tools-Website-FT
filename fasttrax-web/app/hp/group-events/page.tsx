"use client";

import { useState } from "react";
import Image from "next/image";

/* ── HeadPinz brand tokens ────────────────────────────── */

const coral = "#fd5b56";
const purple = "#9b51e0";
const blue = "#0693e3";
const bg = "#0a0518";

const glowCoral = "rgba(253,91,86,0.4) 0px 0px 30px";
const glowPurple = "rgba(155,81,224,0.4) 0px 0px 30px";

/* ── Data ─────────────────────────────────────────────── */

const howItWorks = [
  {
    step: 1,
    title: "Choose Your Space",
    color: coral,
    desc: "Private lanes, VIP lounges, the NEXUS arena, or the entire venue \u2014 pick the perfect setup for your group.",
  },
  {
    step: 2,
    title: "Plan Food & Drinks",
    color: purple,
    desc: "Pizza packages, wing platters, and full bar service by Nemo\u2019s. Catering built for groups of any size.",
  },
  {
    step: 3,
    title: "Pick Activities",
    color: blue,
    desc: "Bowling, laser tag, gel blasters, arcade, HyperBowling \u2014 build the ultimate event lineup.",
  },
];

const eventSpaces = [
  {
    title: "Private Bowling Lanes",
    capacity: "Up to 144 Guests (24 Lanes)",
    color: coral,
    img: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp",
    desc: "Reserve a block of lanes for your group with glow-bowl lighting, cosmic effects, and shoe rental included. Up to 6 guests per lane.",
  },
  {
    title: "VIP Pinz Club",
    capacity: "Exclusive Lounge Area",
    color: purple,
    img: "https://headpinz.com/wp-content/uploads/2024/02/neoverse.jpg",
    desc: "Elevated experience with VIP lanes, HyperBowling, NeoVerse immersive walls, and dedicated bar service. Premium atmosphere for corporate events and celebrations.",
  },
  {
    title: "NEXUS Arena",
    capacity: "Up to 34 Per Session",
    color: blue,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    desc: "Two-story laser tag arena and state-of-the-art gel blaster combat. Immersive, high-energy team activities perfect for group competition.",
  },
  {
    title: "Full Facility Buyout",
    capacity: "500+ Guests",
    color: coral,
    img: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp",
    desc: "The entire 50,000+ sq ft venue is yours. All lanes, all attractions, all bars. The ultimate private event for large groups and corporate retreats.",
  },
];

const activities = [
  {
    title: "Bowling",
    subtitle: "Glow Bowl & Cosmic",
    color: coral,
    img: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_2-1024x683.webp",
    desc: "24 state-of-the-art lanes with cosmic glow effects. Reserve lanes for your group with shoes included.",
  },
  {
    title: "NEXUS Laser Tag",
    subtitle: "$10/person",
    color: purple,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    desc: "Immersive two-story arena with haptic vests and precision sensors. Objective-based missions for up to 34 players.",
  },
  {
    title: "NEXUS Gel Blasters",
    subtitle: "$12/person",
    color: blue,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
    desc: "State-of-the-art blasters with haptic vests. Eco-friendly Gellets evaporate on impact \u2014 all the action, zero cleanup.",
  },
  {
    title: "Arcade",
    subtitle: "40+ Games",
    color: coral,
    img: "https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp",
    desc: "The latest titles, VR simulators, and a prize center. Load any amount onto a Game Card at our kiosks.",
  },
  {
    title: "HyperBowling",
    subtitle: "VIP Exclusive",
    color: purple,
    img: "https://headpinz.com/wp-content/uploads/2024/02/hyperbowling-headpinz-fort-myers.jpg",
    desc: "LED-integrated bumper targets turn every throw into a scoring challenge. Dynamic gameplay meets physical skill. Available in VIP lanes.",
  },
];

const bowlingPricing = [
  { pkg: "Regular Lanes", lanes: "Per Lane", monThu: "$36", friSun: "$57", note: "1.5 hours, up to 6 per lane, shoes included" },
  { pkg: "VIP Lanes", lanes: "Per Lane", monThu: "$57", friSun: "$79.50", note: "1.5 hours, up to 6 per lane, shoes included" },
];

const activityPricing = [
  { name: "Laser Tag", price: "$10/person", note: "Per session" },
  { name: "Gel Blasters", price: "$12/person", note: "Per session" },
  { name: "Arcade", price: "Game Cards Available", note: "Load any amount" },
];

const faqs = [
  {
    q: "How far in advance should I book?",
    a: "We recommend booking at least 2\u20133 weeks in advance for smaller groups and 4\u20136 weeks for large events or facility buyouts. Popular dates fill quickly, especially during season.",
  },
  {
    q: "What is the minimum group size?",
    a: "Group event packages are available for groups of 10 or more. Your event coordinator will tailor the package to your group size and needs.",
  },
  {
    q: "Can we bring outside food?",
    a: "All food and beverage is provided by Nemo\u2019s, our on-site restaurant and bar. Custom catering packages are available for groups of any size.",
  },
  {
    q: "Is a deposit required?",
    a: "Yes, a deposit is required to secure your date and reserve your event space. Deposit amount and payment terms will be included in your custom quote.",
  },
  {
    q: "What about non-bowlers in our group?",
    a: "No problem! We offer laser tag, gel blasters, arcade games, HyperBowling, NeoVerse, and a full-service restaurant and bar. There\u2019s something for everyone.",
  },
  {
    q: "Do you accommodate dietary restrictions?",
    a: "Absolutely. Our catering team can accommodate most dietary needs including vegetarian, vegan, gluten-free, and common allergies. Please note them in your event request.",
  },
  {
    q: "What are the age requirements for laser tag and gel blasters?",
    a: "Laser tag is available for ages 6 and up. Gel blasters require a minimum age of 10. All participants must complete a waiver.",
  },
  {
    q: "Do you offer birthday party packages?",
    a: "Yes! We offer birthday party packages for all ages with bowling, activities, food, and a dedicated party host. Contact our events team for details and pricing.",
  },
];

/* ── Component ─────────────────────────────────────────── */

export default function HeadPinzGroupEventsPage() {
  const [showForm, setShowForm] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      {/* ====== 1. HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 80vh, 800px)" }}>
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Caronchi_Photography_190226_4755-2048x1365-1-1024x683.webp"
          alt="HeadPinz bowling wide view"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a0518]" />

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
            Group Events &amp; Private Parties
          </h1>
          <p
            className="font-[var(--font-hp-body)] text-white/70 max-w-xl mx-auto"
            style={{ fontSize: "clamp(14px, 2.5vw, 20px)", lineHeight: "1.5", marginBottom: "32px" }}
          >
            From team building to birthday bashes &mdash; make it unforgettable
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 hover:shadow-[0_0_30px_rgba(253,91,86,0.4)] cursor-pointer"
          >
            Request a Quote
          </button>
        </div>
      </section>

      {/* ====== 2. INTRO + CTAs ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-6 lg:px-8 flex flex-col lg:flex-row gap-10 items-center">
          <div className="flex-1">
            <h2
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{
                fontSize: "clamp(28px, 7vw, 56px)",
                lineHeight: "1.05",
                letterSpacing: "-0.5px",
                marginBottom: "16px",
              }}
            >
              Host an Unforgettable Event
            </h2>
            <p
              className="font-[var(--font-hp-body)] text-white/80 mb-8"
              style={{ fontSize: "clamp(15px, 2vw, 18px)", lineHeight: "1.6", maxWidth: "640px" }}
            >
              Two locations. Over 50,000 sq ft each. From intimate gatherings of 10 to full
              facility buyouts for 500+, HeadPinz has the space, the activities, and the
              catering to make your event legendary.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
                style={{ backgroundColor: coral, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Request a Quote
              </button>
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
                style={{ backgroundColor: purple, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Download Event Guide
              </button>
            </div>
          </div>
          <div className="flex-1 relative w-full aspect-[4/3] rounded-2xl overflow-hidden">
            <Image
              src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_3.webp"
              alt="HeadPinz entertainment"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
              unoptimized
            />
          </div>
        </div>
      </section>

      {/* ====== 3. HOW IT WORKS ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0518] via-[#12082a] to-[#0a0518]" />
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
              textShadow: glowCoral,
            }}
          >
            How It Works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {howItWorks.map((s) => (
              <div
                key={s.step}
                className="flex flex-col items-center text-center rounded-2xl border border-white/10 bg-white/[0.03]"
                style={{ padding: "32px 20px" }}
              >
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center font-[var(--font-hp-hero)] font-black text-white text-2xl mb-4"
                  style={{ backgroundColor: s.color }}
                >
                  {s.step}
                </div>
                <h3
                  className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-3"
                  style={{ fontSize: "20px", letterSpacing: "0.5px" }}
                >
                  {s.title}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 4. EVENT SPACES ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: glowPurple,
            }}
          >
            Event Spaces
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {eventSpaces.map((s) => (
              <div
                key={s.title}
                className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] hover:border-[#fd5b56]/30 transition-all duration-300"
              >
                <div className="relative w-full aspect-[16/10] overflow-hidden">
                  <Image
                    src={s.img}
                    alt={s.title}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(max-width: 640px) 100vw, 50vw"
                    unoptimized
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0518] via-transparent to-transparent" />
                  <span
                    className="absolute bottom-3 left-4 font-[var(--font-hp-body)] font-bold text-xs px-3 py-1.5 rounded-full text-white"
                    style={{ backgroundColor: s.color }}
                  >
                    {s.capacity}
                  </span>
                </div>
                <div className="p-5 flex flex-col flex-1">
                  <h3
                    className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-2"
                    style={{ fontSize: "clamp(16px, 2.5vw, 22px)", letterSpacing: "0.5px" }}
                  >
                    {s.title}
                  </h3>
                  <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                    {s.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 5. ACTIVITIES ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0518] via-[#12082a] to-[#0a0518]" />
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
              textShadow: glowCoral,
            }}
          >
            Activities
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {activities.map((a) => (
              <div
                key={a.title}
                className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] hover:border-[#fd5b56]/30 transition-all duration-300"
              >
                <div className="relative w-full aspect-[16/10] overflow-hidden">
                  <Image
                    src={a.img}
                    alt={a.title}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    unoptimized
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0518] via-transparent to-transparent" />
                  <span
                    className="absolute bottom-3 left-4 font-[var(--font-hp-body)] font-bold text-xs px-3 py-1.5 rounded-full text-white"
                    style={{ backgroundColor: a.color }}
                  >
                    {a.subtitle}
                  </span>
                </div>
                <div className="p-5">
                  <h3
                    className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-2"
                    style={{ fontSize: "clamp(16px, 2.5vw, 20px)", letterSpacing: "0.5px" }}
                  >
                    {a.title}
                  </h3>
                  <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                    {a.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 6. BOWLING EVENT PRICING ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "16px",
              textShadow: glowPurple,
            }}
          >
            Bowling Event Pricing
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/50 text-center text-sm mb-10 max-w-lg mx-auto">
            All prices per lane. 1.5-hour sessions. Shoe rental included. Up to 6 guests per lane.
          </p>

          <div className="overflow-x-auto mb-6">
            <table className="w-full text-left font-[var(--font-hp-body)] text-sm" style={{ minWidth: "480px" }}>
              <thead>
                <tr style={{ backgroundColor: "rgba(253,91,86,0.7)" }}>
                  <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Package</th>
                  <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Lanes</th>
                  <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Mon&ndash;Thu</th>
                  <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Fri&ndash;Sun</th>
                </tr>
              </thead>
              <tbody>
                {bowlingPricing.map((r, i) => (
                  <tr
                    key={r.pkg}
                    style={{ backgroundColor: i % 2 === 0 ? "rgba(10,5,24,0.6)" : "rgba(10,5,24,0.3)" }}
                  >
                    <td className="px-4 py-3 text-white font-semibold">{r.pkg}</td>
                    <td className="px-4 py-3 text-white/70">{r.lanes}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: coral }}>
                      {r.monThu}
                    </td>
                    <td className="px-4 py-3 font-semibold" style={{ color: coral }}>
                      {r.friSun}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="font-[var(--font-hp-body)] text-white/40 text-center text-xs">
            Shoe rental included &middot; Up to 6 guests per lane &middot; Pricing may vary during holidays and special events
          </p>
        </div>
      </section>

      {/* ====== 7. ACTIVITY PRICING ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0518] via-[#12082a] to-[#0a0518]" />
        <div
          className="relative z-10 max-w-5xl mx-auto px-6 lg:px-8"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: glowCoral,
            }}
          >
            Activity Pricing
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {activityPricing.map((a) => (
              <div
                key={a.name}
                className="text-center rounded-2xl border border-white/10 bg-white/[0.03] p-6"
              >
                <h3
                  className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-2"
                  style={{ fontSize: "18px" }}
                >
                  {a.name}
                </h3>
                <p className="font-[var(--font-hp-body)] font-bold text-2xl mb-2" style={{ color: coral }}>
                  {a.price}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs">{a.note}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 8. CATERING BY NEMO'S ====== */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Headpinz_Home_gallery_carousel_5.webp"
          alt="Nemo's food at HeadPinz"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-[#0a0518]/88" />
        <div className="relative z-10 max-w-4xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "16px",
              textShadow: glowPurple,
            }}
          >
            Catering by Nemo&apos;s
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/70 text-center mx-auto mb-10"
            style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "600px", lineHeight: "1.6" }}
          >
            Fresh-made pizza packages, jumbo wing platters, appetizer trays, and full bar
            service. Our catering team builds custom menus for groups of every size.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
            {[
              { title: "Pizza Packages", desc: "Party-sized pizza trays with a variety of specialty and classic options.", color: coral },
              { title: "Wing & Appetizer Platters", desc: "Famous jumbo wings, mozzarella sticks, pretzel bites, and more.", color: purple },
              { title: "Bar Packages", desc: "Well, call, and premium drink ticket packages. Craft beer and cocktails available.", color: blue },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center"
              >
                <h3
                  className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-2"
                  style={{ fontSize: "16px" }}
                >
                  {item.title}
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>

          <div className="text-center">
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
              style={{ backgroundColor: purple, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              View Full Menu
            </button>
          </div>
        </div>
      </section>

      {/* ====== 9. FAQ ACCORDION ====== */}
      <section className="bg-[#0a0518]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <h2
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 7vw, 52px)",
              lineHeight: "1.05",
              letterSpacing: "-0.5px",
              marginBottom: "48px",
              textShadow: glowCoral,
            }}
          >
            Frequently Asked Questions
          </h2>
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <div
                key={i}
                className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden"
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
                    <p
                      className="font-[var(--font-hp-body)] text-white/60 text-sm leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: f.a }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 10. START YOUR QUOTE CTA ====== */}
      <section className="relative overflow-hidden" id="quote-form">
        <Image
          src="https://headpinz.com/wp-content/uploads/2023/10/Caronchi_Photography_190226_4755-2048x1365-1-1024x683.webp"
          alt="HeadPinz bowling panoramic"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0518] via-black/60 to-black/40" />
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
              textShadow: glowPurple,
            }}
          >
            Start Planning Your Event
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/70 mx-auto mb-10"
            style={{ fontSize: "clamp(14px, 2vw, 18px)", maxWidth: "500px", lineHeight: "1.6" }}
          >
            Tell us about your event and our team will craft a custom package tailored to your group.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer hover:shadow-[0_0_30px_rgba(253,91,86,0.4)]"
            style={{ backgroundColor: coral, borderRadius: "555px", padding: "16px 28px", fontSize: "15px" }}
          >
            Request a Quote
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
          style={{ backgroundColor: "rgba(10,5,24,0.9)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <div
            className="relative w-full max-w-3xl rounded-2xl overflow-hidden"
            style={{ backgroundColor: bg, border: `2px solid rgba(253,91,86,0.4)`, height: "90vh" }}
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
              title="HeadPinz Event Quote Request Form"
            />
          </div>
        </div>
      )}
    </>
  );
}
