"use client";

import { useState } from "react";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const EVENT_GUIDE_URL = `${BLOB}/documents/FastTrax-Event-Guide.pdf`;

const glowRed = "rgba(229,0,0,0.48) 0px 0px 30px";
const glowBlue = "rgba(28,0,255,0.4) 0px 0px 30px";

/* ── Data ─────────────────────────────────────────────── */

const howItWorks = [
  {
    step: 1,
    title: "Choose Your Event Space",
    color: "rgb(228,28,29)",
    desc: "All packages start with a Private Party Room including tables, chairs, A/V equipment, and a dedicated event host.",
  },
  {
    step: 2,
    title: "Choose Food & Beverage",
    color: "rgb(0,74,173)",
    desc: "From brick-oven pizza buffets to filet mignon, plus full bar packages. Catering by Nemo\u2019s Brickyard Bistro.",
  },
  {
    step: 3,
    title: "Pick Your Activities",
    color: "rgb(134,82,255)",
    desc: "Kart racing, duckpin bowling, arcade, shuffleboard, racing simulators, billiards \u2014 build your perfect event.",
  },
];

const eventSpaces = [
  {
    title: "VIP Lounge + Function Room",
    capacity: "Up to 80 Guests",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: `${BLOB}/images/events/DSC06739.jpg`,
    desc: "Private party room with full A/V, dedicated host, and VIP trackside viewing. Set up for meetings, presentations, or celebrations.",
  },
  {
    title: "Group Function Room",
    capacity: "Flexible Capacity",
    color: "rgb(0,74,173)",
    border: "rgb(0,74,173)",
    img: `${BLOB}/images/events/DSC06481.jpg`,
    desc: "Flexible private space with tables, chairs, and A/V integration. Ideal for corporate meetings and presentations before the green flag drops.",
  },
  {
    title: "DuckPin Social Buyout",
    capacity: "Up to 60 Guests",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    img: `${BLOB}/images/events/duckpin.jpg`,
    desc: "Full buyout of all 8 duckpin bowling lanes. No rental shoes needed \u2014 just step up and roll.",
  },
  {
    title: "Shuffly Lounge",
    capacity: "Up to 8 per Table",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: `${BLOB}/images/attractions/shuffly.webp`,
    desc: "High-tech shuffleboard tables in a social lounge setting. Perfect for networking and casual competition.",
  },
  {
    title: "Full Facility Buyout",
    capacity: "113,000 sq ft Campus",
    color: "rgb(0,74,173)",
    border: "rgb(0,74,173)",
    img: `${BLOB}/images/subpages/group-events-bg.webp`,
    desc: "The entire campus is yours. FastTrax + HeadPinz combined for the ultimate private event. Pricing on request.",
  },
];

const activities = [
  {
    title: "Kart Racing",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: `${BLOB}/images/events/kart-grid.jpg`,
    desc: "Adult, Junior, and Mini karts on Florida\u2019s longest indoor multi-level circuit. Exclusive heats for your group.",
  },
  {
    title: "Duckpin Bowling",
    color: "rgb(0,74,173)",
    border: "rgb(0,74,173)",
    img: `${BLOB}/images/events/duckpin.jpg`,
    desc: "Fast-paced social bowling. Up to 12 per pair of lanes. No rental shoes needed.",
  },
  {
    title: "Arcade & Game Zone",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    img: `${BLOB}/images/attractions/arcade.webp`,
    desc: "50+ games with tap-to-play cards. VR simulators and prize redemption.",
  },
  {
    title: "Shuffly Shuffleboard",
    color: "rgb(228,28,29)",
    border: "rgba(228,28,29,0.59)",
    img: `${BLOB}/images/attractions/shuffly.webp`,
    desc: "Up to 8 players per table. High-tech social gaming reinvented.",
  },
  {
    title: "Racing Simulator",
    color: "rgb(0,74,173)",
    border: "rgb(0,74,173)",
    img: `${BLOB}/images/events/event-3.webp`,
    desc: "Professional-grade sim racing experience. Full motion rigs with immersive displays.",
  },
  {
    title: "Billiards",
    color: "rgb(134,82,255)",
    border: "rgba(134,82,255,0.59)",
    img: `${BLOB}/images/events/event-4.webp`,
    desc: "Classic billiards tables in the social lounge. Relaxed competition between heats.",
  },
];

const racingPricing = [
  { klass: "Adult", note: "Up to 14 Racers", height: '59"+ tall', age: "Typically 13+", monThu: "$299.99", friSun: "$399.99" },
];

const activityPricing = [
  { name: "Duckpin Bowling", price: "$60/hr", note: "Up to 12 per pair of lanes" },
  { name: "Shuffly Shuffleboard", price: "$30/hr", note: "Up to 8 per table" },
  { name: "Racing Simulator", price: "$120/hr", note: "Professional sim rigs" },
  { name: "Billiards", price: "$30/hr", note: "Per table" },
  { name: "Arcade", price: "Options Available", note: "Time play cards or token based" },
];

const buffetPackages = [
  { name: "Neapolitan Pizza", price: "$28", desc: "Cheese & two specialty pizzas with Caesar salad" },
  { name: "Build Your Own Pasta", price: "$28", desc: "Choose pasta, sauce, protein & veggies" },
  { name: "Pit Stop Sliders", price: "$34", desc: "Wagyu, chicken & shrimp po\u2019boy sliders with fries" },
  { name: "Full Throttle BBQ", price: "$34", desc: "Baby back ribs, grilled chicken, baked beans & cornbread" },
];

const drinkPackages = [
  { name: "Well", price: "$6", desc: "per drink ticket" },
  { name: "Call", price: "$8", desc: "per drink ticket" },
  { name: "Premium", price: "$12", desc: "per drink ticket" },
];

const eventFormats = [
  {
    title: "Full Facility Buyouts",
    color: "rgb(228,28,29)",
    borderColor: "rgba(228,28,29,0.59)",
    desc: "Complete privacy. The building is yours. Exclusive track access, branding opportunities throughout the facility, and a dedicated event team. Perfect for corporate retreats, product launches, and milestone celebrations.",
  },
  {
    title: "Exclusive Racing Heats",
    color: "rgb(0,74,173)",
    borderColor: "rgb(0,74,173)",
    desc: "Reserved grid spots for your group. Unlike standard public racing, Exclusive Heats ensure your group only races against each other. No outside racers. Includes the FastTrax License. Primary bookings hosted Monday through Thursday.",
  },
];

const faqs = [
  {
    q: "How far in advance should I book?",
    a: "We recommend booking at least 2\u20133 weeks in advance for smaller groups and 4\u20136 weeks for large events or facility buyouts. Popular dates fill quickly, especially during season.",
  },
  {
    q: "What is the minimum group size?",
    a: "Exclusive racing heats accommodate up to 14 adult/junior racers or 7 mini racers per heat. Event spaces and activity bookings vary by venue \u2014 your event coordinator will tailor the package to your group.",
  },
  {
    q: "Can we bring outside food or decorations?",
    a: "All food and beverage is provided by Nemo\u2019s Brickyard Bistro, our on-site restaurant. Custom decorations and branding may be arranged with your event coordinator.",
  },
  {
    q: "Is there a deposit required?",
    a: "Yes, a deposit is required to secure your date and reserve your event space. Details including deposit amount and payment terms will be provided in your custom quote.",
  },
  {
    q: "What if some guests don\u2019t want to race?",
    a: "No problem! We offer duckpin bowling, shuffleboard, arcade games, billiards, racing simulators, and a full-service restaurant and bar. There\u2019s something for everyone.",
  },
  {
    q: "Do you accommodate dietary restrictions?",
    a: "Absolutely. Our catering team can accommodate most dietary needs including vegetarian, vegan, gluten-free, and common allergies. Please note them in your event request.",
  },
  {
    q: "What are the age and height requirements for racing?",
    a: "Adult karts require 59\"+ tall (typically 13+). Junior karts are for 49\"\u201370\" tall (typically 7\u201313). Mini karts are for 36\"\u201355\" tall (ages 4\u20138 only).",
  },
  {
    q: "Can we do a hybrid event across both buildings?",
    a: "Absolutely. Our event coordinators can create packages spanning FastTrax and HeadPinz for the full 113,000 sq ft campus experience \u2014 racing, bowling, laser tag, and more.",
  },
];

/* ── Component ─────────────────────────────────────────── */

export default function GroupEventsPage() {
  const [showForm, setShowForm] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <>
      {/* 1. Hero */}
      <SubpageHero
        title="Group Events & Team Building"
        backgroundImage={`${BLOB}/images/subpages/group-events-hero.webp`}
      />

      {/* 2. Intro + Dual CTAs */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8 flex flex-col lg:flex-row gap-10 items-center">
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowRed }}
            >
              Host an Unforgettable Event at the Destination.
            </h2>
            <p className="font-[var(--font-poppins)] mb-8" style={{ color: "rgba(255,255,255,0.898)", fontSize: "17px", lineHeight: "1.6", maxWidth: "700px" }}>
              From executive buyouts to high-octane team building. Southwest Florida&apos;s premier event campus offers 113,000 sq. ft. of adrenaline, elite catering, and VIP amenities for groups of 14 to 1,000+
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => setShowForm(true)}
                className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
                style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Request an Event Quote
              </button>
              <a
                href={EVENT_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Download Event Guide
              </a>
            </div>
          </div>
          <div className="flex-1 relative w-full aspect-[4/3] rounded-xl overflow-hidden">
            <Image
              src={`${BLOB}/images/events/DSC07773.jpg`}
              alt="Group kart racing at FastTrax"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
              unoptimized
            />
          </div>
        </div>
      </section>

      {/* 3. How It Works */}
      <section className="relative overflow-hidden">
        <Image src={`${BLOB}/images/subpages/checkered-flag.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto px-8" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: "rgba(255,30,0,0.4) 0px 0px 30px" }}
          >
            How It Works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {howItWorks.map((s) => (
              <div
                key={s.step}
                className="flex flex-col items-center text-center"
                style={{ backgroundColor: "rgba(7,16,39,0.6)", border: `1.78px dashed ${s.color}`, borderRadius: "8px", padding: "32px 20px" }}
              >
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center font-[var(--font-anton)] text-white text-2xl mb-4"
                  style={{ backgroundColor: s.color }}
                >
                  {s.step}
                </div>
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: s.color, fontSize: "22px", letterSpacing: "1.2px" }}>
                  {s.title}
                </h3>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.5" }}>
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4. Event Spaces */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowRed }}
          >
            Event Spaces
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {eventSpaces.map((s) => (
              <div
                key={s.title}
                className="flex flex-col overflow-hidden"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${s.border}`, borderRadius: "8px" }}
              >
                <div className="relative w-full aspect-[16/10]">
                  <Image src={s.img} alt={s.title} fill className="object-cover" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" unoptimized />
                </div>
                <div className="p-5 flex flex-col flex-1">
                  <h3 className="font-[var(--font-anton)] uppercase mb-1" style={{ color: s.color, fontSize: "22px", letterSpacing: "1.2px" }}>
                    {s.title}
                  </h3>
                  <span className="text-xs font-[var(--font-poppins)] font-semibold uppercase tracking-wider mb-3" style={{ color: "rgba(255,255,255,0.5)" }}>
                    {s.capacity}
                  </span>
                  <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.5" }}>
                    {s.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5. Activities Grid */}
      <section className="relative overflow-hidden">
        <Image src={`${BLOB}/images/subpages/checkered-flag.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto px-8" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowBlue }}
          >
            Activities
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {activities.map((a) => (
              <div
                key={a.title}
                className="flex flex-col overflow-hidden"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${a.border}`, borderRadius: "8px" }}
              >
                <div className="relative w-full aspect-[16/10]">
                  <Image src={a.img} alt={a.title} fill className="object-cover" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" unoptimized />
                </div>
                <div className="p-5">
                  <h3 className="font-[var(--font-anton)] uppercase mb-2" style={{ color: a.color, fontSize: "22px", letterSpacing: "1.2px" }}>
                    {a.title}
                  </h3>
                  <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.5" }}>
                    {a.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6. Racing Pricing Table */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowRed }}
          >
            Exclusive Racing Heat Pricing
          </h2>
          <p className="font-[var(--font-poppins)] text-center mx-auto mb-10" style={{ color: "rgba(255,255,255,0.7)", fontSize: "16px", maxWidth: "600px", lineHeight: "1.6" }}>
            Prices are per heat. Exclusive heats ensure your group races only against each other.
          </p>

          <div className="overflow-x-auto mb-8">
            <table className="w-full text-left font-[var(--font-poppins)] text-sm" style={{ minWidth: "500px" }}>
              <thead>
                <tr style={{ backgroundColor: "rgba(228,28,29,0.72)" }}>
                  <th className="px-4 py-3 text-white font-semibold uppercase tracking-wider text-xs">Kart Class</th>
                  <th className="px-4 py-3 text-white font-semibold uppercase tracking-wider text-xs">Racers</th>
                  <th className="px-4 py-3 text-white font-semibold uppercase tracking-wider text-xs">Mon&ndash;Thu</th>
                  <th className="px-4 py-3 text-white font-semibold uppercase tracking-wider text-xs">Fri&ndash;Sun</th>
                </tr>
              </thead>
              <tbody>
                {racingPricing.map((r, i) => (
                  <tr key={r.klass} style={{ backgroundColor: i % 2 === 0 ? "rgba(7,16,39,0.6)" : "rgba(7,16,39,0.3)" }}>
                    <td className="px-4 py-3 text-white font-semibold">{r.klass}</td>
                    <td className="px-4 py-3" style={{ color: "rgba(255,255,255,0.7)" }}>{r.note}</td>
                    <td className="px-4 py-3 text-[#00E2E5] font-semibold">{r.monThu}</td>
                    <td className="px-4 py-3 text-[#00E2E5] font-semibold">{r.friSun}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="font-[var(--font-poppins)] text-center mb-8" style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px" }}>
            +$100 per heat for Mega Track events
          </p>

          {/* Kart Requirements Callout */}
          <div style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,193,7,0.6)", borderRadius: "8px", padding: "20px" }}>
            <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(255,193,7)", fontSize: "20px", letterSpacing: "1.2px" }}>
              Kart Requirements
            </h3>
            <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "14px" }}>
              Racers must be at least 59&quot; tall (typically 13+). Junior and Mini kart options available for younger groups &mdash; ask your event coordinator for details.
            </p>
          </div>

          <div className="text-center mt-10">
            <button
              onClick={() => setShowForm(true)}
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
              style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              Request a Custom Quote
            </button>
          </div>
        </div>
      </section>

      {/* 7. Activity Pricing */}
      <section className="relative overflow-hidden">
        <Image src={`${BLOB}/images/subpages/checkered-flag.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto px-8" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowBlue }}
          >
            Activity Pricing
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {activityPricing.map((a) => (
              <div
                key={a.name}
                className="text-center"
                style={{ backgroundColor: "rgba(7,16,39,0.6)", border: "1.78px dashed rgba(0,226,229,0.4)", borderRadius: "8px", padding: "24px 16px" }}
              >
                <h3 className="font-[var(--font-anton)] uppercase text-white mb-1" style={{ fontSize: "18px", letterSpacing: "1px" }}>
                  {a.name}
                </h3>
                <p className="text-[#00E2E5] font-[var(--font-poppins)] font-bold text-2xl mb-2">{a.price}</p>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(255,255,255,0.5)", fontSize: "13px" }}>
                  {a.note}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 8. Food & Beverage */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowRed }}
          >
            Catering by Nemo&apos;s Brickyard Bistro
          </h2>

          <div className="flex flex-col lg:flex-row gap-10 items-start">
            {/* Image */}
            <div className="lg:w-2/5 relative w-full aspect-[4/3] rounded-xl overflow-hidden">
              <Image
                src={`${BLOB}/images/events/DSC07792.jpg`}
                alt="Buffet catering at FastTrax"
                fill
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 40vw"
                unoptimized
              />
            </div>

            {/* Content */}
            <div className="lg:w-3/5">
              <h3 className="font-[var(--font-anton)] uppercase mb-4" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                Buffet Packages
              </h3>
              <p className="font-[var(--font-poppins)] mb-4" style={{ color: "rgba(255,255,255,0.5)", fontSize: "13px" }}>
                Per guest &middot; 20 person minimum &middot; Served for 1 hour
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                {buffetPackages.map((b) => (
                  <div
                    key={b.name}
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(228,28,29,0.3)", borderRadius: "8px", padding: "16px" }}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-[var(--font-poppins)] font-semibold text-white text-sm">{b.name}</span>
                      <span className="text-[#00E2E5] font-[var(--font-poppins)] font-bold text-sm">{b.price}</span>
                    </div>
                    <p className="font-[var(--font-poppins)]" style={{ color: "rgba(255,255,255,0.5)", fontSize: "13px", lineHeight: "1.4" }}>
                      {b.desc}
                    </p>
                  </div>
                ))}
              </div>

              <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(134,82,255)", fontSize: "20px", letterSpacing: "1.2px" }}>
                Premium Entrees Available
              </h3>
              <p className="font-[var(--font-poppins)] mb-8" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.5" }}>
                Filet Mignon &middot; Parmesan Chicken &middot; Baby Back Ribs &middot; Lamb Racks &middot; Lobster Tails
              </p>

              <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(0,74,173)", fontSize: "20px", letterSpacing: "1.2px" }}>
                Bar Packages
              </h3>
              <div className="flex flex-wrap gap-3 mb-8">
                {drinkPackages.map((d) => (
                  <div
                    key={d.name}
                    className="text-center"
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(0,74,173,0.4)", borderRadius: "8px", padding: "12px 20px" }}
                  >
                    <span className="font-[var(--font-poppins)] font-semibold text-white text-sm block">{d.name}</span>
                    <span className="text-[#00E2E5] font-[var(--font-poppins)] font-bold text-lg">{d.price}</span>
                    <span className="font-[var(--font-poppins)] block" style={{ color: "rgba(255,255,255,0.4)", fontSize: "11px" }}>{d.desc}</span>
                  </div>
                ))}
              </div>

              <a
                href={EVENT_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
                style={{ backgroundColor: "rgb(134,82,255)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Download Full Menu
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* 9. Event Formats */}
      <section className="relative overflow-hidden">
        <Image src={`${BLOB}/images/subpages/checkered-flag.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto px-8" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: "rgba(255,30,0,0.4) 0px 0px 30px" }}
          >
            Event Formats: Elite Access
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {eventFormats.map((e) => (
              <div
                key={e.title}
                className="flex flex-col h-full"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${e.borderColor}`, borderRadius: "8px", padding: "24px" }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: e.color, fontSize: "24px", letterSpacing: "1.2px" }}>
                  {e.title}
                </h3>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5" }}>
                  {e.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 10. FAQ Accordion */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowBlue }}
          >
            Frequently Asked Questions
          </h2>
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <div
                key={i}
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,255,255,0.1)", borderRadius: "8px", overflow: "hidden" }}
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left cursor-pointer"
                >
                  <span className="font-[var(--font-poppins)] font-semibold text-white text-sm pr-4">{f.q}</span>
                  <svg
                    className="w-5 h-5 flex-shrink-0 text-[#00E2E5] transition-transform"
                    style={{ transform: openFaq === i ? "rotate(180deg)" : "rotate(0deg)" }}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openFaq === i && (
                  <div className="px-5 pb-4">
                    <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.7)", fontSize: "14px", lineHeight: "1.6" }}>
                      {f.a}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <p className="font-[var(--font-poppins)] mb-4" style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px" }}>
              Still have questions?
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
              style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              Request a Quote
            </button>
          </div>
        </div>
      </section>

      {/* 11. Download Event Guide CTA */}
      <section className="relative overflow-hidden">
        <Image src={`${BLOB}/images/subpages/group-events-bg.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/80" />
        <div className="relative z-10 max-w-3xl mx-auto px-8 text-center" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: "rgba(134,82,255,0.4) 0px 0px 30px" }}
          >
            Get the Complete Event Guide
          </h2>
          <p className="mx-auto mb-10 font-[var(--font-poppins)]" style={{ color: "rgba(255,255,255,0.898)", fontSize: "17px", lineHeight: "1.6", maxWidth: "600px" }}>
            Download our detailed event planning guide with full menus, floor plans, pricing, and package options.
          </p>
          <a
            href={EVENT_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{ backgroundColor: "rgb(134,82,255)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
          >
            Download Event Guide
          </a>
        </div>
      </section>

      {/* 12. Quote Form CTA */}
      <section className="relative overflow-hidden" id="quote-form">
        <Image src={`${BLOB}/images/subpages/group-events-bg.webp`} alt="" fill className="object-cover" sizes="100vw" unoptimized />
        <div className="absolute inset-0 bg-[#000418]/80" />
        <div className="relative z-10 max-w-3xl mx-auto px-8 text-center" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{ fontSize: "clamp(28px, 7vw, 60px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowBlue }}
          >
            Start Your Quote
          </h2>
          <p className="mx-auto mb-10 font-[var(--font-poppins)]" style={{ color: "rgba(255,255,255,0.898)", fontSize: "17px", lineHeight: "1.6", maxWidth: "600px" }}>
            Tell us about your event and our team will craft a custom package.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 cursor-pointer"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
          >
            Request an Event Quote
          </button>
          <p className="font-[var(--font-poppins)] mt-4" style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px" }}>
            Prefer to talk? Call us at{" "}
            <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">(239) 481-9666</a>
          </p>
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
            style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(228,28,29,0.4)", height: "90vh" }}
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
              title="Event Quote Request Form"
            />
          </div>
        </div>
      )}
    </>
  );
}
