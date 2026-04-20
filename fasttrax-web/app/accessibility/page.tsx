import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";

/**
 * Accessibility Statement — served on both fasttraxent.com and
 * headpinz.com via the standard app/ route. Host-aware brand palette
 * and canonical URL.
 *
 * Industry standard — documents:
 *   - Standards targeted (WCAG 2.1 AA)
 *   - Tooling (eslint-plugin-jsx-a11y, @axe-core/react)
 *   - Known limitations (third-party embeds we don't control)
 *   - Feedback channel
 *
 * Not a legal "certification" — none is available for web sites without
 * a third-party audit. This is the factual equivalent most major
 * brands (GitHub, Target, GOV.UK) publish.
 */

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");
  const brand = isHeadPinz ? "HeadPinz" : "FastTrax";
  const base = isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com";
  return {
    title: `Accessibility Statement | ${brand}`,
    description: `${brand} is committed to WCAG 2.1 Level AA accessibility. Read our statement, tooling, and feedback channel.`,
    alternates: { canonical: `${base}/accessibility` },
    openGraph: {
      title: `Accessibility | ${brand}`,
      description: `${brand}'s commitment to web accessibility and inclusive design.`,
      url: `${base}/accessibility`,
      siteName: brand,
      type: "article",
    },
  };
}

export default async function AccessibilityPage() {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  const accent = isHeadPinz ? "#fd5b56" : "#00E2E5";
  const bg = isHeadPinz ? "#0a1628" : "#000418";
  const cardBg = isHeadPinz ? "#0f1d36" : "#071027";
  const brandName = isHeadPinz ? "HeadPinz" : "FastTrax";
  const brandHome = isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com";
  const contactEmail = isHeadPinz ? "guestservices@headpinz.com" : "guestservices@headpinz.com";

  return (
    <div style={{ backgroundColor: bg }} className="min-h-screen text-white">
      <BreadcrumbJsonLd
        items={[
          { name: brandName, url: brandHome },
          { name: "Accessibility Statement", url: `${brandHome}/accessibility` },
        ]}
      />

      {/* Hero */}
      <section style={{ padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) 40px" }}>
        <div className="max-w-3xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-4"
            style={{ color: accent, fontSize: "12px", letterSpacing: "3px" }}
          >
            Accessibility
          </div>
          <h1
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(32px, 7vw, 56px)",
              lineHeight: 1.05,
              letterSpacing: "-0.6px",
              marginBottom: "16px",
            }}
          >
            Built for everyone
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2vw, 20px)", lineHeight: 1.55, maxWidth: "48ch" }}
          >
            {brandName} is committed to making our website usable by everyone, including people
            who rely on keyboards, screen readers, or other assistive technology.
          </p>
        </div>
      </section>

      {/* Body */}
      <section style={{ padding: "20px clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl p-8 space-y-6"
            style={{ backgroundColor: cardBg, border: `1px solid ${accent}25` }}
          >
            <section>
              <h2
                className="font-heading font-black uppercase text-white mb-3"
                style={{ fontSize: "20px", letterSpacing: "-0.2px" }}
              >
                What we target
              </h2>
              <p className="font-body text-white/80" style={{ fontSize: "15px", lineHeight: 1.7 }}>
                Our goal is <strong style={{ color: accent }}>WCAG 2.1 Level AA</strong> — the
                Web Content Accessibility Guidelines standard used by most US businesses and
                required by many state + federal entities. That covers color contrast, keyboard
                navigation, screen-reader compatibility, form labeling, motion sensitivity,
                focus indicators, and more.
              </p>
            </section>

            <section>
              <h2
                className="font-heading font-black uppercase text-white mb-3"
                style={{ fontSize: "20px", letterSpacing: "-0.2px" }}
              >
                How we keep the site accessible
              </h2>
              <ul
                className="font-body text-white/80 space-y-2"
                style={{ fontSize: "15px", lineHeight: 1.7, paddingLeft: "20px", listStyleType: "disc" }}
              >
                <li>
                  <strong>Build-time lint gate</strong> — every deploy runs the full{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">eslint-plugin-jsx-a11y</code>{" "}
                  recommended ruleset. Any accessibility violation fails the build, so new
                  issues can&apos;t ship.
                </li>
                <li>
                  <strong>Runtime auditing</strong> — we run{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">@axe-core/react</code> in
                  development against every page. It surfaces WCAG violations the lint rules
                  can&apos;t catch (color contrast, dynamic DOM, actual screen-reader announcements).
                </li>
                <li>
                  <strong>Semantic HTML first</strong> — real{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">&lt;button&gt;</code>,{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">&lt;label&gt;</code>, and{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">&lt;details&gt;</code>{" "}
                  elements wherever possible. Interactive divs get proper ARIA roles + keyboard
                  handlers via shared helpers.
                </li>
                <li>
                  <strong>Structured data</strong> — Schema.org JSON-LD on key pages
                  (LocalBusiness, BreadcrumbList, FAQPage) helps assistive tools understand
                  content structure.
                </li>
                <li>
                  <strong>Keyboard-first modals</strong> — all dialogs close on Escape. Focus
                  traps keep screen-reader users oriented.
                </li>
                <li>
                  <strong>Dark + light compatible</strong> — emails render on white backgrounds,
                  site uses brand-verified contrast ratios on navy backgrounds.
                </li>
              </ul>
            </section>

            <section>
              <h2
                className="font-heading font-black uppercase text-white mb-3"
                style={{ fontSize: "20px", letterSpacing: "-0.2px" }}
              >
                Known limitations
              </h2>
              <ul
                className="font-body text-white/80 space-y-2"
                style={{ fontSize: "15px", lineHeight: 1.7, paddingLeft: "20px", listStyleType: "disc" }}
              >
                <li>
                  <strong>Third-party booking widgets</strong> — some booking flows use Square,
                  BMI Leisure, or SMS-Timing embeds. We test end-to-end flows regularly but
                  can&apos;t fix a11y issues inside those vendors&apos; code. Please contact us if you
                  hit a blocker.
                </li>
                <li>
                  <strong>Marketing videos</strong> — hero and attraction videos are atmospheric
                  and play without captions. Critical information is always available in the
                  surrounding text.
                </li>
                <li>
                  <strong>Legacy pages</strong> — some older pages may still have minor a11y
                  gaps we&apos;re working through opportunistically. The build gate prevents new
                  regressions.
                </li>
              </ul>
            </section>

            <section>
              <h2
                className="font-heading font-black uppercase text-white mb-3"
                style={{ fontSize: "20px", letterSpacing: "-0.2px" }}
              >
                Feedback
              </h2>
              <p className="font-body text-white/80" style={{ fontSize: "15px", lineHeight: 1.7 }}>
                If you run into a page that&apos;s hard to use with a screen reader, keyboard,
                or any assistive technology, we want to know. Email{" "}
                <a
                  href={`mailto:${contactEmail}?subject=Accessibility%20feedback`}
                  style={{ color: accent }}
                  className="underline hover:no-underline"
                >
                  {contactEmail}
                </a>{" "}
                with the page URL and a brief description of what broke. We read every message
                and reply within two business days.
              </p>
            </section>

            <section>
              <h2
                className="font-heading font-black uppercase text-white mb-3"
                style={{ fontSize: "20px", letterSpacing: "-0.2px" }}
              >
                Standards references
              </h2>
              <ul
                className="font-body text-white/80 space-y-2"
                style={{ fontSize: "15px", lineHeight: 1.7, paddingLeft: "20px", listStyleType: "disc" }}
              >
                <li>
                  <a href="https://www.w3.org/TR/WCAG21/" style={{ color: accent }} className="underline hover:no-underline" target="_blank" rel="noopener noreferrer">
                    WCAG 2.1 — Web Content Accessibility Guidelines
                  </a>
                </li>
                <li>
                  <a href="https://www.ada.gov/" style={{ color: accent }} className="underline hover:no-underline" target="_blank" rel="noopener noreferrer">
                    ADA.gov — Americans with Disabilities Act
                  </a>
                </li>
                <li>
                  <a href="https://www.section508.gov/" style={{ color: accent }} className="underline hover:no-underline" target="_blank" rel="noopener noreferrer">
                    Section 508 — US federal accessibility requirements
                  </a>
                </li>
              </ul>
            </section>

            <p className="font-body text-white/50 text-sm pt-4 border-t border-white/10">
              Last reviewed: 2026. This statement is updated as we ship improvements.
            </p>
          </div>

          <div className="text-center mt-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-body font-bold text-sm uppercase tracking-wider"
              style={{ color: accent }}
            >
              ← Back to {brandName}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
