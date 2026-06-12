import Link from "next/link";

import { enabledCombos } from "~/features/combos";

import { formatComboPrice } from "./ComboSpecialCard";

/**
 * Compact home-page teaser for the top combo special — a single dashed-accent
 * banner linking to the full cards on /attractions#combos. Renders nothing
 * when no combo is enabled.
 */
export default function ComboTeaser() {
  const combo = enabledCombos()[0];
  if (!combo) return null;

  return (
    <div
      className="flex flex-col sm:flex-row items-center gap-6 mt-8"
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${combo.accentColor}`,
        borderRadius: "8px",
        padding: "24px 20px",
      }}
    >
      <div className="flex-1 text-center sm:text-left">
        <h3
          className="font-heading uppercase mb-2"
          style={{ color: combo.accentColor, fontSize: "24px", letterSpacing: "1.2px" }}
        >
          New: {combo.name}
        </h3>
        <p
          className="font-body"
          style={{ color: "rgba(245,236,238,0.8)", fontSize: "16px", lineHeight: "1.5" }}
        >
          {combo.includes.join(" + ")}
          {combo.durationLabel ? ` — ${combo.durationLabel}` : ""} —{" "}
          <strong className="text-white">
            from {formatComboPrice(combo.price.weekday)}/person
          </strong>
        </p>
      </div>
      <Link
        href="/attractions#combos"
        className="inline-block font-body font-bold uppercase transition-all hover:scale-105 flex-shrink-0"
        style={{
          backgroundColor: combo.accentColor,
          color: combo.premium ? "#0a1628" : "#ffffff",
          borderRadius: "555px",
          padding: "16px 24px",
          fontSize: "14px",
          letterSpacing: "0.05em",
        }}
      >
        View Combo Specials
      </Link>
    </div>
  );
}
