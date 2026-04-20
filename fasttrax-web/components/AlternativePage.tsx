import Link from "next/link";
import type { AlternativeData } from "@/lib/alternatives-data";
import { BreadcrumbJsonLd, FAQJsonLd } from "@/components/seo/JsonLd";

/**
 * Shared landing-page layout for /alternatives/[slug] pages on both
 * brands. Renders:
 *
 *   - Hero (eyebrow "ALTERNATIVE IN FORT MYERS" + H1 + tagline + CTAs)
 *   - "Why consider us" reasons grid
 *   - Side-by-side comparison table
 *   - FAQ accordion with FAQPage schema
 *   - BreadcrumbList schema
 *
 * Brand-aware (FT cyan vs HP coral). Every string comes from
 * AlternativeData — NO hardcoded copy here.
 *
 * SEO framing: the page consistently presents as an "alternative" rather
 * than impersonating the competitor. Headings, eyebrow text, and FAQ
 * titles all include "alternative" so Google disambiguates intent.
 */

export interface AlternativePageProps {
  data: AlternativeData;
  /** Full canonical URL for this page (used by breadcrumb schema). */
  canonicalUrl: string;
}

export function AlternativePage({ data, canonicalUrl }: AlternativePageProps) {
  const isHeadPinz = data.brand === "hp";
  const accent = isHeadPinz ? "#fd5b56" : "#00E2E5";
  const accentDark = isHeadPinz ? "#123075" : "#123075";
  const bg = isHeadPinz ? "#0a1628" : "#000418";
  const cardBg = isHeadPinz ? "#0f1d36" : "#071027";

  const brandHome = isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com";
  const brandName = isHeadPinz ? "HeadPinz" : "FastTrax";
  const locationLabel = isHeadPinz ? "Fort Myers & Naples" : "Fort Myers";

  const breadcrumbItems = [
    { name: brandName, url: brandHome },
    { name: "Alternatives", url: `${brandHome}/${isHeadPinz ? "" : ""}alternatives` },
    { name: data.competitor, url: canonicalUrl },
  ];

  const faqItems = data.faqs.map((f) => ({ question: f.q, answer: f.a }));

  return (
    <div style={{ backgroundColor: bg }} className="min-h-screen text-white">
      <BreadcrumbJsonLd items={breadcrumbItems.map((b) => ({ name: b.name, url: b.url }))} />
      <FAQJsonLd faqs={faqItems} />

      {/* Hero */}
      <section
        className="relative overflow-hidden"
        style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) clamp(40px, 8vw, 80px)" }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at top, ${accent}22 0%, transparent 60%)`,
          }}
        />
        <div className="relative max-w-5xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-4"
            style={{ color: accent, fontSize: "clamp(11px, 1.4vw, 13px)", letterSpacing: "3px" }}
          >
            {data.competitor} Alternative · {locationLabel}
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white mx-auto"
            style={{
              fontSize: "clamp(32px, 7vw, 68px)",
              lineHeight: 1.05,
              letterSpacing: "-0.8px",
              marginBottom: "16px",
              maxWidth: "22ch",
            }}
          >
            Looking for a {data.competitor} alternative in {isHeadPinz ? "Southwest Florida" : "Fort Myers"}?
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{
              fontSize: "clamp(16px, 2.2vw, 22px)",
              lineHeight: 1.5,
              maxWidth: "48ch",
              marginBottom: "32px",
            }}
          >
            {data.tagline}
          </p>
          <div className="flex flex-wrap justify-center gap-3 sm:gap-4">
            <Link
              href={data.ctaHref}
              className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105"
              style={{ backgroundColor: accent, color: bg }}
            >
              {data.ctaLabel}
            </Link>
            {data.secondaryCta && (
              <Link
                href={data.secondaryCta.href}
                className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white"
                style={{ border: "1px solid rgba(255,255,255,0.25)" }}
              >
                {data.secondaryCta.label}
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Intro */}
      <section style={{ padding: "clamp(20px, 4vw, 40px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto">
          <p
            className="font-body text-white/85"
            style={{ fontSize: "clamp(16px, 2vw, 19px)", lineHeight: 1.7 }}
          >
            {data.intro}
          </p>
        </div>
      </section>

      {/* Comparison table */}
      <section style={{ padding: "clamp(40px, 6vw, 80px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{
              fontSize: "clamp(24px, 4.5vw, 40px)",
              lineHeight: 1.05,
              letterSpacing: "-0.4px",
              marginBottom: "12px",
            }}
          >
            Side by side
          </h2>
          <p
            className="font-body text-white/60 text-center mx-auto"
            style={{ fontSize: "clamp(13px, 1.5vw, 15px)", maxWidth: "48ch", marginBottom: "32px" }}
          >
            Factual comparison — pick the venue that best fits what your group wants.
          </p>

          <div
            className="rounded-2xl overflow-hidden"
            style={{ backgroundColor: cardBg, border: `1px solid ${accent}30` }}
          >
            <div
              className="grid gap-0 font-body text-sm sm:text-base"
              style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}
            >
              {/* Header row */}
              <div
                className="p-3 sm:p-4 font-bold uppercase text-xs tracking-wider"
                style={{ color: "rgba(255,255,255,0.5)", backgroundColor: "rgba(255,255,255,0.03)" }}
              >
                Feature
              </div>
              <div
                className="p-3 sm:p-4 font-bold uppercase text-xs tracking-wider text-center"
                style={{ color: accent, backgroundColor: `${accent}14` }}
              >
                {brandName}
              </div>
              <div
                className="p-3 sm:p-4 font-bold uppercase text-xs tracking-wider text-center"
                style={{ color: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.03)" }}
              >
                {data.competitor}
              </div>

              {/* Data rows */}
              {data.comparison.map((row, i) => (
                <>
                  <div
                    key={`feature-${i}`}
                    className="p-3 sm:p-4 text-white/80 border-t"
                    style={{ borderColor: "rgba(255,255,255,0.06)" }}
                  >
                    {row.feature}
                  </div>
                  <div
                    key={`us-${i}`}
                    className="p-3 sm:p-4 text-white border-t text-center"
                    style={{
                      borderColor: "rgba(255,255,255,0.06)",
                      backgroundColor: row.usWins ? `${accent}08` : "transparent",
                    }}
                  >
                    {row.us}
                  </div>
                  <div
                    key={`them-${i}`}
                    className="p-3 sm:p-4 text-white/70 border-t text-center"
                    style={{ borderColor: "rgba(255,255,255,0.06)" }}
                  >
                    {row.them}
                  </div>
                </>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Reasons */}
      <section
        style={{
          padding: "clamp(40px, 6vw, 80px) clamp(16px, 4vw, 32px)",
          backgroundColor: `${accentDark}15`,
        }}
      >
        <div className="max-w-5xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{
              fontSize: "clamp(24px, 4.5vw, 40px)",
              lineHeight: 1.05,
              letterSpacing: "-0.4px",
              marginBottom: "40px",
            }}
          >
            Why {brandName} might be a fit
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {data.reasons.map((r) => (
              <div
                key={r.title}
                className="rounded-2xl p-6"
                style={{ backgroundColor: cardBg, border: `1px solid ${accent}25` }}
              >
                <h3
                  className="font-heading font-black uppercase text-white mb-2"
                  style={{ fontSize: "18px", letterSpacing: "-0.2px" }}
                >
                  {r.title}
                </h3>
                <p
                  className="font-body text-white/75"
                  style={{ fontSize: "15px", lineHeight: 1.6 }}
                >
                  {r.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section style={{ padding: "clamp(40px, 6vw, 80px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-3xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white text-center"
            style={{
              fontSize: "clamp(24px, 4.5vw, 40px)",
              lineHeight: 1.05,
              letterSpacing: "-0.4px",
              marginBottom: "32px",
            }}
          >
            Common questions
          </h2>
          <div className="space-y-3">
            {data.faqs.map((f, i) => (
              <details
                key={i}
                className="rounded-xl group"
                style={{ backgroundColor: cardBg, border: `1px solid ${accent}25` }}
              >
                <summary
                  className="cursor-pointer p-5 font-body font-semibold text-white flex items-start justify-between gap-3"
                  style={{ fontSize: "16px" }}
                >
                  <span>{f.q}</span>
                  <span
                    style={{ color: accent, flexShrink: 0, fontSize: "20px", lineHeight: 1 }}
                    className="transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <div
                  className="px-5 pb-5 font-body text-white/75"
                  style={{ fontSize: "15px", lineHeight: 1.65 }}
                >
                  {f.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section
        style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        className="text-center"
      >
        <div className="max-w-2xl mx-auto">
          <h2
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(28px, 5vw, 44px)",
              lineHeight: 1.05,
              letterSpacing: "-0.4px",
              marginBottom: "20px",
            }}
          >
            Want to give {brandName} a try?
          </h2>
          <p
            className="font-body text-white/70 mx-auto"
            style={{ fontSize: "16px", lineHeight: 1.6, marginBottom: "32px", maxWidth: "42ch" }}
          >
            Easiest way to compare is to come spend a couple of hours with us. Book a heat, a lane, or a group event.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href={data.ctaHref}
              className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105"
              style={{ backgroundColor: accent, color: bg }}
            >
              {data.ctaLabel}
            </Link>
            {data.secondaryCta && (
              <Link
                href={data.secondaryCta.href}
                className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-4 rounded-full transition-all hover:scale-105 text-white"
                style={{ border: "1px solid rgba(255,255,255,0.25)" }}
              >
                {data.secondaryCta.label}
              </Link>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
