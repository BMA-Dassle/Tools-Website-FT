import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";

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
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "32px", textShadow: glowShadow }}
            >
              FastTrax Pricing
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
              {/* Racing License Card */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(228,28,29)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  the FastTrax Racing License
                </h3>
                <p className="font-[var(--font-anton)] text-white uppercase" style={{ fontSize: "30px", letterSpacing: "1.5px", marginBottom: "12px" }}>
                  $4.99
                </p>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5", marginBottom: "16px" }}>
                  Required for all racers. Valid for one year. Includes your head/neck protector, a free race during your birthday month, and access to your stats in the FastTrax Racing App.
                </p>
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center font-[var(--font-poppins)] font-semibold uppercase text-white transition-all hover:scale-105"
                  style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Get your licence
                </a>
              </div>

              {/* Spring Break Pass Card */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(0,74,173)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(0,74,173)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  FastTrax Spring Break Pass
                </h3>
                <p className="font-[var(--font-anton)] text-white uppercase" style={{ fontSize: "30px", letterSpacing: "1.5px", marginBottom: "12px" }}>
                  $124.95
                </p>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5", marginBottom: "8px" }}>
                  Valid: Monday–Friday (March 16th–20th) + Bonus Day: Friday, March 13th.
                </p>
                <ul className="font-[var(--font-poppins)] list-disc list-inside mb-4" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li>1 Race Per Day</li>
                  <li>1 Nexus Gel Blaster Entry Per Day</li>
                  <li>25% OFF any additional races purchased.</li>
                </ul>
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center font-[var(--font-poppins)] font-semibold uppercase text-white transition-all hover:scale-105"
                  style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Get your pass
                </a>
              </div>
            </div>

            {/* Disclaimer */}
            <p className="font-[var(--font-poppins)] italic" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.6" }}>
              Disclaimer: App booking required. Races must be booked the day before to guarantee your heat. Additional discounted races must be used by the pass holder only.
            </p>
          </div>

          {/* Right column: image */}
          <div className="flex-1 relative hidden lg:block" style={{ minHeight: "clamp(300px, 60vw, 600px)", borderRadius: "16px", overflow: "hidden" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-karts.webp"
              alt="FastTrax karts"
              fill
              className="object-cover"
              sizes="50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: Racing Rates Table ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(40px, 8vw, 70px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
          >
            Racing Rates
          </h2>
          <p
            className="text-center mx-auto mb-10 font-[var(--font-poppins)]"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6" }}
          >
            Prices are per-person, per-heat.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full max-w-4xl mx-auto" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Kart Class", "Mon - Thu", "Frid-Sun", "Tuesday(Mega Track)"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 font-[var(--font-poppins)]"
                      style={{ fontSize: "16px", color: "rgba(255,255,255,0.96)", backgroundColor: "rgba(134,82,255,0.72)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Adult Karting (13+ / 59&quot;+)
                  </td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$26.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                </tr>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Junior Karting (7-12 / 49&quot;+)
                  </td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$15.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$19.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$20.99</td>
                </tr>
                <tr style={{ backgroundColor: "rgba(7,16,39,0.6)" }}>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>
                    Mini Karts (Ages 3-6)
                  </td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$9.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>$14.99</td>
                  <td className="px-5 py-4 font-[var(--font-poppins)]" style={{ fontSize: "16px", color: "rgb(255,255,255)" }}>N/A</td>
                </tr>
              </tbody>
            </table>
          </div>
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
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: glowShadow }}
          >
            FastTrax: The 63,000 Sq. Ft. Racing Hub
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Game Zone Card */}
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(228,28,29,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06445.webp" alt="The Game Zone" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div style={{ padding: "24px 20px" }}>
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  The Game Zone (Arcade)
                </h3>
                <ul className="font-[var(--font-poppins)] list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong>Tap-to-Play:</strong> Load any amount onto a FastTrax Game Card at our kiosks.</li>
                  <li><strong>Redemption:</strong> Win tickets and trade them for prizes at the Winner&apos;s Circle.</li>
                </ul>
              </div>
            </div>

            {/* Duckpin Bowling Card */}
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(0,74,173,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC00281.webp" alt="Duckpin Bowling" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div style={{ padding: "24px 20px" }}>
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(0,74,173)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Duckpin Bowling
                </h3>
                <ul className="font-[var(--font-poppins)] list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
                  <li><strong>Per Hour:</strong> $35.00</li>
                  <li><strong>No Rental Shoes Required!</strong> Bowl in your own clean, closed-toe shoes.</li>
                </ul>
              </div>
            </div>

            {/* Shuffly Card */}
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgba(228,28,29,0.59)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div className="relative" style={{ height: "clamp(160px, 30vw, 240px)" }}>
                <Image src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly.webp" alt="Shuffly" fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
              </div>
              <div style={{ padding: "24px 20px" }}>
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  Shuffly (Shuffleboard)
                </h3>
                <ul className="font-[var(--font-poppins)] list-disc list-inside" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.8" }}>
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
          <div className="flex-1 relative hidden lg:block" style={{ minHeight: "clamp(300px, 60vw, 600px)", borderRadius: "16px", overflow: "hidden" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-combos.webp"
              alt="FastTrax racing"
              fill
              className="object-cover"
              sizes="50vw"
            />
          </div>

          {/* Right column: heading + how to book + combo cards */}
          <div style={{ flex: "0 0 54%" }}>
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
            >
              fastTrax Combos
            </h2>
            <p
              className="font-[var(--font-poppins)] mb-8"
              style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6" }}
            >
              <strong>How to Book:</strong> To secure combo pricing, book your racing heat first through the website or app, then select these attractions as add-ons during the checkout process.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* The Apex Combo */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(228,28,29)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-4" style={{ color: "rgb(228,28,29)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  The Apex Combo
                </h3>
                <ul className="font-[var(--font-anton)] uppercase mb-6" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "2", letterSpacing: "0.8px" }}>
                  <li>2 Adult Racing Heats</li>
                  <li>$10 Game Card</li>
                </ul>
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center font-[var(--font-poppins)] font-semibold uppercase text-white transition-all hover:scale-105"
                  style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Get your combo
                </a>
              </div>

              {/* The Speed & Social Combo */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(0,74,173)",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-4" style={{ color: "rgb(0,74,173)", fontSize: "24px", letterSpacing: "1.2px" }}>
                  The Speed &amp; Social Combo
                </h3>
                <ul className="font-[var(--font-anton)] uppercase mb-6" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "2", letterSpacing: "0.8px" }}>
                  <li>1 Adult Racing Heat</li>
                  <li>1 Hour of Duckpin Bowling</li>
                  <li>$20 Game Card</li>
                </ul>
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center font-[var(--font-poppins)] font-semibold uppercase text-white transition-all hover:scale-105"
                  style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
                >
                  Get your combo
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Bottom CTA ── */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(400px, 70vh, 580px)" }}>
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
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "24px", textShadow: glowShadow }}
          >
            THE RACER&apos;S JOURNEY ARRIVE TO DRIVE
          </h2>
          <a
            href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white transition-all hover:scale-105"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
          >
            SECURE YOUR HEAT
          </a>
        </div>
      </section>
    </>
  );
}
