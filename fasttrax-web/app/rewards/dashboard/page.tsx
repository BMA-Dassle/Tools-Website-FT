import type { Metadata } from "next";
import RewardsPortal from "@/components/headpinz/RewardsPortal";

export const metadata: Metadata = {
  title: "My Rewards Dashboard",
  description:
    "View your FastTrax Rewards balance, track your Pinz, and see available rewards.",
  openGraph: {
    title: "My Rewards Dashboard - FastTrax",
    description: "View your Pinz balance and available rewards.",
    type: "website",
    url: "https://fasttraxent.com/rewards/dashboard",
  },
  alternates: {
    canonical: "https://fasttraxent.com/rewards/dashboard",
  },
};

export default function RewardsDashboardPage() {
  return (
    <div className="bg-[#0a1628] min-h-screen">
      {/* Hero */}
      <section
        className="relative flex flex-col items-center justify-center text-center px-4"
        style={{
          paddingTop: "clamp(120px, 18vw, 160px)",
          paddingBottom: "clamp(16px, 3vw, 24px)",
        }}
      >
        <p className="font-body text-[#FFD700] text-xs uppercase tracking-[0.3em] mb-3">
          HeadPinz Loyalty
        </p>
        <h1
          className="font-heading font-black uppercase text-white"
          style={{
            fontSize: "clamp(28px, 6vw, 52px)",
            lineHeight: "1.05",
            letterSpacing: "-1px",
            marginBottom: "12px",
            textShadow: "0 0 40px rgba(255,215,0,0.3)",
          }}
        >
          My Rewards
        </h1>
        <p className="font-body text-white/60 text-sm max-w-sm mx-auto">
          Sign in with your phone number to view your balance and rewards.
        </p>
        <div
          className="mx-auto h-1 w-24 rounded-full mt-4 mb-8"
          style={{ background: "linear-gradient(90deg, #FFD700, #fd5b56)" }}
        />
      </section>

      {/* Rewards Portal — phone OTP → dashboard */}
      <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(40px, 8vw, 80px)" }}>
        <RewardsPortal />
      </section>

      {/* Back link */}
      <section className="text-center pb-16">
        <a
          href="/rewards"
          className="font-body text-white/30 hover:text-white/60 text-sm transition-colors"
        >
          &larr; Back to Rewards
        </a>
      </section>
    </div>
  );
}
