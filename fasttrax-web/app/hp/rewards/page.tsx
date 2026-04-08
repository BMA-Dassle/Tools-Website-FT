import type { Metadata } from "next";
import Image from "next/image";
import RewardsPortal from "@/components/headpinz/RewardsPortal";

export const metadata: Metadata = {
  title: "Rewards - HeadPinz Loyalty Program",
  description:
    "Join the HeadPinz rewards program. Earn points every time you bowl, play laser tag, or dine with us. Redeem for free games, discounts, and exclusive perks.",
  keywords: [
    "HeadPinz rewards",
    "HeadPinz loyalty",
    "bowling rewards",
    "HeadPinz points",
    "HeadPinz perks",
  ],
  openGraph: {
    title: "Rewards - HeadPinz Loyalty Program",
    description:
      "Earn points every visit. Redeem for free games, discounts, and exclusive perks at HeadPinz.",
    type: "website",
    url: "https://headpinz.com/rewards",
  },
  alternates: {
    canonical: "https://headpinz.com/rewards",
  },
};

export default function RewardsPage() {
  return (
    <div className="bg-[#0a1628]">
      {/* Hero */}
      <section
        className="relative flex flex-col items-center justify-center text-center px-4"
        style={{
          paddingTop: "clamp(120px, 18vw, 180px)",
          paddingBottom: "clamp(24px, 4vw, 40px)",
        }}
      >
        <p className="font-body text-[#FFD700] text-xs uppercase tracking-[0.3em] mb-3">
          HeadPinz Loyalty
        </p>
        <h1
          className="font-heading font-black uppercase text-white"
          style={{
            fontSize: "clamp(32px, 7vw, 64px)",
            lineHeight: "1.05",
            letterSpacing: "-1px",
            marginBottom: "12px",
            textShadow: "0 0 40px rgba(255,215,0,0.3)",
          }}
        >
          Rewards
        </h1>
        <p className="font-body text-white/60 text-sm max-w-md mx-auto mb-2">
          Earn Pinz every time you bowl, play, or dine with us. Redeem for free food, discounts, and exclusive perks.
        </p>
        <div className="mx-auto h-1 w-24 rounded-full mt-4 mb-10" style={{ background: "linear-gradient(90deg, #FFD700, #fd5b56)" }} />
      </section>

      {/* Free Wing Friday — Rewards Exclusive */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(32px, 6vw, 56px)" }}>
        <div className="max-w-5xl mx-auto">
          <div
            className="rounded-2xl overflow-hidden relative"
            style={{ border: "1.78px dashed rgba(253,91,86,0.3)" }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2">
              <div className="relative" style={{ minHeight: "clamp(220px, 40vw, 360px)" }}>
                <Image
                  src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png"
                  alt="Free Wing Friday - 5 free wings"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
                <div className="absolute top-4 left-4">
                  <span className="text-xs font-bold uppercase tracking-widest bg-[#FFD700] text-[#0a1628] px-3 py-1.5 rounded-full shadow-lg">
                    Rewards Exclusive
                  </span>
                </div>
              </div>
              <div className="p-6 md:p-8 flex flex-col justify-center" style={{ backgroundColor: "rgba(253,91,86,0.08)" }}>
                <h2
                  className="font-heading font-black uppercase text-white"
                  style={{ fontSize: "clamp(26px, 5vw, 40px)", lineHeight: "1.05", textShadow: "0 0 30px rgba(253,91,86,0.2)" }}
                >
                  Free Wing Friday
                </h2>
                <p className="font-body text-white/90 text-base mt-3">
                  Get <strong className="text-[#fd5b56] text-lg">5 FREE Wings</strong> every Friday
                </p>
                <p
                  className="font-heading uppercase tracking-wider mt-2"
                  style={{ color: "#fd5b56", fontSize: "clamp(20px, 4vw, 28px)" }}
                >
                  4 &ndash; 6 PM
                </p>
                <p className="font-body text-white/60 text-sm mt-2">
                  With any food or beverage purchase at Nemo&apos;s Trackside
                </p>
                <div className="flex items-center gap-2 mt-4">
                  <svg className="w-4 h-4 text-[#FFD700] shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  <span className="font-body text-[#FFD700] text-sm font-semibold">
                    Rewards Members Only
                  </span>
                </div>
                <p className="font-body text-white/30 text-xs mt-4">
                  Dine-in only. Available while supplies last.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Rewards Portal */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <RewardsPortal />
      </section>
    </div>
  );
}
