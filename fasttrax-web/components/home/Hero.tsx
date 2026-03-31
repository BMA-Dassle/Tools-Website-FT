import Link from "next/link";

export default function Hero() {

  return (
    <section className="relative overflow-hidden bg-[#000418]" style={{ minHeight: "min(813px, 100vh)" }}>
      {/* Video background */}
      <video
        autoPlay
        muted
        loop
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        poster="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-racing.webp"
      >
        <source src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-video.mp4" type="video/mp4" />
      </video>

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#000418]/95 via-[#000418]/75 to-[#000418]/40" />

      {/* Content */}
      <div className="relative z-10 flex flex-col lg:flex-row items-center gap-6 max-w-7xl mx-auto px-8 pt-36 pb-16 min-h-[813px]">

        {/* LEFT COL — label + headline + description + hours */}
        <div className="flex-1 flex flex-col gap-5">
          {/* Label */}
          <p style={{ color: "rgba(255,255,255,0.898)", fontSize: "16px", fontFamily: "var(--font-poppins)" }}>
            Florida&apos;s Largest Indoor Racing Destination
          </p>

          {/* Headline */}
          <div>
            <h1
              className="font-[var(--font-anton)] italic uppercase text-white leading-[0.9]"
              style={{ fontSize: "clamp(2.2rem, 5.5vw, 5rem)" }}
            >
              LIVE LIFE IN THE
            </h1>
            <h1
              className="font-[var(--font-anton)] italic uppercase leading-[0.9]"
              style={{ fontSize: "clamp(2.2rem, 5.5vw, 5rem)", color: "rgb(228,28,29)", textShadow: "0 0 40px rgba(228,28,29,0.5)" }}
            >
              FASTRAX
            </h1>
          </div>

          {/* Description */}
          <p style={{ color: "rgba(255,255,255,0.898)", fontSize: "clamp(16px, 4vw, 20px)", fontFamily: "var(--font-poppins)", maxWidth: "520px", lineHeight: "1.6" }}>
            63,000 sq. ft. of high-powered electric karting, elite gaming, and
            trackside dining. Don&apos;t just watch the action—be the action.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              className="font-[var(--font-poppins)] font-bold uppercase tracking-widest text-white px-6 py-4 rounded-full text-sm transition-all hover:scale-105"
              style={{ backgroundColor: "rgb(228,28,29)", boxShadow: "0 0 20px rgba(228,28,29,0.4)" }}
            >
              Book Your Race Now
            </a>
            <Link
              href="/attractions"
              className="font-[var(--font-poppins)] font-bold uppercase tracking-widest text-white px-6 py-4 rounded-full text-sm border transition-all hover:bg-white/10"
              style={{ borderColor: "rgba(255,255,255,0.4)" }}
            >
              Explore Destination Combos
            </Link>
          </div>
        </div>


      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
    </section>
  );
}
