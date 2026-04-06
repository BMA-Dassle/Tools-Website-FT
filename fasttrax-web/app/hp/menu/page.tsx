"use client";

import { useState } from "react";
import Image from "next/image";

/* ------------------------------------------------------------------ */
/*  Brand tokens                                                       */
/* ------------------------------------------------------------------ */

const coral = "#fd5b56";
const HAPPY_HOUR_PDF = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/documents/nemos-happy-hour.pdf";
const gold = "#FFD700";
const cyan = "#00E2E5";

/* ------------------------------------------------------------------ */
/*  Menu data (extracted from Nemo's Sports Bistro 2025 menu)          */
/* ------------------------------------------------------------------ */

type MenuItem = { name: string; desc?: string; price?: string };
type MenuSection = { name: string; note?: string; accent: string; items: MenuItem[] };

const menuSections: MenuSection[] = [
  {
    name: "Nemo's Wings",
    note: "10 jumbo bone-in wings made with our secret seasoned flour and fried to perfection, served with choice of sauce. All flats or drums +4",
    accent: coral,
    items: [
      { name: "All to Yourself", price: "14" },
      { name: "Out with a Friend", desc: "25 wings", price: "25" },
      { name: "Party Time", desc: "50 wings", price: "45" },
    ],
  },
  {
    name: "Wings & Things",
    note: "5 jumbo breaded bone-in wings served with cut fries. All flat or drum +2",
    accent: coral,
    items: [
      { name: "Wings & Things Combo", price: "12" },
    ],
  },
  {
    name: "Boneless Wings",
    note: "Hand cut then breaded and fried to perfection, served on a bed of cut fries",
    accent: coral,
    items: [
      { name: "All to Yourself", price: "14" },
      { name: "Out with a Friend", price: "25" },
      { name: "Party Time", price: "45" },
    ],
  },
  {
    name: "Nemo's Pizza",
    note: "Choice of sauce: red sauce, white garlic, BBQ, buffalo",
    accent: gold,
    items: [
      { name: "Classic Cheese", desc: 'Personal 5" / 18" / 29"', price: "9 / 18" },
      { name: "Margherita", desc: 'Personal / 18"', price: "11 / 22" },
      { name: "Meatlovers", desc: 'Personal / 18"', price: "12 / 24" },
      { name: "Veggie", desc: 'Personal / 18"', price: "11 / 22" },
      { name: "Supreme", desc: 'Personal / 18"', price: "12 / 24" },
      { name: "Gluten Free Cheese", price: "13" },
      { name: 'Colossal 29" Pizza', desc: "Not available on Sunday", price: "49" },
    ],
  },
  {
    name: "Nemo's Burgers",
    note: "Served with your choice of cut fries, waffle fries, or coleslaw. House or Caesar salad +4.5, onion rings +1.5",
    accent: coral,
    items: [
      { name: "Nemo's Classic Burger", desc: "Hand crafted choice ground beef, cooked to your liking, topped with lettuce, tomato and red onion", price: "14" },
      { name: "Nemo's Smashburger", desc: "Topped with lettuce, tomato and red onion", price: "12" },
      { name: "Jalapeno Cheddar Smashburger", desc: "Topped with fried jalapenos, cheddar cheese and finished with jalapeno ranch", price: "12" },
      { name: "Mushroom Swiss Smashburger", desc: "Topped with grilled mushrooms and melted Swiss cheese", price: "12" },
      { name: "Smokehouse Smashburger", desc: "Topped with BBQ sauce, cheddar, peppered smoked bacon and finished with a fried onion ring", price: "13" },
      { name: "The Hangover Smashburger", desc: "Topped with a fried egg sunny side up, American cheese and peppered smoked bacon", price: "14" },
    ],
  },
  {
    name: "Shareables",
    accent: cyan,
    items: [
      { name: "Nemo's Macho Nachos", desc: "A mound of freshly fried tri-colored tortilla chips topped with chili, house-made queso, shredded lettuce, diced tomato and red onion", price: "15" },
      { name: "Meatball Sliders", desc: "Beef and pork meatballs slow simmered in marinara sauce, smothered in melted provolone cheese, served with garlic bread", price: "14" },
      { name: "Fried Pickles", desc: "Battered and fried to perfection pickle fries served with jalapeno ranch", price: "9" },
      { name: "Nemo's Chips & Queso", desc: "Freshly fried house-made tortilla chips served with house-made queso", price: "9.5" },
      { name: "Bavarian Pretzel Sticks", desc: "Fresh soft pretzel sticks served with warm cheese", price: "10" },
      { name: "Mozzarella Sticks", desc: "Battered and fried to perfection served with house marinara", price: "10" },
      { name: "Loaded Fries", desc: "Golden waffle fries covered in queso with peppered smoked bacon and scallions", price: "11" },
      { name: "Chicken Teriyaki Potstickers", desc: "Pan-fried chicken & cabbage potstickers finished with a sweet teriyaki sauce", price: "10" },
      { name: "Shrimp Manuelo", desc: "Large shrimp fried to perfection then tossed in boom boom sauce, topped with scallions", price: "13.5" },
      { name: "Mac & Cheese Bites", desc: "Battered and fried to perfection served with house garlic sauce", price: "9" },
      { name: "Chicken Tenders", desc: "Battered and fried to perfection", price: "12" },
      { name: "Quesadilla", desc: "Flour tortilla with cheddar jack cheese, served with shredded lettuce, salsa and sour cream", price: "11" },
    ],
  },
  {
    name: "Handhelds",
    note: "Served with choice of cut fries, waffle fries, coleslaw. House or Caesar salad +4.5, onion rings +1.5",
    accent: gold,
    items: [
      { name: "Nashville Hot Chicken Sandwich", desc: "Fried or grilled chicken tossed in Nashville hot sauce with lettuce, served on a bun", price: "13.5" },
      { name: "Meatball Sub", desc: "Beef and pork meatballs slow simmered in marinara sauce, smothered in melted provolone on a hoagie roll", price: "14" },
      { name: "BBQ Pulled Pork", desc: "Slow smoked pork smothered in BBQ sauce topped with coleslaw served on a bun", price: "13" },
      { name: "Grilled Hot Dog", desc: "All beef hot dog grilled to perfection", price: "9" },
      { name: "Classic Cuban", desc: "Slow-cooked hand pulled pork, sweet ham with Swiss cheese, mustard and dill pickles, served hot & pressed", price: "12.5" },
      { name: "Nemos Club", desc: "Oven roasted turkey breast, lettuce, tomato, bacon and mayo piled high between 3 pieces of toasted thick cut white bread", price: "13.5" },
      { name: "BLT", desc: "8 strips of applewood smoked bacon, lettuce, tomato and mayo on toasted thick cut white bread", price: "11.5" },
      { name: "Cheesesteak", desc: "Thinly sliced steak with grilled onions, mushrooms and peppers smothered in melted provolone cheese", price: "14.5" },
    ],
  },
  {
    name: "Wraps",
    note: "All wraps served with crispy tortilla chips and salsa",
    accent: gold,
    items: [
      { name: "Chicken Caesar Wrap", desc: "With fresh romaine lettuce in a creamy Caesar dressing with shaved parmesan", price: "12" },
      { name: "Buffalo Chicken Wrap", desc: "Tossed in buffalo sauce with lettuce, tomato, and cheddar jack cheese", price: "12" },
      { name: "Boom Boom Shrimp Wrap", desc: "Tossed in boom boom sauce with lettuce, tomato and cheddar jack cheese", price: "14" },
    ],
  },
  {
    name: "Salads",
    accent: cyan,
    items: [
      { name: "House Salad", desc: "Crisp romaine lettuce topped with croutons, tomatoes, shredded red onion, cheddar jack cheese and choice of dressing", price: "9.5" },
      { name: "Caesar Salad", desc: "Crisp romaine tossed in a creamy Caesar dressing topped with shaved parmesan and croutons", price: "10.5" },
      { name: "Chili Taco Salad", desc: "Fried tortilla bowl filled with chili, romaine, lettuce, cheddar jack, diced tomato, sour cream, served with side of salsa", price: "14" },
    ],
  },
  {
    name: "Kids Menu",
    note: "12 & under, served with 12oz soft drink & cut fries",
    accent: coral,
    items: [
      { name: "Hamburger", desc: "Quarter pound burger", price: "8" },
      { name: "Grilled Cheese", desc: "Melted American cheese between 2 slices of buttered white bread", price: "8" },
      { name: "Hot Dog", desc: "All beef hot dog", price: "8" },
      { name: "Chicken Tenders", desc: "2 fried chicken tenders with dipping sauce", price: "10.5" },
      { name: "Chicken Bites", desc: "Fried chicken bites", price: "8.5" },
    ],
  },
  {
    name: "Desserts",
    accent: gold,
    items: [
      { name: "Triple Chocolate Brownie Sundae", desc: "Warm brownie topped with vanilla ice cream, whipped cream, caramel and chocolate drizzle", price: "8.5" },
      { name: "Ice Cream Sundae", desc: "Vanilla ice cream with your choice of toppings", price: "4.5" },
    ],
  },
  {
    name: "Side Bar",
    accent: cyan,
    items: [
      { name: "1/2 lb cut or waffle fries", price: "5" },
      { name: "1 lb cut or waffle fries", price: "7" },
      { name: "Cup of Chili", price: "5" },
      { name: "Side House or Caesar Salad", price: "5" },
      { name: "Coleslaw", price: "3" },
      { name: "Onion Rings", price: "6.5" },
    ],
  },
];

const lunchSpecials: MenuItem[] = [
  { name: "Chicken Caesar Salad", price: "9" },
  { name: "Roasted Turkey", desc: "Homemade chicken salad with toppings", price: "9" },
  { name: "Ham & Swiss", desc: "Thin sliced ham, Swiss cheese", price: "8" },
  { name: "Chopped Italian Sub", desc: "Ham, salami, peppers with oil & vinegar", price: "8" },
];

const categories = ["All", "Wings", "Pizza", "Burgers", "Shareables", "Handhelds", "Wraps", "Salads", "Kids", "Desserts", "Sides"];

function getCategoryForSection(name: string): string {
  if (name.includes("Wing")) return "Wings";
  if (name.includes("Pizza")) return "Pizza";
  if (name.includes("Burger")) return "Burgers";
  if (name.includes("Shareable")) return "Shareables";
  if (name.includes("Handhelds")) return "Handhelds";
  if (name.includes("Wrap")) return "Wraps";
  if (name.includes("Salad")) return "Salads";
  if (name.includes("Kids")) return "Kids";
  if (name.includes("Dessert")) return "Desserts";
  if (name.includes("Side")) return "Sides";
  return "All";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function MenuPage() {
  const [activeCategory, setActiveCategory] = useState("All");
  const [showHappyHourPdf, setShowHappyHourPdf] = useState(false);

  const filtered = activeCategory === "All"
    ? menuSections
    : menuSections.filter((s) => getCategoryForSection(s.name) === activeCategory);

  return (
    <div className="bg-[#0a1628]">
      {/* ====== HERO ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "60vh" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-bar-hero.jpg"
          alt="Nemo's Sports Bistro - Cheers at the bar"
          fill
          className="object-cover"
          sizes="100vw"
          priority
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/40 to-[#0a1628]" />

        <div
          className="relative z-10 flex flex-col items-center justify-center text-center px-4"
          style={{ minHeight: "60vh" }}
        >
          {/* Nemo's logo */}
          <div className="relative mb-4" style={{ width: "clamp(100px, 20vw, 160px)", height: "clamp(100px, 20vw, 160px)" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-logo.png"
              alt="Nemo's Sports Bistro"
              fill
              className="object-contain"
              sizes="160px"
              unoptimized
            />
          </div>

          <h1
            className="font-[var(--font-hp-hero)] font-black uppercase text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 64px)",
              lineHeight: "1.05",
              letterSpacing: "-1px",
              marginBottom: "12px",
              textShadow: `0 0 40px ${coral}35`,
            }}
          >
            Nemo&apos;s Sports Bistro
          </h1>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm max-w-md mx-auto">
            Fresh cooked pizza, famous jumbo wings, burgers, handhelds &amp; more. Pair it with craft beers, cocktails, or signature mocktails.
          </p>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      </section>

      {/* ====== FREE WING FRIDAY ====== */}
      <section style={{ padding: "clamp(32px, 6vw, 56px) clamp(16px, 4vw, 32px) 0" }}>
        <div className="max-w-5xl mx-auto">
          <div
            className="rounded-2xl overflow-hidden relative"
            style={{ border: `1.78px dashed ${coral}50` }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2">
              {/* Wings image */}
              <div className="relative" style={{ minHeight: "clamp(220px, 40vw, 360px)" }}>
                <Image
                  src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png"
                  alt="Free Wing Friday - 5 free wings"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
                <div className="absolute top-4 left-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest bg-[#fd5b56] text-white px-3 py-1.5 rounded-full animate-pulse shadow-lg">
                    New!
                  </span>
                </div>
              </div>
              {/* Details */}
              <div className="p-6 md:p-8 flex flex-col justify-center" style={{ backgroundColor: "rgba(253,91,86,0.08)" }}>
                <h2
                  className="font-[var(--font-hp-hero)] font-black uppercase text-white"
                  style={{ fontSize: "clamp(26px, 5vw, 40px)", lineHeight: "1.05", textShadow: `0 0 30px ${coral}30` }}
                >
                  Free Wing Friday
                </h2>
                <p className="font-[var(--font-hp-body)] text-white/90 text-base mt-3">
                  Get <strong className="text-[#fd5b56] text-lg">5 FREE Wings</strong> every Friday
                </p>
                <p
                  className="font-[var(--font-hp-display)] uppercase tracking-wider mt-2"
                  style={{ color: coral, fontSize: "clamp(20px, 4vw, 28px)" }}
                >
                  4 &ndash; 6 PM
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm mt-2">
                  With any food or beverage purchase
                </p>
                <div className="flex items-center gap-2 mt-4">
                  <svg className="w-4 h-4 text-[#FFD700] shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  <a href="/hp/rewards" className="font-[var(--font-hp-body)] text-[#FFD700] text-sm font-semibold hover:text-white transition-colors underline underline-offset-2">
                    HeadPinz Rewards Required &mdash; Join Free
                  </a>
                </div>
                <p className="font-[var(--font-hp-body)] text-white/30 text-[10px] mt-4">
                  Dine-in only. Available while supplies last.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====== HAPPY HOUR ====== */}
      <section style={{ padding: "clamp(24px, 4vw, 40px) clamp(16px, 4vw, 32px)" }}>
        <div
          className="max-w-5xl mx-auto rounded-2xl p-6 md:p-8"
          style={{ backgroundColor: "rgba(255,215,0,0.05)", border: `1.78px dashed rgba(255,215,0,0.3)` }}
        >
          <div className="text-center mb-6">
            <h2
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{ fontSize: "clamp(26px, 5vw, 40px)", lineHeight: "1.05", textShadow: `0 0 30px rgba(255,215,0,0.2)` }}
            >
              Happy Hour
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/80 text-base mt-2">
              <strong style={{ color: gold }}>Every Day</strong> &bull;{" "}
              <span className="font-[var(--font-hp-display)] uppercase tracking-wider" style={{ color: gold }}>
                Open &ndash; 6PM
              </span>
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Food Specials */}
            <div>
              <p className="font-[var(--font-hp-display)] uppercase text-white/40 text-[10px] tracking-widest mb-3">Food Specials</p>
              <div className="space-y-2">
                {[
                  { name: "Margherita Flatbread", price: "$10", desc: "Tomato sauce, fresh mozzarella, basil, olive oil drizzle" },
                  { name: "Flatbread of the Month", price: "$12", desc: "Rotating chef-inspired feature" },
                  { name: "Pups & Sliders", price: "$16", desc: "Wagyu beef sliders + mini hot dogs. Add fries +$3" },
                  { name: "The Sampler", price: "$23", desc: "Meatballs, fried calamari, fried mozzarella" },
                  { name: "Garlic Knots", price: "$6", desc: "Garlic butter, parsley, Parmesan. Served with marinara" },
                  { name: "Chicken Wings", price: "$0.99/ea", desc: "Jumbo wings, hand breaded, choice of sauce (increments of 10)" },
                ].map((item) => (
                  <div key={item.name} className="flex justify-between items-start gap-3 py-2" style={{ borderBottom: "1px solid rgba(255,215,0,0.1)" }}>
                    <div>
                      <p className="font-[var(--font-hp-body)] text-white font-semibold text-sm">{item.name}</p>
                      <p className="font-[var(--font-hp-body)] text-white/40 text-[10px]">{item.desc}</p>
                    </div>
                    <span className="font-[var(--font-hp-display)] text-sm shrink-0" style={{ color: gold }}>{item.price}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Drink Specials */}
            <div>
              <p className="font-[var(--font-hp-display)] uppercase text-white/40 text-[10px] tracking-widest mb-3">Drink Specials</p>
              <div className="space-y-2">
                {[
                  { name: "House Wine by the Glass", deal: "$2 Off" },
                  { name: "Island Oasis Frozen Drinks", deal: "$2 Off" },
                  { name: "Rum Buckets", deal: "$2 Off" },
                  { name: "Bloody Mary's", deal: "$2 Off" },
                  { name: "Craft Draft Beers", deal: "$1 Off" },
                  { name: "Spirit-Free Cocktails", deal: "$1 Off" },
                ].map((item) => (
                  <div key={item.name} className="flex justify-between items-center py-2" style={{ borderBottom: "1px solid rgba(255,215,0,0.1)" }}>
                    <p className="font-[var(--font-hp-body)] text-white font-semibold text-sm">{item.name}</p>
                    <span className="font-[var(--font-hp-body)] font-bold text-sm shrink-0" style={{ color: coral }}>{item.deal}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="text-center mt-6">
            <button
              onClick={() => setShowHappyHourPdf(true)}
              className="inline-flex items-center gap-2 font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-full transition-all hover:scale-105 cursor-pointer"
              style={{ backgroundColor: gold, color: "#0a1628", boxShadow: `0 0 16px rgba(255,215,0,0.3)` }}
            >
              View Full Happy Hour Menu
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>
      </section>

      {/* ====== ORDER ONLINE BANNER ====== */}
      <section style={{ padding: "clamp(24px, 4vw, 40px) clamp(16px, 4vw, 32px)" }}>
        <div
          className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 rounded-lg px-6 py-4"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}
        >
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider">
              Order Pickup &amp; Delivery
            </h2>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm">
              Skip the wait &mdash; order ahead for pickup or delivery
            </p>
          </div>
          <a
            href="https://cash.app/order/$headpinzfasttra"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-full transition-all hover:scale-105 whitespace-nowrap"
            style={{ boxShadow: `0 0 16px ${coral}30` }}
          >
            Order Now
          </a>
        </div>
      </section>

      {/* ====== CATEGORY FILTER ====== */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(24px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap justify-center gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className="font-[var(--font-hp-body)] font-bold text-xs uppercase tracking-wider px-4 py-2 rounded-full transition-all cursor-pointer"
                style={{
                  backgroundColor: activeCategory === cat ? coral : "rgba(7,16,39,0.5)",
                  color: activeCategory === cat ? "#fff" : "rgba(255,255,255,0.5)",
                  border: `1.78px solid ${activeCategory === cat ? coral : "rgba(255,255,255,0.1)"}`,
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ====== VIEW FULL MENU CTA ====== */}
      <div className="text-center" style={{ padding: "clamp(16px, 3vw, 24px) clamp(16px, 4vw, 32px)" }}>
        <a
          href="https://cash.app/order/$headpinzfasttra"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 font-[var(--font-hp-body)] text-[#00E2E5] text-sm font-semibold hover:text-white transition-colors underline underline-offset-4"
        >
          View Full Menu &amp; Order Online
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      {/* ====== MENU SECTIONS ====== */}
      <section style={{ padding: "clamp(24px, 4vw, 40px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto space-y-8">
          {filtered.map((section) => (
            <div key={section.name}>
              {/* Section header */}
              <div className="mb-4">
                <h2
                  className="font-[var(--font-hp-display)] uppercase text-white tracking-wider"
                  style={{ fontSize: "clamp(18px, 3.5vw, 26px)", textShadow: `0 0 20px ${section.accent}30` }}
                >
                  {section.name}
                </h2>
                <div className="h-0.5 w-16 rounded-full mt-2" style={{ backgroundColor: section.accent }} />
                {section.note && (
                  <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-2 max-w-lg">
                    {section.note}
                  </p>
                )}
              </div>

              {/* Items */}
              <div className="space-y-1">
                {section.items.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-start justify-between gap-4 py-3 border-b border-white/5"
                  >
                    <div className="flex-1 min-w-0">
                      <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">
                        {item.name}
                      </h3>
                      {item.desc && (
                        <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-0.5 leading-relaxed">
                          {item.desc}
                        </p>
                      )}
                    </div>
                    {item.price && (
                      <span
                        className="font-[var(--font-hp-display)] text-base whitespace-nowrap"
                        style={{ color: section.accent }}
                      >
                        ${item.price}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Lunch Specials — always show unless filtering */}
          {(activeCategory === "All" || activeCategory === "Handhelds") && (
            <div>
              <div className="mb-6">
                <h2
                  className="font-[var(--font-hp-display)] uppercase text-white tracking-wider"
                  style={{ fontSize: "clamp(20px, 4vw, 32px)", textShadow: `0 0 20px ${gold}30` }}
                >
                  Lunch Specials
                </h2>
                <div className="h-0.5 w-16 rounded-full mt-2" style={{ backgroundColor: gold }} />
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-2">
                  11AM &ndash; 3PM Monday &ndash; Friday. All sandwiches served with fresh cooked potato chips. Choice of white, wheat, rye bread or hoagie roll.
                </p>
              </div>

              <div
                className="rounded-lg p-5"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}25` }}
              >
                <div className="space-y-1">
                  {lunchSpecials.map((item) => (
                    <div key={item.name} className="flex items-start justify-between gap-4 py-2 border-b border-white/5 last:border-0">
                      <div className="flex-1">
                        <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">{item.name}</h3>
                        {item.desc && <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-0.5">{item.desc}</p>}
                      </div>
                      {item.price && <span className="font-[var(--font-hp-display)] text-base" style={{ color: gold }}>${item.price}</span>}
                    </div>
                  ))}
                </div>

                <div className="mt-4 pt-3 border-t border-white/10">
                  <p className="font-[var(--font-hp-body)] text-white/50 text-xs font-bold uppercase tracking-wider mb-2">
                    Make It a Combo
                  </p>
                  <div className="flex flex-wrap gap-4 text-xs font-[var(--font-hp-body)] text-white/40">
                    <span>Pizza Slice <span style={{ color: gold }}>+2</span></span>
                    <span>Cheese Slice <span style={{ color: gold }}>+0.5</span></span>
                    <span>2 Slices + Toppings <span style={{ color: gold }}>+3.5</span></span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ====== BOTTOM CTA ====== */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(250px, 40vh, 350px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png"
          alt="Nemo's famous wings"
          fill
          className="object-cover"
          sizes="100vw"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1628] via-black/60 to-black/40" />
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#123075] via-white/60 to-[#fd5b56]" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4" style={{ minHeight: "clamp(250px, 40vh, 350px)" }}>
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white"
            style={{ fontSize: "clamp(24px, 5vw, 44px)", letterSpacing: "3px", marginBottom: "12px", textShadow: `0 0 30px ${coral}30` }}
          >
            Hungry?
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-6 max-w-md mx-auto">
            Order ahead for pickup or delivery, or just come in and grab a seat.
          </p>
          <a
            href="https://cash.app/order/$headpinzfasttra"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
            style={{ boxShadow: `0 0 20px ${coral}30` }}
          >
            Order Now
          </a>
        </div>
      </section>

      {/* ====== HAPPY HOUR PDF MODAL ====== */}
      {showHappyHourPdf && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 py-6" onClick={() => setShowHappyHourPdf(false)}>
          <div className="relative w-full max-w-3xl h-[85vh] bg-[#0a1628] rounded-2xl border border-white/10 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider">Happy Hour Menu</h3>
              <button onClick={() => setShowHappyHourPdf(false)} className="text-white/40 hover:text-white transition-colors p-1 cursor-pointer">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <iframe
              src={HAPPY_HOUR_PDF}
              className="w-full"
              style={{ height: "calc(85vh - 52px)" }}
              title="Happy Hour Menu"
            />
          </div>
        </div>
      )}
    </div>
  );
}
