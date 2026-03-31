"use client";
import Image from "next/image";
import Link from "next/link";

export default function PromoCard() {
  return (
    <section className="bg-[#000418] py-14 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="border border-dashed border-[#00E2E5]/40 rounded-2xl overflow-hidden bg-[#071027]">
          <div className="grid md:grid-cols-2 gap-0">
            {/* Left: info */}
            <div className="p-8 md:p-10 flex flex-col justify-between gap-6">
              <div>
                <div className="inline-block bg-[#8652FF]/20 text-[#8652FF] font-[var(--font-jakarta)] font-bold text-xs uppercase tracking-widest px-3 py-1.5 rounded-full mb-5">
                  Add More Fun For Just $10
                </div>
                <h2
                  className="font-[var(--font-anton)] italic text-white uppercase leading-tight mb-3"
                  style={{ fontSize: "clamp(1.8rem, 4.5vw, 3rem)" }}
                >
                  Level Up Your Race Day
                </h2>
                <p className="text-white/70 text-base mt-2 font-[var(--font-poppins)] leading-relaxed">
                  When you book a race, add one of these experiences for just $10 more:
                </p>

                <div className="mt-6 flex flex-col gap-4">
                  {/* Gel Blaster */}
                  <div
                    className="rounded-lg p-4"
                    style={{
                      backgroundColor: "rgba(134,82,255,0.1)",
                      border: "1px solid rgba(134,82,255,0.3)",
                    }}
                  >
                    <h3 className="font-[var(--font-anton)] uppercase text-[#8652FF] text-lg tracking-wide mb-1">
                      Nexus Gel Blaster Arena
                    </h3>
                    <p className="font-[var(--font-poppins)] text-white/60 text-sm">
                      $10 per person &mdash; at HeadPinz
                    </p>
                  </div>

                  {/* Shuffly */}
                  <div
                    className="rounded-lg p-4"
                    style={{
                      backgroundColor: "rgba(0,74,173,0.1)",
                      border: "1px solid rgba(0,74,173,0.3)",
                    }}
                  >
                    <h3 className="font-[var(--font-anton)] uppercase text-[#004AAD] text-lg tracking-wide mb-1">
                      Shuffly at FastTrax
                    </h3>
                    <p className="font-[var(--font-poppins)] text-white/60 text-sm">
                      $10 per group &mdash; at FastTrax
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-[#E53935] hover:bg-[#c62828] text-white font-[var(--font-jakarta)] font-bold text-sm px-6 py-3 rounded-full uppercase tracking-wider transition-colors"
                >
                  Book Your Race + Add-On
                </a>
                <Link href="/pricing" className="bg-[#003580] hover:bg-[#004aaa] text-white font-[var(--font-jakarta)] font-bold text-sm px-6 py-3 rounded-full uppercase tracking-wider transition-colors">
                  View All Combos
                </Link>
              </div>
            </div>

            {/* Right: racing image */}
            <div className="relative min-h-[280px] md:min-h-0">
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06538.webp"
                alt="Add-on activities at FastTrax"
                fill
                className="object-cover object-center"
                sizes="(max-width: 768px) 100vw, 50vw"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#071027]/60 to-transparent md:bg-gradient-to-l md:from-transparent md:to-[#071027]/40" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
