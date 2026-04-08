import type { Metadata } from "next";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";
import BookingLink from "@/components/BookingLink";

export const metadata: Metadata = {
  title: "Go-Kart Racing Prices, Combos & Packages – FastTrax Fort Myers",
  description:
    "FastTrax go-kart racing rates: Adults from $20.99, Juniors from $15.99, Mini Karts from $9.99. Combo deals with gel blaster, bowling & arcade. Cheaper than Topgolf, more thrilling than Dave & Buster's. Book online at Fort Myers' best entertainment value.",
  keywords: [
    "go kart prices Fort Myers",
    "indoor go kart cost",
    "FastTrax pricing",
    "go kart racing deals Fort Myers",
    "cheap go karts Fort Myers",
    "family entertainment deals Fort Myers",
    "birthday party packages Fort Myers",
    "combo deals Fort Myers entertainment",
    "karting rates",
    "bowling prices Fort Myers",
    "arcade prices Fort Myers",
    "group rates Fort Myers",
    "things to do Fort Myers cheap",
    "affordable family fun Fort Myers",
  ],
  openGraph: {
    title: "Racing Prices & Combo Packages – FastTrax Fort Myers",
    description:
      "Go-kart racing from $20.99/heat. Combo deals with gel blaster, bowling & arcade. Book online and save at Fort Myers' top entertainment venue.",
    type: "website",
    url: "https://fasttraxent.com/pricing",
  },
  alternates: {
    canonical: "https://fasttraxent.com/pricing",
  },
};

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

export default function PricingPage() {
  return (
    <>
      <SubpageHero
        title="FastTrax Pricing & Combos"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-hero.webp"
      />

      {/* ── Section: FastTrax Pricing (2-col: cards left, image right) ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-16 items-center">
          {/* Left column: heading + promo cards + disclaimer */}
          <div className="flex-1">
            <h2
              className="font-heading italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "32px", textShadow: glowShadow }}
            >
              FastTrax Pricing
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
              {/* Racing License Card */}
              <div
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(228,28,29)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-heading uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  the FastTrax Racing License
                </h3>
                <p className="font-heading text-white uppercase" style={{ fontSize: "30px", letterSpacing: "1.5px", marginBottom: "12px" }}>
                  $4.99
                </p>
                <p className="font-body flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5", marginBottom: "16px" }}>
                  Required for all racers. Valid for one year. Includes your head/neck protector, a free race during your birthday month, and access to your stats in the FastTrax Racing App.
                </p>
                <BookingLink
                  href="/book/race"
                  className="block text-center font-body font-semibold uppercase text-white transition-all hover:scale-105"
                  style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Get your licence
                </BookingLink>
              </div>

              {/* $10 Add-On Deal Card */}
              <div
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(134,82,255)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-heading uppercase mb-3" style={{ color: "rgb(134,82,255)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  $10 Race Day Add-Ons
                </h3>
                <p className="font-body mb-4" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5" }}>
                  Add more fun when you book a race — just $10 more!
                </p>
                <ul className="font-body list-disc list-inside mb-4 flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong style={{ color: "rgb(134,82,255)" }}>Nexus Gel Blaster Arena</strong> — $10 per person (at HeadPinz)</li>
                  <li><strong style={{ color: "rgb(0,74,173)" }}>Shuffly</strong> — $10 per group (at FastTrax)</li>
                </ul>
                <BookingLink
                  href="/book/race"
                  className="block text-center font-body font-semibold uppercase text-white transition-all hover:scale-105 mt-auto"
                  style={{ backgroundColor: "rgb(134,82,255)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Book Race + Add-On
                </BookingLink>
              </div>
            </div>

            {/* Disclaimer */}
            <p className="font-body italic" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.6" }}>
              Disclaimer: App booking required. Races must be booked the day before to guarantee your heat. Add-on pricing applies when booked with a race.
            </p>
          </div>

          {/* Right column: image */}
          <div className="flex-1 relative w-full lg:w-auto" style={{ minHeight: "clamp(180px, 30vw, 600px)", borderRadius: "16px", overflow: "hidden" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-karts.webp"
              alt="FastTrax karts"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: Racing Rates Table ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(40px, 8vw, 70px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-heading italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
          >
            Racing Rates
          </h2>
          <p
            className="text-center mx-auto mb-10 font-body"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6" }}
          >
            Prices are per-person, per-heat.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full max-w-4xl mx-auto" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Kart Class", "Mon–Thu", "Fri–Sun", "Tuesday (Mega Track)"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 font-body"
                      style={{ fontSize: "16px", color: "rgba(255,255,255,0.96)", backgroundColor: "rgba(134,82,255,0.72)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Adult Karting (13+ / 59&quot;+)
                  </td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$26.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                </tr>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Junior Karting (7-12 / 49&quot;+)
                  </td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$15.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$19.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                </tr>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)" }}>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Mini Karts (Ages 4-6)
                  </td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$9.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$14.99</td>
                  <td className="px-5 py-4 font-body" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>N/A</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Section: Race Packs ── */}
      <section style={{ backgroundColor: "#000418", padding: "clamp(48px, 8vw, 80px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-10">
            <h2
              className="font-heading italic uppercase text-white"
              style={{ fontSize: "clamp(28px, 6vw, 48px)", lineHeight: "1.1", letterSpacing: "2px", textShadow: glowShadow }}
            >
              Race Packs — Save More, Race More
            </h2>
            <p className="font-body mt-3 max-w-lg mx-auto" style={{ color: "rgba(245,236,238,0.5)", fontSize: "15px" }}>
              Buy race credits in bulk and use them anytime. Credits load instantly to your account.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
            {[
              { name: "3-Race Pack", weekday: "$49.99", anytime: "$59.99", perRace: "$16.66", save: "Save up to 17%" },
              { name: "5-Race Pack", weekday: "$79.99", anytime: "$99.99", perRace: "$16.00", save: "Save up to 20%" },
              { name: "10-Race Pack", weekday: "$159.99", anytime: "$199.99", perRace: "$16.00", save: "Best Value" },
            ].map((pack) => (
              <div
                key={pack.name}
                className="rounded-2xl border p-6 flex flex-col gap-3 text-center"
                style={{ backgroundColor: "rgba(0,226,229,0.04)", borderColor: "rgba(0,226,229,0.2)" }}
              >
                <p className="font-heading uppercase text-white" style={{ fontSize: "24px", letterSpacing: "1.5px" }}>
                  {pack.name}
                </p>
                <div className="flex justify-center gap-4">
                  <div>
                    <p className="font-body text-white/40 text-xs uppercase tracking-wider">Mon–Thu</p>
                    <p className="font-body text-white font-bold text-lg">{pack.weekday}</p>
                  </div>
                  <div className="w-px bg-white/10" />
                  <div>
                    <p className="font-body text-white/40 text-xs uppercase tracking-wider">Anytime</p>
                    <p className="font-body font-bold text-lg" style={{ color: "#00E2E5" }}>{pack.anytime}</p>
                  </div>
                </div>
                <p className="font-body text-xs" style={{ color: "rgba(0,226,229,0.6)" }}>
                  From {pack.perRace}/race · {pack.save}
                </p>
              </div>
            ))}
          </div>

          <div className="text-center mt-8">
            <a
              href="/book/race-packs"
              className="inline-block font-body font-semibold uppercase text-[#000418] tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "#00E2E5", borderRadius: "555px", padding: "16px 48px", fontSize: "14px" }}
            >
              Buy Race Packs
            </a>
          </div>
        </div>
      </section>

      {/* ── Section: Race Requirements Callout ── */}
      <section className="bg-[#000418]" style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div
          className="max-w-3xl mx-auto text-center"
          style={{
            backgroundColor: "rgba(7,16,39,0.5)",
            border: "1.78px dashed rgba(255,193,7,0.5)",
            borderRadius: "12px",
            padding: "32px 24px",
          }}
        >
          <p
            className="font-body"
            style={{ color: "rgb(255,193,7)", fontSize: "18px", fontWeight: 600, marginBottom: "8px" }}
          >
            Age, Height &amp; Qualification Requirements
          </p>
          <p
            className="font-body mb-6"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.6" }}
          >
            All racers must meet specific age and height requirements. Check race types, qualification lap times, and kart classes before you book.
          </p>
          <a
            href="/racing"
            className="inline-block font-body font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
          >
            View Race Requirements
          </a>
        </div>
      </section>

      {/* ── Section: FastTrax 63K Racing Hub (Activities) ── */}
      <section className="relative overflow-hidden" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto">
          <h2
            className="font-heading italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowShadow }}
          >
            FastTrax: The 63,000 Sq. Ft. Racing Hub
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Game Zone Card */}
            <div
              className="flex flex-col"
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(228,28,29,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative flex-shrink-0" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06445.webp" alt="The Game Zone" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div className="flex-1" style={{ padding: "24px 20px" }}>
                <h3 className="font-heading uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  The Game Zone (Arcade)
                </h3>
                <ul className="font-body list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong>Tap-to-Play:</strong> Load any amount onto a FastTrax Game Card at our kiosks.</li>
                  <li><strong>Redemption:</strong> Win tickets and trade them for prizes at the Winner&apos;s Circle.</li>
                </ul>
              </div>
            </div>

            {/* Duckpin Bowling Card */}
            <div
              className="flex flex-col"
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(0,74,173,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative flex-shrink-0" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00281.webp" alt="Duckpin Bowling" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div className="flex-1" style={{ padding: "24px 20px" }}>
                <h3 className="font-heading uppercase mb-3" style={{ color: "rgb(0,74,173)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Duckpin Bowling
                </h3>
                <ul className="font-body list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong>Per Hour:</strong> $35.00</li>
                  <li><strong>No Rental Shoes Required!</strong> Bowl in your own clean, closed-toe shoes.</li>
                </ul>
              </div>
            </div>

            {/* Shuffly Card */}
            <div
              className="flex flex-col"
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(228,28,29,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative flex-shrink-0" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly.webp" alt="Shuffly" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div className="flex-1" style={{ padding: "24px 20px" }}>
                <h3 className="font-heading uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Shuffly (Shuffleboard)
                </h3>
                <ul className="font-body list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong>Per Hour:</strong> $35.00</li>
                  <li>High-tech social gaming for up to 4 players per table.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: FastTrax Combos (2-col: image left, text+cards right) ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8 flex flex-col lg:flex-row gap-16 items-center">
          {/* Left column: image */}
          <div className="flex-1 relative w-full lg:w-auto" style={{ minHeight: "clamp(180px, 30vw, 600px)", borderRadius: "16px", overflow: "hidden" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-combos.webp"
              alt="FastTrax racing"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>

          {/* Right column: heading + how to book + combo cards */}
          <div style={{ flex: "0 0 54%" }}>
            <h2
              className="font-heading italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
            >
              fastTrax Combos
            </h2>
            <p
              className="font-body mb-8"
              style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6" }}
            >
              <strong>How to Book:</strong> To secure combo pricing, book your racing heat first through the website or app, then select these attractions as add-ons during the checkout process.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Gel Blaster Add-On */}
              <div
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(228,28,29)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-heading uppercase mb-4" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Race + Gel Blaster
                </h3>
                <p className="font-body mb-4" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.6" }}>
                  Add HeadPinz Nexus Gel Blaster Arena to any race for just <strong className="text-white">$10 more per person</strong>. Select it as an add-on during checkout.
                </p>
                <ul className="font-heading uppercase mb-6 flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "2", letterSpacing: "0.8px" }}>
                  <li>Any Racing Heat</li>
                  <li>+ Gel Blaster Entry ($10/person)</li>
                </ul>
                <BookingLink
                  href="/book/race"
                  className="block text-center font-body font-semibold uppercase text-white transition-all hover:scale-105 mt-auto"
                  style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Book Race + Gel Blaster
                </BookingLink>
              </div>

              {/* Intermediate Upgrade Tip */}
              <div
                className="flex flex-col h-full"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(0,74,173)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-heading uppercase mb-4" style={{ color: "rgb(0,74,173)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Pro Tip: Save on Intermediate
                </h3>
                <p className="font-body mb-4" style={{ color: "rgba(245,236,238,0.8)", fontSize: "15px", lineHeight: "1.6" }}>
                  Already qualified for Intermediate speeds? Book your next Intermediate heat while you&apos;re still booking a Starter race and <strong className="text-white">save on the upgrade</strong>. Stack your heats during checkout for the best deal.
                </p>
                <ul className="font-heading uppercase mb-6 flex-1" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "2", letterSpacing: "0.8px" }}>
                  <li>Book Starter + Intermediate Together</li>
                  <li>Save on Intermediate Pricing</li>
                </ul>
                <BookingLink
                  href="/book/race"
                  className="block text-center font-body font-semibold uppercase text-white transition-all hover:scale-105 mt-auto"
                  style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Book Your Heats
                </BookingLink>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Gift Cards ── */}
      <section style={{ backgroundColor: "#000418", padding: "clamp(48px, 8vw, 80px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-4xl mx-auto text-center">
          <h2
            className="font-heading italic uppercase text-white"
            style={{ fontSize: "clamp(28px, 6vw, 48px)", lineHeight: "1.1", letterSpacing: "2px", textShadow: glowShadow }}
          >
            Give the Gift of Speed
          </h2>
          <p className="font-body mt-3 max-w-lg mx-auto" style={{ color: "rgba(245,236,238,0.5)", fontSize: "15px" }}>
            FastTrax gift cards are perfect for birthdays, holidays, or just because. Available in any amount — use them for racing, add-ons, dining, and more.
          </p>
          <a
            href="https://squareup.com/gift/2Z728TECCNWSE/order"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-body font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 mt-8"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 48px", fontSize: "14px" }}
          >
            Buy a Gift Card
          </a>
        </div>
      </section>

      {/* ── Section: Bottom CTA ── */}
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
            className="font-heading italic uppercase text-white"
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
          <BookingLink
            href="/book/race"
            className="inline-block font-body font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{
              backgroundColor: "rgb(228,28,29)",
              borderRadius: "555px",
              padding: "20px 48px",
              fontSize: "16px",
            }}
          >
            BOOK NOW
          </BookingLink>
        </div>
      </section>
    </>
  );
}
