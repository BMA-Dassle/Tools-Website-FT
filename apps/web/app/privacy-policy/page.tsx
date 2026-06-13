import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";
import { FASTTRAX_OG, HEADPINZ_OG } from "@/lib/seo";
import HeadPinzNav from "@/components/headpinz/Nav";

/**
 * Privacy Policy — served on both fasttraxent.com and headpinz.com via the
 * standard app/ route (host-aware brand palette + canonical URL), exactly like
 * the Accessibility statement. MUST be registered in `isSharedTopLevelRoute`
 * in middleware.ts or the /hp rewrite turns it into a 404 on headpinz.com.
 *
 * Written to satisfy Meta's Business Tools Terms / advertising requirements for
 * advertisers: a publicly accessible policy that discloses (a) what data we
 * collect, (b) our use of cookies, pixels, and similar technologies, (c) that
 * data may be shared with Meta (Facebook/Instagram) and other ad partners, and
 * (d) how users opt out. It is written to be correct whether or not the Meta
 * Pixel / Conversions API is live — see the "Advertising & Social Media"
 * section. It also covers CCPA/CPRA "sharing" (cross-context behavioral ads),
 * COPPA (Kids Bowl Free), and the tracking actually deployed on the site
 * (Microsoft Clarity, GA4, Google Ads, Vercel, 3CX, Square, booking vendors).
 *
 * NOT legal advice — this is a factual, technology-accurate draft. Have counsel
 * review before relying on it for a specific jurisdiction.
 */

const EFFECTIVE_DATE = "June 13, 2026";

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");
  const brand = isHeadPinz ? "HeadPinz" : "FastTrax";
  const base = isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com";
  return {
    title: `Privacy Policy | ${brand}`,
    description: `How ${brand} collects, uses, and shares your information — cookies, advertising, your privacy choices, and how to contact us.`,
    alternates: { canonical: `${base}/privacy-policy` },
    openGraph: {
      title: `Privacy Policy | ${brand}`,
      description: `How ${brand} collects, uses, and shares your information, and the privacy choices available to you.`,
      url: `${base}/privacy-policy`,
      siteName: brand,
      type: "article",
      images: isHeadPinz ? [...HEADPINZ_OG] : [...FASTTRAX_OG],
    },
  };
}

export default async function PrivacyPolicyPage() {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  const accent = isHeadPinz ? "#fd5b56" : "#00E2E5";
  const bg = isHeadPinz ? "#0a1628" : "#000418";
  const cardBg = isHeadPinz ? "#0f1d36" : "#071027";
  const brandName = isHeadPinz ? "HeadPinz" : "FastTrax";
  const legalEntity = isHeadPinz ? "Pinboyz LLC" : "Fast Trax FEC LLC";
  const brandHome = isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com";
  const siteDomain = isHeadPinz ? "headpinz.com" : "fasttraxent.com";
  const contactEmail = "guestservices@headpinz.com";

  const h2 = "font-heading font-black uppercase text-white mb-3";
  const h2Style = { fontSize: "20px", letterSpacing: "-0.2px" } as const;
  const pStyle = { fontSize: "15px", lineHeight: 1.7 } as const;
  const listStyle = {
    fontSize: "15px",
    lineHeight: 1.7,
    paddingLeft: "20px",
    listStyleType: "disc",
  } as const;
  const linkCls = "underline hover:no-underline";

  return (
    <div style={{ backgroundColor: bg }} className="min-h-screen text-white">
      {/* On headpinz.com the root layout suppresses all chrome (showChrome is
          false for the HeadPinz brand), so shared top-level pages must render
          their own HeadPinz nav — same pattern as /survey and /contract.
          FastTrax keeps the root layout's <Nav /> (showChrome is true there). */}
      {isHeadPinz && <HeadPinzNav />}
      <BreadcrumbJsonLd
        items={[
          { name: brandName, url: brandHome },
          { name: "Privacy Policy", url: `${brandHome}/privacy-policy` },
        ]}
      />

      {/* Hero — extra top clearance on HeadPinz, whose fixed nav is taller
          than FastTrax's (matches the /survey pt-28/sm:pt-36 offset). */}
      <section
        style={{
          padding: `${isHeadPinz ? "clamp(116px, 16vw, 170px)" : "clamp(80px, 14vw, 160px)"} clamp(16px, 4vw, 32px) 40px`,
        }}
      >
        <div className="max-w-3xl mx-auto text-center">
          <div
            className="uppercase font-bold mb-4"
            style={{ color: accent, fontSize: "12px", letterSpacing: "3px" }}
          >
            Privacy
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
            Privacy Policy
          </h1>
          <p
            className="font-body text-white/80 mx-auto"
            style={{ fontSize: "clamp(16px, 2vw, 20px)", lineHeight: 1.55, maxWidth: "52ch" }}
          >
            How {brandName} collects, uses, and shares your information — and the choices you have.
          </p>
          <p className="font-body text-white/40 mt-3" style={{ fontSize: "13px" }}>
            Effective {EFFECTIVE_DATE}
          </p>
        </div>
      </section>

      {/* Body */}
      <section style={{ padding: "20px clamp(16px, 4vw, 32px) clamp(60px, 10vw, 120px)" }}>
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl p-8 space-y-8"
            style={{ backgroundColor: cardBg, border: `1px solid ${accent}25` }}
          >
            {/* Intro */}
            <section>
              <p className="font-body text-white/80" style={pStyle}>
                This Privacy Policy explains how {legalEntity} (&ldquo;{brandName},&rdquo;
                &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, and shares
                information when you visit{" "}
                <a href={brandHome} style={{ color: accent }} className={linkCls}>
                  {siteDomain}
                </a>
                , make a reservation, sign a waiver, contact us, or interact with our ads on social
                media. By using our website and services, you agree to the practices described here.
              </p>
            </section>

            {/* What we collect */}
            <section>
              <h2 className={h2} style={h2Style}>
                Information We Collect
              </h2>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                <strong>Information you give us</strong> — when you book, sign a waiver, join a
                rewards program or league, enter a promotion (such as Kids Bowl Free), or contact
                us, we collect details such as your name, email address, phone number, the
                participants and booking details for your reservation, and any messages you send us.
              </p>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                <strong>Payment information</strong> — card payments are processed by our payment
                provider (Square). We do not see or store full card numbers; we receive only a
                confirmation, the last four digits, and the amount.
              </p>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                <strong>Information collected automatically</strong> — like most websites, we and
                our analytics partners automatically collect device and usage data: IP address,
                browser and device type, pages viewed, links and buttons clicked, referring URL, and
                the date/time of your visit. We use cookies and similar technologies to collect this
                (see{" "}
                <a href="#cookies" style={{ color: accent }} className={linkCls}>
                  Cookies &amp; Tracking
                </a>
                ).
              </p>
              <p className="font-body text-white/80" style={pStyle}>
                <strong>Information from third parties</strong> — if you reach us through a social
                media platform or an online ad, that platform may share limited information with us
                (for example, that you clicked an ad). Our booking and ticketing vendors also
                provide reservation and check-in data tied to your visit.
              </p>
            </section>

            {/* How we use it */}
            <section>
              <h2 className={h2} style={h2Style}>
                How We Use Your Information
              </h2>
              <ul className="font-body text-white/80 space-y-2" style={listStyle}>
                <li>Take and manage reservations, waivers, payments, and refunds.</li>
                <li>Send booking confirmations, e-tickets, reminders, and service messages.</li>
                <li>Operate rewards programs, leagues, surveys, and promotions you sign up for.</li>
                <li>Respond to your questions through phone, SMS, email, or live chat.</li>
                <li>
                  Understand how our site is used and improve it (analytics, heatmaps, and session
                  replay).
                </li>
                <li>
                  Measure and improve our advertising, including ads on Google and on Meta platforms
                  (Facebook and Instagram).
                </li>
                <li>
                  Protect against fraud, abuse, and security threats, and comply with the law.
                </li>
              </ul>
            </section>

            {/* Cookies */}
            <section id="cookies" style={{ scrollMarginTop: "96px" }}>
              <h2 className={h2} style={h2Style}>
                Cookies &amp; Tracking Technologies
              </h2>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                We use cookies, pixels, tags, and similar technologies — some set by us and some by
                the partners below — to run the site, remember your cart, measure traffic, and
                improve our advertising. The tools we use include:
              </p>
              <ul className="font-body text-white/80 space-y-2" style={listStyle}>
                <li>
                  <strong>Microsoft Clarity</strong> — behavioral metrics, heatmaps, and session
                  replay to understand how visitors use the site. Clarity masking is set to
                  &ldquo;Strict,&rdquo; so text you type (names, emails, phone numbers) and payment
                  fields are not recorded.
                </li>
                <li>
                  <strong>Google Analytics 4</strong> — aggregate website traffic and usage
                  measurement.
                </li>
                <li>
                  <strong>Google Ads</strong> — conversion measurement and remarketing for our
                  Google advertising.
                </li>
                <li>
                  <strong>Meta (Facebook &amp; Instagram) business tools</strong> — where enabled,
                  the Meta Pixel and/or Conversions API help us measure ad performance and build
                  audiences (see the next section).
                </li>
                <li>
                  <strong>Vercel Analytics &amp; Speed Insights</strong> — privacy-friendly
                  performance and traffic measurement.
                </li>
                <li>
                  <strong>Strictly necessary cookies</strong> — keep the site working (e.g. your
                  booking cart and brand preference). These can&apos;t be switched off.
                </li>
              </ul>
              <p className="font-body text-white/80 mt-3" style={pStyle}>
                You can control cookies through your browser settings and the opt-out tools listed
                under{" "}
                <a href="#choices" style={{ color: accent }} className={linkCls}>
                  Your Privacy Choices
                </a>
                . We honor the Global Privacy Control (GPC) signal where required by law.
              </p>
            </section>

            {/* Advertising & Meta */}
            <section>
              <h2 className={h2} style={h2Style}>
                Advertising &amp; Social Media (including Meta)
              </h2>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                We advertise on third-party platforms, including{" "}
                <strong>Meta Platforms, Inc. (Facebook and Instagram)</strong> and{" "}
                <strong>Google</strong>. To measure and improve those ads, we may use those
                platforms&apos; business tools — for example the Meta Pixel, the Conversions API,
                and Custom Audiences.
              </p>
              <ul className="font-body text-white/80 space-y-2" style={listStyle}>
                <li>
                  When these tools are active, information such as your device identifiers, pages
                  viewed, and actions taken on our site (for example, starting or completing a
                  booking) may be shared with the advertising platform. The platform may match this
                  with its own account data to measure ad results and show you relevant ads.
                </li>
                <li>
                  We may upload contact information (such as a hashed email or phone number) to
                  create or match a <strong>Custom Audience</strong> so we can reach existing
                  customers or people like them. We only share data we have the right to share, and
                  the platform processes it under its own data policy and our agreement with it.
                </li>
                <li>
                  These platforms act as independent controllers of the data they receive. To
                  understand and control how Meta uses your information, see the{" "}
                  <a
                    href="https://www.facebook.com/privacy/policy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    Meta Privacy Policy
                  </a>{" "}
                  and your{" "}
                  <a
                    href="https://accountscenter.facebook.com/ad_preferences"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    Meta ad preferences
                  </a>
                  .
                </li>
              </ul>
              <p className="font-body text-white/80 mt-3" style={pStyle}>
                Our pages may also include social media buttons or embedded content (Facebook,
                Instagram, YouTube). Those platforms may set their own cookies and receive data
                about your visit, governed by their privacy policies.
              </p>
            </section>

            {/* Sharing */}
            <section>
              <h2 className={h2} style={h2Style}>
                How We Share Information
              </h2>
              <p className="font-body text-white/80 mb-3" style={pStyle}>
                We do not sell your personal information for money. We share it only as described
                here:
              </p>
              <ul className="font-body text-white/80 space-y-2" style={listStyle}>
                <li>
                  <strong>Service providers</strong> who run parts of our business on our behalf —
                  payments (Square), reservations and waivers (BMI Leisure), kart-timing and
                  ticketing (SMS-Timing), analytics (Microsoft, Google, Vercel), hosting (Vercel),
                  and live chat / phone (3CX). They may use the data only to provide their service
                  to us.
                </li>
                <li>
                  <strong>Advertising and analytics partners</strong> (Meta, Google) as described
                  above. Under California law, the use of cookies and similar tools for
                  cross-context behavioral advertising may be considered &ldquo;sharing&rdquo; — you
                  can opt out (see{" "}
                  <a href="#choices" style={{ color: accent }} className={linkCls}>
                    Your Privacy Choices
                  </a>
                  ).
                </li>
                <li>
                  <strong>Legal and safety</strong> — to comply with the law, enforce our terms,
                  respond to lawful requests, or protect the rights, property, and safety of our
                  guests, staff, and business.
                </li>
                <li>
                  <strong>Business transfers</strong> — in connection with a merger, acquisition, or
                  sale of assets, your information may be transferred as part of that transaction.
                </li>
              </ul>
            </section>

            {/* Choices */}
            <section id="choices" style={{ scrollMarginTop: "96px" }}>
              <h2 className={h2} style={h2Style}>
                Your Privacy Choices &amp; Rights
              </h2>
              <ul className="font-body text-white/80 space-y-2" style={listStyle}>
                <li>
                  <strong>Cookies &amp; browser controls</strong> — block or delete cookies in your
                  browser, and enable Global Privacy Control (GPC) to signal your opt-out
                  automatically.
                </li>
                <li>
                  <strong>Meta ads</strong> — adjust your{" "}
                  <a
                    href="https://accountscenter.facebook.com/ad_preferences"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    Meta ad preferences
                  </a>
                  .
                </li>
                <li>
                  <strong>Google ads &amp; analytics</strong> — use{" "}
                  <a
                    href="https://adssettings.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    Google Ads Settings
                  </a>{" "}
                  and the{" "}
                  <a
                    href="https://tools.google.com/dlpage/gaoptout"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    GA opt-out add-on
                  </a>
                  .
                </li>
                <li>
                  <strong>Industry opt-outs</strong> — opt out of many advertisers at once via the{" "}
                  <a
                    href="https://optout.aboutads.info/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    DAA
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://optout.networkadvertising.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    NAI
                  </a>{" "}
                  opt-out pages.
                </li>
                <li>
                  <strong>Marketing messages</strong> — unsubscribe from marketing emails using the
                  link in any message, and reply STOP to opt out of marketing texts. We may still
                  send transactional messages (booking confirmations, reminders).
                </li>
                <li>
                  <strong>Access, correction &amp; deletion</strong> — depending on where you live
                  (for example, California&apos;s CCPA/CPRA), you may have the right to access,
                  correct, delete, or limit the sharing of your personal information, and not to be
                  discriminated against for exercising those rights. To make a request, email{" "}
                  <a
                    href={`mailto:${contactEmail}?subject=Privacy%20request`}
                    style={{ color: accent }}
                    className={linkCls}
                  >
                    {contactEmail}
                  </a>
                  . We will verify your request before acting on it.
                </li>
              </ul>
            </section>

            {/* Children */}
            <section>
              <h2 className={h2} style={h2Style}>
                Children&apos;s Privacy
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                Our website is intended for a general audience and is not directed at children under
                13. We do not knowingly collect personal information directly from children. When a
                child participates in a program such as a birthday party or Kids Bowl Free, we
                collect information from the parent or guardian who makes the booking, not from the
                child. If you believe a child has provided us personal information, contact us at{" "}
                <a
                  href={`mailto:${contactEmail}?subject=Children%27s%20privacy`}
                  style={{ color: accent }}
                  className={linkCls}
                >
                  {contactEmail}
                </a>{" "}
                and we will delete it.
              </p>
            </section>

            {/* Retention */}
            <section>
              <h2 className={h2} style={h2Style}>
                Data Retention
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                We keep personal information for as long as needed to provide our services, comply
                with legal, tax, and accounting obligations, resolve disputes, and enforce our
                agreements. Analytics data is retained according to each provider&apos;s default
                retention settings.
              </p>
            </section>

            {/* Security */}
            <section>
              <h2 className={h2} style={h2Style}>
                Security
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                We use reasonable administrative, technical, and physical safeguards to protect your
                information, including encrypted connections (HTTPS) and a payment processor that
                handles card data in a PCI-compliant environment. No method of transmission or
                storage is 100% secure, so we cannot guarantee absolute security.
              </p>
            </section>

            {/* Third-party links */}
            <section>
              <h2 className={h2} style={h2Style}>
                Third-Party Links
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                Our site links to third-party sites and tools (for example, gift cards, job
                applications, and our booking partners). We are not responsible for their privacy
                practices. Review their policies before providing information.
              </p>
            </section>

            {/* Changes */}
            <section>
              <h2 className={h2} style={h2Style}>
                Changes to This Policy
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                We may update this Privacy Policy from time to time. When we do, we&apos;ll revise
                the &ldquo;Effective&rdquo; date above and, if the changes are material, provide a
                more prominent notice. Your continued use of the site after an update means you
                accept the revised policy.
              </p>
            </section>

            {/* Contact */}
            <section>
              <h2 className={h2} style={h2Style}>
                Contact Us
              </h2>
              <p className="font-body text-white/80" style={pStyle}>
                Questions about this policy or your information? Contact {legalEntity} at{" "}
                <a
                  href={`mailto:${contactEmail}?subject=Privacy%20question`}
                  style={{ color: accent }}
                  className={linkCls}
                >
                  {contactEmail}
                </a>
                .
              </p>
            </section>

            <p className="font-body text-white/50 text-sm pt-4 border-t border-white/10">
              This policy applies to {siteDomain}. {brandName} is operated by {legalEntity}.
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
