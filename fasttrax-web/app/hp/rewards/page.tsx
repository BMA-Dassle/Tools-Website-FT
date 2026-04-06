import type { Metadata } from "next";
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
        <p className="font-[var(--font-hp-body)] text-[#FFD700] text-xs uppercase tracking-[0.3em] mb-3">
          HeadPinz Loyalty
        </p>
        <h1
          className="font-[var(--font-hp-hero)] font-black uppercase text-white"
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
        <p className="font-[var(--font-hp-body)] text-white/60 text-sm max-w-md mx-auto mb-2">
          Earn Pinz every time you bowl, play, or dine with us. Redeem for free food, discounts, and exclusive perks.
        </p>
        <div className="mx-auto h-1 w-24 rounded-full mt-4 mb-10" style={{ background: "linear-gradient(90deg, #FFD700, #fd5b56)" }} />
      </section>

      {/* Rewards Portal */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
        <RewardsPortal />
      </section>
    </div>
  );
}
