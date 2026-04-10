"use client";

const ENROLL_URL = "https://squareup.com/customer-programs/enroll/b372FWGjmHLH?utm_medium=copied-link&utm_source=online";

export default function RewardsSignIn() {
  return (
    <div className="max-w-lg mx-auto text-center">
      <div
        className="rounded-lg p-8"
        style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
      >
        <h2
          className="font-heading uppercase text-white text-xl tracking-wider mb-2"
          style={{ textShadow: "0 0 20px rgba(255,215,0,0.25)" }}
        >
          HeadPinz Rewards
        </h2>
        <p className="font-body text-white/50 text-sm mb-6">
          Earn Pinz every time you visit. Redeem for free food, discounts, and exclusive perks.
        </p>

        <div className="flex flex-col gap-3">
          <a
            href={ENROLL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full inline-block text-center bg-[#FFD700] hover:bg-[#ffe44d] text-[#0a1628] font-body font-bold text-base uppercase tracking-wider py-3.5 rounded-full transition-all hover:scale-[1.02]"
            style={{ boxShadow: "0 0 20px rgba(255,215,0,0.3)" }}
          >
            Sign Up / Check Enrollment
          </a>
          <a
            href="/rewards/dashboard"
            className="w-full inline-block text-center bg-transparent border-2 border-[#FFD700]/50 hover:border-[#FFD700] text-[#FFD700] font-body font-bold text-base uppercase tracking-wider py-3.5 rounded-full transition-all hover:scale-[1.02]"
          >
            View My Rewards
          </a>
        </div>

        <p className="font-body text-white/30 text-xs mt-4">
          New members get 500 bonus Pinz when you sign up!
        </p>
      </div>
    </div>
  );
}
