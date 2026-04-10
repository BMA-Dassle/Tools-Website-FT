import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Free Wing Friday - Sign In",
  description:
    "Sign in to your HeadPinz Rewards account to claim your Free Wing Friday. 5 free wings every Friday 4-6 PM with any food or beverage purchase.",
  openGraph: {
    title: "Free Wing Friday - HeadPinz Rewards",
    description:
      "Sign in to claim your Free Wing Friday. 5 free wings every Friday 4-6 PM.",
    type: "website",
    url: "https://headpinz.com/fwf",
  },
  alternates: {
    canonical: "https://headpinz.com/fwf",
  },
};

export default function FWFPage() {
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
        <p className="font-body text-[#fd5b56] text-xs uppercase tracking-[0.3em] mb-3">
          HeadPinz Rewards
        </p>
        <h1
          className="font-heading font-black uppercase text-white"
          style={{
            fontSize: "clamp(28px, 6vw, 52px)",
            lineHeight: "1.05",
            letterSpacing: "-1px",
            marginBottom: "12px",
            textShadow: "0 0 40px rgba(253,91,86,0.3)",
          }}
        >
          Free Wing Friday
        </h1>
        <p className="font-body text-white/60 text-sm max-w-sm mx-auto">
          Sign in to your rewards account to claim your free wings.
        </p>
        <div
          className="mx-auto h-1 w-24 rounded-full mt-4 mb-6"
          style={{ background: "linear-gradient(90deg, #FFD700, #fd5b56)" }}
        />
      </section>

      {/* Square Loyalty Sign-In */}
      <section className="px-4 pb-16">
        <div className="max-w-2xl mx-auto">
          <div
            className="rounded-2xl overflow-hidden"
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <iframe
              src="https://profile.squareup.com/signin?variant=LOYALTY"
              title="HeadPinz Rewards Sign In"
              className="w-full border-0"
              style={{ height: "700px", minHeight: "600px", background: "#fff" }}
              allow="payment"
            />
          </div>
          <p className="text-center text-white/30 text-xs mt-4">
            Powered by Square Loyalty
          </p>
        </div>
      </section>

      {/* Details */}
      <section className="px-4 pb-20">
        <div className="max-w-md mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <svg
              className="w-5 h-5 text-[#FFD700] shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            <span className="font-body text-[#FFD700] text-sm font-semibold">
              5 Free Wings Every Friday
            </span>
          </div>
          <p className="font-body text-white/50 text-sm">
            4 &ndash; 6 PM with any food or beverage purchase at Nemo&apos;s Trackside. Dine-in only.
          </p>
          <a
            href="/rewards"
            className="inline-block text-[#fd5b56] text-sm font-semibold hover:text-white transition-colors mt-2"
          >
            Learn more about HeadPinz Rewards &rarr;
          </a>
        </div>
      </section>
    </div>
  );
}
