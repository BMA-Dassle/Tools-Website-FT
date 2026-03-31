import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

export default function MenuPage() {
  return (
    <>
      <SubpageHero
        title="Nemo's Brickyard Bistro"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/nemos-hero.webp"
      />

      {/* ── Section: Intro ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8 flex flex-col lg:flex-row gap-10 items-center">
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
            >
              Artisan Pizza. Italian Tradition. Front-Row Seats
            </h2>
            <p
              className="font-[var(--font-poppins)] mb-8"
              style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
            >
              Experience high-speed excitement paired with authentic Italian flair. Whether you&apos;re cooling down from a Pro-speed heat or fueling up for the Game Zone, Nemo&apos;s is the social heart of the Global Parkway destination.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="#"
                className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
                style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 48px", fontSize: "14px" }}
              >
                ORDER TO-GO NOW
              </a>
              <a
                href="#events"
                className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
                style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 48px", fontSize: "14px" }}
              >
                VIEW UPCOMING EVENTS
              </a>
            </div>
          </div>
          <div className="flex-1 relative rounded-2xl overflow-hidden" style={{ minHeight: "clamp(250px, 50vw, 400px)" }}>
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/nemos-interior.webp"
              alt="Nemo's Brickyard Bistro"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: Brick Oven ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/brick-oven.webp"
          alt="Brick oven"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/95 via-[#000418]/85 to-[#000418]/60" />
        <div className="relative z-10 max-w-7xl mx-auto px-8 flex items-center" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <div style={{ maxWidth: "600px" }}>
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "32px", textShadow: glowShadow }}
            >
              The Star of the Show: Brick Oven Mastery
            </h2>
            <p className="font-[var(--font-poppins)]" style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6" }}>
              At the center of our bistro sits the authentic Brick Oven. Fired at 800&deg;, it delivers the perfect charred, artisan crust that defines true Italian pizza. We use premium ingredients and traditional techniques to bring an elevated dining experience to the trackside lounge.
            </p>
          </div>
        </div>
      </section>

      {/* ── Section: Friday & Saturday Night Entertainment ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: "rgba(255,30,0,0.4) 0px 0px 30px" }}
          >
            Friday &amp; Saturday Night Entertainment
          </h2>

          <div className="flex flex-col lg:flex-row gap-8 items-stretch">
            {/* Left side: Image */}
            <div className="flex-1 relative rounded-2xl overflow-hidden" style={{ minHeight: "clamp(250px, 50vw, 400px)" }}>
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/nemos-entertainment.webp"
                alt="Friday & Saturday Night Entertainment"
                fill
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 50vw"
              />
            </div>

            {/* Right side: Cards stacked vertically */}
            <div className="flex-1 flex flex-col gap-6">
              {/* The Experience Card */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(228,28,29)",
                  borderRadius: "8px",
                  padding: "20px",
                  flex: 1,
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(228,28,29)", fontSize: "30px", letterSpacing: "1.5px" }}>
                  The Experience
                </h3>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgb(245,236,238)", fontSize: "18px", lineHeight: "1.5" }}>
                  Nemo&apos;s is now officially open for Friday &amp; Saturday Night Entertainment. Join us every weekend for live local music, social sets, and a vibrant atmosphere.
                </p>
              </div>

              {/* VIP Viewing Card */}
              <div
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: "1.78px dashed rgb(0,74,173)",
                  borderRadius: "8px",
                  padding: "20px",
                  flex: 1,
                }}
              >
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: "rgb(0,74,173)", fontSize: "30px", letterSpacing: "1.5px" }}>
                  VIP Viewing
                </h3>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgb(245,236,238)", fontSize: "18px", lineHeight: "1.5" }}>
                  Enjoy your meal from our exclusive viewing areas. It&apos;s the best seat in the house to watch karts navigate the technical &apos;Surgical Slow-down&apos; hairpins while you enjoy the music.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: To-Go & Mobile Ordering ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div className="relative z-10 max-w-7xl mx-auto" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "48px", textShadow: "rgba(255,30,0,0.4) 0px 0px 30px" }}
          >
            To-Go &amp; Mobile Ordering
          </h2>
          <div className="flex flex-col sm:flex-row gap-6 justify-center max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "The Journey",
                desc: "Don\u2019t miss a second of the action. Our seamless ordering system allows you to fuel up on your terms.",
                borderColor: "rgba(228,28,29,0.59)",
                titleColor: "rgb(228,28,29)",
                badgeBg: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Race & Eat",
                desc: "Order your artisan pizza via the FastTrax Racing App while you wait for your heat. We\u2019ll have it hot and ready the moment you step off the track.",
                borderColor: "rgba(0,74,173,0.59)",
                titleColor: "rgb(0,74,173)",
                badgeBg: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Curbside Pickup",
                desc: "Bringing the Italian flair home? Use our online portal for quick and easy curbside pickup for the whole family.",
                borderColor: "rgba(134,82,255,0.63)",
                titleColor: "rgb(134,82,255)",
                badgeBg: "rgb(134,82,255)",
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
                <div
                  className="font-[var(--font-anton)] text-white mx-auto mb-3 flex items-center justify-center"
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    backgroundColor: step.badgeBg,
                    fontSize: "24px",
                  }}
                >
                  {step.num}
                </div>
                <h3 className="font-[var(--font-anton)] uppercase mb-3" style={{ color: step.titleColor, fontSize: "24px", letterSpacing: "1.2px" }}>
                  {step.title}
                </h3>
                <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5" }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Upcoming Events & Watch Parties ── */}
      <section id="events" className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "16px", textShadow: glowShadow }}
          >
            Upcoming Events &amp; Watch Parties
          </h2>
          <p
            className="text-center mx-auto mb-10 font-[var(--font-poppins)]"
            style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
          >
            Join us in the FastTrax VIP every Friday night at 8pm for Karaoke!
          </p>

          {/* Event Cards - Vertical Full-Width Layout */}
          <div className="flex flex-col gap-6 max-w-4xl mx-auto mb-10">
            {[
              {
                num: "1",
                title: "Race Watch Parties",
                desc: "The premier destination for F1, NASCAR, and IndyCar main events on our massive HD screens.",
                borderColor: "rgb(228,28,29)",
                titleColor: "rgb(228,28,29)",
                badgeBg: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Live Social Sets",
                desc: "Local artists performing every Friday and Saturday night.",
                borderColor: "rgb(0,74,173)",
                titleColor: "rgb(0,74,173)",
                badgeBg: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Featured Date",
                desc: "Check our socials for upcoming events and specials!",
                borderColor: "rgb(134,82,255)",
                titleColor: "rgb(134,82,255)",
                badgeBg: "rgb(134,82,255)",
              },
            ].map((evt) => (
              <div
                key={evt.num}
                className="flex items-center gap-5"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${evt.borderColor}`,
                  borderRadius: "8px",
                  padding: "24px 28px",
                }}
              >
                <div
                  className="font-[var(--font-anton)] text-white flex-shrink-0 flex items-center justify-center"
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    backgroundColor: evt.badgeBg,
                    fontSize: "24px",
                  }}
                >
                  {evt.num}
                </div>
                <div>
                  <h3 className="font-[var(--font-anton)] uppercase mb-1" style={{ color: evt.titleColor, fontSize: "24px", letterSpacing: "1.2px" }}>
                    {evt.title}
                  </h3>
                  <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5" }}>
                    {evt.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="text-center">
            <a
              href="#"
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(134,82,255)", borderRadius: "555px", padding: "16px 24px", fontSize: "14px" }}
            >
              VIEW FULL EVENT CALENDAR
            </a>
          </div>
        </div>
      </section>

      {/* ── Section: Planning a Visit with 10+ Guests? ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/nemos-group.webp"
          alt="Group dining"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/80" />
        <div className="relative z-10 max-w-3xl mx-auto text-center" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{ fontSize: "clamp(32px, 8vw, 72px)", lineHeight: "1", letterSpacing: "3px", marginBottom: "24px", textShadow: glowShadow }}
          >
            Planning a visit with 10+ guests?
          </h2>
          <p
            className="font-[var(--font-poppins)] mb-8"
            style={{ color: "rgba(255,255,255,0.898)", fontSize: "18px", lineHeight: "1.6" }}
          >
            Ensure your artisan pizzas hit the table the moment your group finishes their race. Contact us to arrange pre-orders for your trackside table or VIP viewing area.
          </p>
          <a
            href="/group-events"
            className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
            style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 48px", fontSize: "14px" }}
          >
            REQUEST AN EVENT QUOTE
          </a>
        </div>
      </section>
    </>
  );
}
