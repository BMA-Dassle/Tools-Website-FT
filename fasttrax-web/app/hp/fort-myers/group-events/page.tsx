"use client";

import { useState } from "react";
import Image from "next/image";

/* -- HeadPinz brand tokens -------------------------------- */

const coral = "#fd5b56";
const purple = "#123075";
const blue = "#0693e3";
const bg = "#0a1628";
const royalBlue = "#123075";

const glowCoral = "rgba(253,91,86,0.4) 0px 0px 30px";
const glowPurple = "rgba(18,48,117,0.5) 0px 0px 30px";

/* -- Data ------------------------------------------------- */

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
    desc: "Buffet packages, wing platters, and full bar service by Nemo\u2019s. Catering built for groups of any size.",
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
    title: "Classic Bowling Lanes",
    capacity: "Up to 6 per lane, shoes included",
    color: coral,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    desc: "Reserve a block of lanes for your group with glow-bowl lighting, cosmic effects, and shoe rental included.",
  },
  {
    title: "VIP Bowling",
    capacity: "Dedicated VIP Lounge & Bar",
    color: purple,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/videos/headpinz-viptour.mp4",
    isVideo: true,
    desc: "Dedicated light & music show, VIP lounge & bar, HyperBowling, pool table, shoes & balls included.",
  },
  {
    title: "VIP Pinz Exclusive",
    capacity: "Up to 80 guests (48 bowl at once)",
    color: blue,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-entertainment.webp",
    desc: "8 white surface lanes, dedicated light show, private lounge & bar, pool table, HyperBowling. Holds up to 80 people.",
  },
  {
    title: "Pinboyz Lanes",
    capacity: "4 Vintage Lanes, Private Lounge",
    color: coral,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/oldtime-pinboyz.jpg",
    desc: "4 vintage lanes, separate sound system, private lounge & bar with dedicated server, vintage 1908 pool table.",
  },
];

const activities = [
  {
    title: "Bowling",
    subtitle: "Glow Bowl & Cosmic",
    color: coral,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    desc: "State-of-the-art lanes with cosmic glow effects. Reserve lanes for your group with shoes included.",
  },
  {
    title: "NEXUS Laser Tag",
    subtitle: "$200/session",
    color: purple,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    desc: "Immersive two-story arena with haptic vests and precision sensors. Objective-based missions. $200 per session for group events.",
  },
  {
    title: "Gel Blasters",
    subtitle: "Per Person",
    color: blue,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg",
    desc: "High-tech blasters with haptic vests and eco-friendly Gellets. Fast-paced team battles in a glowing arena.",
  },
  {
    title: "Arcade / Game Zone",
    subtitle: "Cards $5\u2013$20",
    color: coral,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-entertainment.webp",
    desc: "The latest titles, VR simulators, and a prize center. Timed or redemption game cards available.",
  },
  {
    title: "HyperBowling",
    subtitle: "VIP Exclusive",
    color: purple,
    img: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hyperbowling.jpg",
    desc: "LED-integrated bumper targets turn every throw into a scoring challenge. Available in VIP lanes.",
  },
];

/* -- Bowling pricing tables ------------------------------- */

const classicBowling = {
  title: "Classic Bowling",
  subtitle: "Per lane, up to 6 people, shoes & balls included",
  color: coral,
  rows: [
    { period: "Mon\u2013Fri before 5pm", h15: "$70.50", h2: "$82.50", h3: "$106.50" },
    { period: "Mon\u2013Thu after 5pm", h15: "$82.50", h2: "$97.50", h3: "$127.50" },
    { period: "Fri 5pm \u2013 Sun Close", h15: "$98.50", h2: "$117.00", h3: "$155.00" },
  ],
};

const vipBowling = {
  title: "VIP Bowling",
  subtitle: "Dedicated light & music show, VIP lounge & bar, HyperBowling, pool table, shoes & balls included",
  color: purple,
  rows: [
    { period: "Mon\u2013Fri before 5pm", h15: "$111.00", h2: "$133.00", h3: "$177.00" },
    { period: "Mon\u2013Thu after 5pm", h15: "$115.00", h2: "$138.00", h3: "$184.00" },
    { period: "Fri 5pm \u2013 Sun Close", h15: "$139.00", h2: "$168.00", h3: "$226.00" },
  ],
};

const vipPinzExclusive = {
  title: "VIP Pinz Exclusive",
  subtitle: "8 white surface lanes, dedicated light show, private lounge & bar, pool table, HyperBowling \u2014 holds up to 80 people, 48 can bowl at once",
  color: blue,
  rows: [
    { period: "Mon\u2013Fri before 5pm", h15: "$888", h2: "$1,064", h3: "$1,416" },
    { period: "Mon\u2013Thu after 5pm", h15: "$920", h2: "$1,104", h3: "$1,472" },
    { period: "Fri 5pm \u2013 Sun Close", h15: "$1,112", h2: "$1,344", h3: "$1,808" },
  ],
};

const bowlingTables = [classicBowling, vipBowling, vipPinzExclusive];

/* -- Add-on activities ------------------------------------ */

const addOnActivities = [
  { name: "NEXUS Laser Tag", price: "$200/session" },
  { name: "NEXUS Gel Blasters", price: "$250/session" },
  { name: "Pool Tables", price: "$15/hour" },
  { name: "Gel Blasters", price: "$12/person" },
  { name: "Ping Pong", price: "$9 before 5pm / $13 after 5pm" },
  { name: "Game Zone Cards", price: "$5 / $10 / $20" },
];

/* -- Buffet packages -------------------------------------- */

const buffetPackages = [
  {
    name: "Taco Bar",
    price: "$28/person",
    desc: "Shrimp, mojo pork, marinated chicken, seasoned beef (choice of 3 proteins). Rice, tortillas, Pico, sour cream, cheeses, lettuce, guacamole, chips & salsa.",
  },
  {
    name: "Fajita Bar",
    price: "$29/person",
    desc: "Seasoned steak & chicken fajita bar with sauteed peppers & onions, cilantro rice, Pico de Gallo, shredded Mexican cheese, sour cream, jalapenos, shredded lettuce. Flour tortillas.",
  },
  {
    name: "Italian Spread",
    price: "$27/person",
    desc: "Slow cooked Italian meatballs in seasoned marinara, sausage with peppers & onions, shrimp scampi. Linguini & garlic breadsticks, house or Caesar salad.",
  },
  {
    name: "Farm 2 Table",
    price: "$31/person",
    desc: "Mini burgers topped with lettuce & tomato, mini-BBQ pulled pork, grilled chicken sliders. French fries, Cole slaw, BBQ baked beans.",
  },
  {
    name: "Specialty Pizza Buffet",
    price: "$21/person",
    desc: "Cheese, pepperoni + any 2 specialty pizzas (meat lovers, supreme, veggie, buffalo chicken). Tossed house or Caesar salad, garlic bread.",
  },
  {
    name: "Pizza Buffet",
    price: "$16/person",
    desc: '16" cheese and pepperoni pizzas.',
  },
  {
    name: "Nacho Bar \u2014 Chicken",
    price: "$25/person",
    desc: "Marinated chicken with chips, queso, Pico, corn & bean salsa, lettuce, sour cream, chives & jalapenos.",
  },
  {
    name: "Nacho Bar \u2014 Mojo Pork",
    price: "$21/person",
    desc: "Mojo pork with chips, queso, Pico, corn & bean salsa, lettuce, sour cream, chives & jalapenos.",
  },
  {
    name: "Nacho Bar \u2014 Chili",
    price: "$21/person",
    desc: "Chili with chips, queso, Pico, corn & bean salsa, lettuce, sour cream, chives & jalapenos.",
  },
];

/* -- Extra Frames (a la carte) ---------------------------- */

const extraFrames = [
  { name: "Roasted Pork Platter", price: "$210", note: "Serves 12\u201315" },
  { name: "Churrasco Steak Platter", price: "$279", note: "Serves 12\u201315" },
  { name: "Meatball Platter (50)", price: "$45", note: "" },
  { name: "Meatball Platter (100)", price: "$75", note: "" },
  { name: "Spinach Artichoke Dip", price: "$60", note: "" },
  { name: "Chicken Teriyaki Potstickers", price: "$35", note: "30 pieces" },
  { name: "15 Mini Sliders", price: "$52", note: "Mini burgers, cubans, chicken, or mojo pork" },
  { name: "Nemo\u2019s Famous Chicken Wings", price: "Market Price", note: "20/50/100 count, Ranch or Blue Cheese" },
  { name: 'Cheese Pizza (16")', price: "$18", note: "" },
  { name: 'Pepperoni Pizza (16")', price: "$20", note: "" },
  { name: 'Veggie Pizza (16")', price: "$22", note: "" },
  { name: 'Buffalo Chicken Pizza (16")', price: "$24", note: "" },
  { name: 'Meat Lover Pizza (16")', price: "$24", note: "" },
  { name: 'Supreme Pizza (16")', price: "$24", note: "" },
  { name: 'Margherita Pizza (16")', price: "$24", note: "" },
  { name: 'BBQ Chicken Pizza (16")', price: "$24", note: "" },
  { name: "Chafer of Salad", price: "$45", note: "House or Caesar, serves 25" },
  { name: "Fruit Tray (Small)", price: "$85", note: "Serves 25" },
  { name: "Fruit Tray (Large)", price: "$160", note: "Serves 50" },
  { name: "Veggie Tray (Small)", price: "$85", note: "Serves 25" },
  { name: "Veggie Tray (Large)", price: "$160", note: "Serves 50" },
  { name: "Chips & Salsa", price: "$35", note: "" },
  { name: "Queso & Chips", price: "$60", note: "" },
  { name: "Guacamole & Chips", price: "$60", note: "" },
  { name: "Chicken Tenders", price: "$75", note: "20 pieces with 2 sauces" },
  { name: "Boneless Wings (Small)", price: "$45", note: "2.5 lb" },
  { name: "Boneless Wings (Large)", price: "$80", note: "5 lb" },
  { name: "Mac & Cheese Bites", price: "$50", note: "45 count" },
  { name: "Mini Empanadas", price: "$50", note: "30 count" },
  { name: "Fried Mozzarella Sticks", price: "$50", note: "30 count" },
  { name: "Loaded Fries", price: "$60", note: "5 lbs" },
  { name: "Fries", price: "$30", note: "5 lbs" },
  { name: "Coconut Shrimp", price: "$68", note: "30 pieces" },
  { name: "Brownies (Small)", price: "$75", note: "Serves 25" },
  { name: "Brownies (Large)", price: "$125", note: "Serves 50" },
  { name: "Cookies (Small)", price: "$75", note: "Serves 25" },
  { name: "Cookies (Large)", price: "$125", note: "Serves 50" },
];

/* -- Beverages -------------------------------------------- */

const beverages = [
  { category: "Non-Alcoholic", items: [
    { name: "Soda Pitchers", price: "$7" },
    { name: "Unlimited Soda, Coffee & Tea", price: "$4/guest" },
  ]},
  { category: "Beer", items: [
    { name: "Domestic Pitcher", price: "$14.50" },
    { name: "Craft Pitcher", price: "$23" },
    { name: "Import Pitcher", price: "$23" },
    { name: "Domestic Bucket (5 bottles)", price: "$18" },
    { name: "Craft/Import Bucket (5 bottles)", price: "$24.50" },
  ]},
  { category: "Drink Tickets", items: [
    { name: "Well Liquor / Domestic Beer / House Wine", price: "$5 each" },
    { name: "Call Liquor / Import / Domestic Beer / Wine", price: "$7 each" },
    { name: "Any Liquor / Craft / Import / Domestic / Wine", price: "$9 each" },
  ]},
];

/* -- FAQs ------------------------------------------------- */

const faqs = [
  {
    q: "How far in advance should I book?",
    a: "We recommend booking at least 2\u20133 weeks in advance for smaller groups and 4\u20136 weeks for large events or facility buyouts. Popular dates fill quickly, especially during season.",
  },
  {
    q: "What is the minimum group size?",
    a: "Group event packages are available for groups of 10 or more. Buffet catering requires a minimum of 25 people.",
  },
  {
    q: "Can we bring outside food?",
    a: "All food and beverage is provided by Nemo\u2019s, our on-site restaurant and bar. Custom catering packages are available for groups of any size. Food orders must be placed 72 hours in advance.",
  },
  {
    q: "Is a deposit required?",
    a: "Yes, a deposit is required to secure your date and reserve your event space. Deposit amount and payment terms will be included in your custom quote.",
  },
  {
    q: "What about non-bowlers in our group?",
    a: "No problem! We offer laser tag, gel blasters, ping pong, pool tables, arcade games, HyperBowling, and a full-service restaurant and bar. There\u2019s something for everyone.",
  },
  {
    q: "Do you accommodate dietary restrictions?",
    a: "Absolutely. Our catering team can accommodate most dietary needs including vegetarian, vegan, gluten-free, and common allergies. Please note them in your event request.",
  },
  {
    q: "Do you have a corporate meeting room?",
    a: "Yes! Our meeting room is available for $100/hour with A/V equipment included. Perfect for presentations before team activities.",
  },
  {
    q: "Do you offer birthday party packages?",
    a: "Yes! We offer birthday party packages for all ages with bowling, activities, food, and a dedicated party host. Contact our events team for details and pricing.",
  },
];

/* -- Reusable bowling price table component --------------- */

function BowlingPriceTable({ table }: { table: typeof classicBowling }) {
  return (
    <div className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] overflow-hidden mb-8">
      <div className="px-5 py-4 border-b border-white/10" style={{ backgroundColor: `${table.color}15` }}>
        <h3
          className="font-[var(--font-hp-hero)] font-black uppercase text-white"
          style={{ fontSize: "clamp(18px, 3vw, 24px)", letterSpacing: "0.5px" }}
        >
          {table.title}
        </h3>
        <p className="font-[var(--font-hp-body)] text-white/50 text-xs mt-1">{table.subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-[var(--font-hp-body)] text-sm" style={{ minWidth: "520px" }}>
          <thead>
            <tr style={{ backgroundColor: `${table.color}88` }}>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Time Period</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">1.5 Hours</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">2 Hours</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">3 Hours</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr
                key={r.period}
                style={{ backgroundColor: i % 2 === 0 ? "rgba(10,22,40,0.6)" : "rgba(10,22,40,0.3)" }}
              >
                <td className="px-4 py-3 text-white/80 font-medium">{r.period}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: table.color }}>{r.h15}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: table.color }}>{r.h2}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: table.color }}>{r.h3}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -- Component -------------------------------------------- */

export default function HeadPinzGroupEventsPage() {
  const [showForm, setShowForm] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [extrasOpen, setExtrasOpen] = useState(false);

  return (
    <>
      {/* ====== 1. HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "100vh" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
          alt="HeadPinz classic bowling lanes"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "100vh" }}
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
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider px-10 py-4 rounded-full transition-all hover:scale-105 shadow-[0_0_20px_rgba(253,91,86,0.3)] hover:shadow-[0_0_30px_rgba(253,91,86,0.5)] cursor-pointer"
          >
            Request a Quote
          </button>
        </div>
      </section>

      {/* ====== 2. INTRO + CTAs ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
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
              Over 50,000 sq ft of entertainment. From intimate gatherings of 10 to full
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
              <a
                href="tel:+12393022155"
                className="inline-flex items-center font-[var(--font-hp-body)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
                style={{ backgroundColor: purple, borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
              >
                Call (239) 302-2155
              </a>
            </div>
          </div>
          <div className="flex-1 relative w-full aspect-[4/3] rounded-2xl overflow-hidden">
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-entertainment.webp"
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
              textShadow: glowCoral,
            }}
          >
            How It Works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {howItWorks.map((s) => (
              <div
                key={s.step}
                className="flex flex-col items-center text-center rounded-2xl border border-[#123075]/30 bg-white/[0.03]"
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
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
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
                className="group flex flex-col overflow-hidden rounded-2xl border border-[#123075]/30 bg-white/[0.03] hover:border-[#fd5b56]/30 transition-all duration-300"
              >
                <div className="relative w-full aspect-[16/10] overflow-hidden">
                  {(s as { isVideo?: boolean }).isVideo ? (
                    <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105">
                      <source src={s.img} type="video/mp4" />
                    </video>
                  ) : (
                  <Image
                    src={s.img}
                    alt={s.title}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(max-width: 640px) 100vw, 50vw"
                    unoptimized
                  />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-transparent to-transparent" />
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
              textShadow: glowCoral,
            }}
          >
            Activities
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {activities.map((a) => (
              <div
                key={a.title}
                className="group flex flex-col overflow-hidden rounded-2xl border border-[#123075]/30 bg-white/[0.03] hover:border-[#fd5b56]/30 transition-all duration-300"
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
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-transparent to-transparent" />
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
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
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
            All prices plus sales tax. Prices subject to change.
          </p>

          {bowlingTables.map((table) => (
            <BowlingPriceTable key={table.title} table={table} />
          ))}

          {/* Pinboyz Lanes -- flat rate, separate card */}
          <div className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] overflow-hidden mb-8">
            <div className="px-5 py-4 border-b border-white/10" style={{ backgroundColor: `${coral}15` }}>
              <h3
                className="font-[var(--font-hp-hero)] font-black uppercase text-white"
                style={{ fontSize: "clamp(18px, 3vw, 24px)", letterSpacing: "0.5px" }}
              >
                Pinboyz Lanes
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs mt-1">
                4 vintage lanes, separate sound system, private lounge & bar with dedicated server, vintage 1908 pool table
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-5">
              {[
                { duration: "2 Hours", price: "$800" },
                { duration: "3 Hours", price: "$1,200" },
                { duration: "Additional Hour", price: "$400" },
              ].map((item) => (
                <div key={item.duration} className="text-center rounded-xl bg-white/[0.03] border border-white/5 p-4">
                  <p className="font-[var(--font-hp-body)] text-white/60 text-xs uppercase tracking-wider mb-1">{item.duration}</p>
                  <p className="font-[var(--font-hp-hero)] font-black text-2xl" style={{ color: coral }}>{item.price}</p>
                </div>
              ))}
            </div>
          </div>

          <p className="font-[var(--font-hp-body)] text-white/40 text-center text-xs">
            All prices plus sales tax &middot; Prices subject to change
          </p>
        </div>
      </section>

      {/* ====== 7. ADD-ON ACTIVITIES + SPECIALS ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a1628] via-[#0f1e38] to-[#0a1628]" />
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
            Add-On Activities
          </h2>

          {/* Add-on grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
            {addOnActivities.map((a) => (
              <div
                key={a.name}
                className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] p-5 flex flex-col items-center text-center"
              >
                <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-2" style={{ fontSize: "16px" }}>
                  {a.name}
                </h3>
                <p className="font-[var(--font-hp-body)] font-bold text-lg" style={{ color: coral }}>
                  {a.price}
                </p>
              </div>
            ))}
          </div>

          {/* Game Zone Party + Meeting Room + Full Buyout */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-[#123075]/30 p-5 text-center" style={{ backgroundColor: `${purple}15` }}>
              <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-1" style={{ fontSize: "16px" }}>
                Game Zone Party
              </h3>
              <p className="font-[var(--font-hp-hero)] font-black text-2xl mb-2" style={{ color: purple }}>$22/person</p>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs leading-relaxed">
                1 round of Laser Tag + 1-hour unlimited Game Zone (not valid on photo, redemption, merchandise, or coin pushers)
              </p>
            </div>
            <div className="rounded-2xl border border-[#123075]/30 p-5 text-center" style={{ backgroundColor: `${blue}15` }}>
              <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-1" style={{ fontSize: "16px" }}>
                Corporate Meeting Room
              </h3>
              <p className="font-[var(--font-hp-hero)] font-black text-2xl mb-2" style={{ color: blue }}>$100/hour</p>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs leading-relaxed">
                A/V equipment included. Perfect for presentations before team activities.
              </p>
            </div>
            <div className="rounded-2xl border border-[#123075]/30 p-5 text-center" style={{ backgroundColor: `${coral}15` }}>
              <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-1" style={{ fontSize: "16px" }}>
                Full Venue Buyout
              </h3>
              <p className="font-[var(--font-hp-hero)] font-black text-lg mb-2" style={{ color: coral }}>Contact Event Planner</p>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs leading-relaxed">
                Call{" "}
                <a href="tel:+12393022155" className="underline" style={{ color: coral }}>
                  (239) 302-2155
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ====== 8. BUFFET PACKAGES ====== */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png"
          alt="Nemo's famous wings at HeadPinz"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-[#0a1628]/90" />
        <div className="relative z-10 max-w-6xl mx-auto px-6 lg:px-8">
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
            Buffet Packages
          </h2>
          <p
            className="font-[var(--font-hp-body)] text-white/60 text-center mx-auto mb-10"
            style={{ fontSize: "clamp(13px, 2vw, 16px)", maxWidth: "600px", lineHeight: "1.5" }}
          >
            25 person minimum &middot; 1-hour service &middot; Soda, tea, coffee & water included
            <br />
            Food orders required 72 hours in advance
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-10">
            {buffetPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] p-5 flex flex-col"
              >
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white" style={{ fontSize: "16px" }}>
                    {pkg.name}
                  </h3>
                  <span className="font-[var(--font-hp-body)] font-bold text-sm ml-2 flex-shrink-0" style={{ color: coral }}>
                    {pkg.price}
                  </span>
                </div>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs leading-relaxed flex-1">
                  {pkg.desc}
                </p>
              </div>
            ))}
          </div>

          {/* Extra Frames -- collapsible accordion */}
          <div className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] overflow-hidden mb-6">
            <button
              onClick={() => setExtrasOpen(!extrasOpen)}
              className="w-full flex items-center justify-between px-5 py-4 cursor-pointer"
            >
              <div>
                <h3 className="font-[var(--font-hp-hero)] font-black uppercase text-white text-left" style={{ fontSize: "18px" }}>
                  Extra Frames &mdash; A La Carte Items
                </h3>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-1 text-left">
                  Platters, appetizers, pizzas, desserts & more
                </p>
              </div>
              <svg
                className="w-6 h-6 flex-shrink-0 transition-transform ml-4"
                style={{
                  color: coral,
                  transform: extrasOpen ? "rotate(180deg)" : "rotate(0deg)",
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
              className="overflow-hidden transition-all duration-500"
              style={{
                maxHeight: extrasOpen ? "3000px" : "0px",
                opacity: extrasOpen ? 1 : 0,
              }}
            >
              <div className="border-t border-white/10 overflow-x-auto">
                <table className="w-full text-left font-[var(--font-hp-body)] text-sm" style={{ minWidth: "480px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "rgba(18,48,117,0.5)" }}>
                      <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Item</th>
                      <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Price</th>
                      <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extraFrames.map((item, i) => (
                      <tr
                        key={item.name}
                        style={{ backgroundColor: i % 2 === 0 ? "rgba(10,22,40,0.6)" : "rgba(10,22,40,0.3)" }}
                      >
                        <td className="px-4 py-2.5 text-white/80">{item.name}</td>
                        <td className="px-4 py-2.5 font-semibold" style={{ color: purple }}>{item.price}</td>
                        <td className="px-4 py-2.5 text-white/40 text-xs">{item.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Beverages */}
          <h3
            className="font-[var(--font-hp-hero)] font-black uppercase text-white text-center mt-12 mb-6"
            style={{ fontSize: "clamp(22px, 5vw, 36px)", textShadow: glowCoral }}
          >
            Beverages
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-6">
            {beverages.map((cat) => (
              <div key={cat.category} className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] p-5">
                <h4
                  className="font-[var(--font-hp-hero)] font-black uppercase text-white mb-4"
                  style={{ fontSize: "14px", letterSpacing: "1px" }}
                >
                  {cat.category}
                </h4>
                <div className="space-y-3">
                  {cat.items.map((item) => (
                    <div key={item.name} className="flex justify-between items-baseline gap-2">
                      <span className="font-[var(--font-hp-body)] text-white/60 text-xs leading-snug">{item.name}</span>
                      <span className="font-[var(--font-hp-body)] font-bold text-xs flex-shrink-0" style={{ color: coral }}>
                        {item.price}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="font-[var(--font-hp-body)] text-white/30 text-center text-xs">
            All liquor single pour only. Shots and beer buckets not included in drink tickets.
          </p>
        </div>
      </section>

      {/* ====== 9. FAQ ACCORDION ====== */}
      <section className="bg-[#0a1628]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
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
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/cta-wide.webp"
          alt="HeadPinz bowling panoramic"
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
          style={{ backgroundColor: "rgba(10,22,40,0.9)" }}
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
              src="https://www.cognitoforms.com/f/u3qiZTtd8UeGo_mV4yHewA/21"
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
