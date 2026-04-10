"use client";

import { useState } from "react";

const ENROLL_URL = "https://squareup.com/customer-programs/enroll/b372FWGjmHLH?utm_medium=copied-link&utm_source=online";

export default function RewardsSignIn() {
  const [open, setOpen] = useState(false);

  return (
    <>
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
            <button
              onClick={() => setOpen(true)}
              className="w-full bg-[#FFD700] hover:bg-[#ffe44d] text-[#0a1628] font-body font-bold text-base uppercase tracking-wider py-3.5 rounded-full transition-all hover:scale-[1.02]"
              style={{ boxShadow: "0 0 20px rgba(255,215,0,0.3)" }}
            >
              Sign Up / Check Enrollment
            </button>
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

      {/* Modal with Square enrollment iframe */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 py-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl bg-[#0a1628] border border-white/10 rounded-2xl overflow-hidden relative"
            style={{ maxHeight: "90vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 hover:bg-black/80 flex items-center justify-center text-white/60 hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <iframe
              src={ENROLL_URL}
              title="HeadPinz Rewards - Sign Up or Sign In"
              className="w-full border-0"
              style={{ height: "80vh", maxHeight: "700px", background: "#fff" }}
              allow="payment"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      )}
    </>
  );
}
