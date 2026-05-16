import type { Metadata } from "next";
import Link from "next/link";
import { listAlternatives } from "@/lib/alternatives-data";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

export const metadata: Metadata = {
  title: "Alternatives & Comparisons | FastTrax Fort Myers",
  description:
    "Comparing FastTrax against other Fort Myers entertainment options — Topgolf, Dave & Buster's, 810 Bowling, Gator Mike's, GameTime, PopStroke, and Hi-5. Pick what fits your group best.",
  alternates: { canonical: "https://fasttraxent.com/alternatives" },
  openGraph: {
    title: "Alternatives & Comparisons | FastTrax",
    description:
      "Side-by-side comparisons between FastTrax and other Fort Myers entertainment venues.",
    url: "https://fasttraxent.com/alternatives",
    siteName: "FastTrax Entertainment",
    type: "website",
  },
};

export default function FtAlternativesIndex() {
  const alts = listAlternatives("ft");
  return (
    <div className="min-h-screen bg-[#000418] text-white">
      <BreadcrumbJsonLd
        items={[
          { name: "FastTrax", url: "https://fasttraxent.com" },
          { name: "Alternatives", url: "https://fasttraxent.com/alternatives" },
        ]}
      />

      {/* Hero */}
      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-4xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-4"
            style={{ color: "#00E2E5", fontSize: "12px", letterSpacing: "3px" }}
          >
            Alternatives & Comparisons
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 64px)",
              lineHeight: 1.05,
              letterSpacing: "-0.8px",
              marginBottom: "16px",
            }}
          >
            How FastTrax compares
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2.2vw, 20px)", lineHeight: 1.5, maxWidth: "50ch" }}
          >
            Fort Myers has a lot of great entertainment venues. Here&apos;s how FastTrax stacks up
            against the ones people compare us to — so you can pick what fits your group best.
          </p>
        </div>
      </section>

      {/* Grid */}
      <section style={{ padding: "40px clamp(16px, 4vw, 32px) clamp(80px, 12vw, 140px)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {alts.map((alt) => (
              <Link
                key={alt.slug}
                href={`/alternatives/${alt.slug}`}
                className="rounded-2xl p-6 transition-transform hover:scale-[1.02]"
                style={{
                  backgroundColor: "#071027",
                  border: "1px solid rgba(0,226,229,0.25)",
                }}
              >
                <div
                  className="uppercase font-bold mb-2"
                  style={{ color: "#00E2E5", fontSize: "10px", letterSpacing: "2px" }}
                >
                  Alternative to
                </div>
                <h2
                  className="font-heading font-black uppercase text-white mb-3"
                  style={{ fontSize: "22px", letterSpacing: "-0.3px" }}
                >
                  {alt.competitor}
                </h2>
                <p
                  className="font-body text-white/70"
                  style={{ fontSize: "14px", lineHeight: 1.5 }}
                >
                  {alt.tagline}
                </p>
                <div
                  className="mt-4 inline-flex items-center gap-1 font-body font-bold text-sm uppercase tracking-wider"
                  style={{ color: "#00E2E5" }}
                >
                  See comparison <span aria-hidden>→</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
