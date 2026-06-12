import Image from "next/image";

import BookingLink from "@/components/BookingLink";
import type { ComboSpecial } from "~/features/combos";

const GOLD = "#FFD700";

/** Cents → "$65" (whole dollars) or "$65.50" when not whole. */
export function formatComboPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * One combo-specials marketing card. Markup mirrors the attractions-page
 * card (rgba(7,16,39,0.5) panel, 1.78px dashed accent border, clamp'd image
 * band, pill CTA) so the visual stays consistent across surfaces.
 *
 * `premium` combos render the double-size treatment: the grid gives them two
 * columns on desktop (see ComboSpecials), the image band is taller (≈double
 * height on mobile), gold glow + an ULTIMATE VIP ribbon, and the perks list.
 */
export default function ComboSpecialCard({ combo }: { combo: ComboSpecial }) {
  const premium = !!combo.premium;

  return (
    <div
      className={`flex flex-col ${premium ? "sm:col-span-2 lg:col-span-2" : ""}`}
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${combo.accentColor}`,
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: premium ? `0 0 32px ${GOLD}26` : undefined,
      }}
    >
      {/* Card image — premium gets a DOUBLE-height band (vs the 150–200px
          standard card) so the tile reads twice the size on mobile too */}
      <div
        className="relative flex-shrink-0"
        style={{
          height: premium ? "clamp(300px, 60vw, 400px)" : "clamp(150px, 25vw, 200px)",
        }}
      >
        <Image
          src={combo.heroImage}
          alt={combo.name}
          fill
          className="object-cover"
          sizes={premium ? "(max-width: 640px) 100vw, 66vw" : "(max-width: 640px) 100vw, 33vw"}
        />
        {premium && (
          <>
            <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/85 via-transparent to-transparent" />
            <div className="absolute left-4 top-4 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest"
                style={{ backgroundColor: GOLD, color: "#0a1628" }}
              >
                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 2l2.39 4.84L18 8l-4 3.9.94 5.5L10 14.77 5.06 17.4 6 11.9 2 8l5.61-1.16L10 2z" />
                </svg>
                Ultimate VIP
              </span>
              {combo.durationLabel && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest backdrop-blur-sm"
                  style={{ backgroundColor: "rgba(7,16,39,0.75)", color: GOLD }}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path strokeLinecap="round" d="M12 6v6l4 2" />
                  </svg>
                  {combo.durationLabel}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Card content */}
      <div className="flex flex-col flex-1" style={{ padding: "24px 20px" }}>
        <h3
          className="font-heading uppercase mb-3"
          style={{
            color: combo.accentColor,
            fontSize: premium ? "28px" : "22px",
            letterSpacing: "1.2px",
            textShadow: premium ? `0 0 24px ${GOLD}55` : undefined,
          }}
        >
          {combo.name}
        </h3>
        <p
          className="font-body mb-4"
          style={{ color: "rgba(245,236,238,0.8)", fontSize: "14px", lineHeight: "1.5" }}
        >
          {combo.shortDescription}
        </p>

        <div className={premium ? "mb-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2" : "mb-4"}>
          <ul
            className="font-heading uppercase"
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
          {premium && (combo.perks?.length ?? 0) > 0 && (
            <ul className="font-body mt-3 space-y-1.5 sm:mt-0">
              {combo.perks!.map((perk) => (
                <li
                  key={perk}
                  className="flex items-center gap-2"
                  style={{ color: "rgba(245,236,238,0.75)", fontSize: "14px" }}
                >
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                  >
                    ✓
                  </span>
                  {perk}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="font-body flex-1 mb-4" style={{ fontSize: "15px", lineHeight: "1.6" }}>
          <strong className="text-white">
            {formatComboPrice(combo.price.weekday)}/person Mon–Thu
          </strong>
          <span style={{ color: "rgba(245,236,238,0.8)" }}>
            {" "}
            · {formatComboPrice(combo.price.weekend)}/person Fri–Sun
          </span>
          {premium && combo.startHours?.length === 4 && (
            <span className="block" style={{ color: "rgba(245,236,238,0.6)", fontSize: "13px" }}>
              Start times: 2 PM · 4 PM · 6 PM · 8 PM
            </span>
          )}
        </p>
        <BookingLink
          href={`/book/combo/${combo.id}/v2`}
          className="block text-center font-body font-semibold uppercase tracking-wider transition-all hover:scale-105 mt-auto"
          style={{
            backgroundColor: combo.accentColor,
            color: premium ? "#0a1628" : "#ffffff",
            borderRadius: "555px",
            padding: "16px 24px",
            fontSize: "14px",
            boxShadow: premium ? `0 0 20px ${GOLD}40` : undefined,
          }}
        >
          {premium ? "Book the VIP Experience" : "Book This Combo"}
        </BookingLink>
      </div>
    </div>
  );
}
