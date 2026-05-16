/**
 * SEO-friendly FAQ section with FAQPage JSON-LD schema.
 *
 * Renders a styled accordion list AND emits structured data so the
 * answers are eligible for rich-result FAQ panels on Google.
 *
 * Props: title, items: [{ q, a }]
 */
import { Fragment } from "react";

interface FaqItem {
  q: string;
  a: string;
}

interface Props {
  title: string;
  items: FaqItem[];
  /** Background dark or light surface (default dark) */
  variant?: "dark" | "light";
}

export default function SeoFaq({ title, items, variant = "dark" }: Props) {
  const isDark = variant === "dark";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: it.a,
      },
    })),
  };

  return (
    <Fragment>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <section
        className={isDark ? "bg-[#0a1628]" : "bg-white"}
        style={{ padding: "clamp(40px, 8vw, 80px) clamp(16px, 4vw, 32px)" }}
      >
        <div className="max-w-4xl mx-auto">
          <h2
            className={`font-heading font-black uppercase text-center mb-8 ${
              isDark ? "text-white" : "text-[#0a1628]"
            }`}
            style={{ fontSize: "clamp(26px, 5vw, 44px)", letterSpacing: "-0.5px" }}
          >
            {title}
          </h2>
          <div className="space-y-3">
            {items.map((it) => (
              <details
                key={it.q}
                className={`group rounded-lg ${
                  isDark
                    ? "bg-white/5 border border-white/10 text-white"
                    : "bg-gray-50 border border-gray-200 text-[#0a1628]"
                }`}
              >
                <summary
                  className="cursor-pointer list-none px-5 py-4 font-body font-bold flex items-center justify-between"
                  style={{ fontSize: "clamp(15px, 2vw, 17px)" }}
                >
                  <span>{it.q}</span>
                  <span className="ml-4 text-xl transition-transform group-open:rotate-45">+</span>
                </summary>
                <div
                  className={`px-5 pb-5 font-body leading-relaxed ${
                    isDark ? "text-white/70" : "text-gray-600"
                  }`}
                  style={{ fontSize: "clamp(14px, 1.8vw, 16px)" }}
                >
                  {it.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>
    </Fragment>
  );
}
