import Image from "next/image";

import BookingLink from "@/components/BookingLink";
import type { ComboSpecial } from "~/features/combos";

/** Cents → "$65" (whole dollars) or "$65.50" when not whole. */
export function formatComboPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * One combo-specials marketing card. Markup mirrors the attractions-page
 * card (rgba(7,16,39,0.5) panel, 1.78px dashed accent border, clamp'd image
 * band, pill CTA) so the visual stays consistent across surfaces.
 */
export default function ComboSpecialCard({ combo }: { combo: ComboSpecial }) {
  return (
    <div
      className="flex flex-col"
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${combo.accentColor}`,
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      {/* Card image */}
      <div className="relative flex-shrink-0" style={{ height: "clamp(150px, 25vw, 200px)" }}>
        <Image
          src={combo.heroImage}
          alt={combo.name}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
      </div>

      {/* Card content */}
      <div className="flex flex-col flex-1" style={{ padding: "24px 20px" }}>
        <h3
          className="font-heading uppercase mb-3"
          style={{ color: combo.accentColor, fontSize: "22px", letterSpacing: "1.2px" }}
        >
          {combo.name}
        </h3>
        <p
          className="font-body mb-4"
          style={{ color: "rgba(245,236,238,0.8)", fontSize: "14px", lineHeight: "1.5" }}
        >
          {combo.shortDescription}
        </p>
        <ul
          className="font-heading uppercase mb-4"
          style={{
            color: "rgba(245,236,238,0.8)",
            fontSize: "16px",
            lineHeight: "2",
            letterSpacing: "0.8px",
          }}
        >
          {combo.includes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="font-body flex-1 mb-4" style={{ fontSize: "15px", lineHeight: "1.6" }}>
          <strong className="text-white">
            {formatComboPrice(combo.price.weekday)}/person Mon–Thu
          </strong>
          <span style={{ color: "rgba(245,236,238,0.8)" }}>
            {" "}
            · {formatComboPrice(combo.price.weekend)}/person Fri–Sun
          </span>
        </p>
        <BookingLink
          href={`/book/combo/${combo.id}/v2`}
          className="block text-center font-body font-semibold uppercase text-white tracking-wider transition-all hover:scale-105 mt-auto"
          style={{
            backgroundColor: combo.accentColor,
            borderRadius: "555px",
            padding: "16px 24px",
            fontSize: "14px",
          }}
        >
          Book This Combo
        </BookingLink>
      </div>
    </div>
  );
}
