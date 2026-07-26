"use client";

/**
 * Persistent language switcher — fixed to the TOP-RIGHT of every kiosk page.
 *
 * Rendered once in the KioskShell chrome (like the bottom-right version tag), so
 * it rides above every route without each screen wiring it in. A guest taps a
 * flag to switch language live; the choice is ephemeral (LocaleProvider's
 * override) and Start-Over resets it to the device default.
 *
 * Flags are inline SVGs, NOT emoji (repo no-emoji rule). Each option is a real
 * button with the full language name as its accessible label + a short code
 * beside the flag, because a flag alone under-signifies a *language*.
 *
 * Hidden when the i18n flag is off or only one locale exists — nothing to switch.
 */
import { KIOSK_LOCALES, LOCALE_LABEL, LOCALE_SHORT, type KioskLocale } from "./locales";
import { useLocale } from "./LocaleProvider";
import { kioskI18nEnabled } from "../flags";

export function LanguageSwitcher({
  /** Fixed-position classes (canvas px). Each screen that mounts the switcher
   *  places it where it fits — attract in the welcome band, the category chooser
   *  up top above the tiles. */
  posClass = "right-[24px] top-[500px]",
}: {
  posClass?: string;
} = {}) {
  const { locale, setLocale } = useLocale();

  if (!kioskI18nEnabled() || KIOSK_LOCALES.length < 2) return null;

  return (
    <div
      className={`fixed ${posClass} z-[260] flex items-center gap-[8px] rounded-full border border-white/15 bg-[#0a1730]/85 p-[8px] shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur`}
      role="group"
      aria-label="Language"
    >
      {KIOSK_LOCALES.map((loc) => {
        const active = loc === locale;
        return (
          <button
            key={loc}
            type="button"
            aria-pressed={active}
            aria-label={LOCALE_LABEL[loc]}
            onClick={(e) => {
              e.stopPropagation();
              setLocale(loc);
            }}
            className={`flex items-center gap-[10px] rounded-full px-[18px] py-[12px] text-[26px] font-semibold transition-colors ${
              active ? "bg-[#00e2e5] text-[#04252b]" : "text-white/70"
            }`}
          >
            <FlagIcon locale={loc} />
            <span>{LOCALE_SHORT[loc]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Small rounded flag glyph per locale. Recognizable, not heraldically exact. */
function FlagIcon({ locale }: { locale: KioskLocale }) {
  const common = {
    width: 38,
    height: 26,
    viewBox: "0 0 38 26",
    "aria-hidden": true,
    className: "shrink-0 rounded-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.25)]",
  } as const;

  if (locale === "es") {
    // Spain civil flag proportions: red / yellow (double height) / red.
    return (
      <svg {...common}>
        <rect width="38" height="26" fill="#c60b1e" />
        <rect y="6.5" width="38" height="13" fill="#ffc400" />
      </svg>
    );
  }

  // United States — 13 stripes + blue canton with a scatter of stars.
  return (
    <svg {...common}>
      <rect width="38" height="26" fill="#b22234" />
      {[1, 3, 5, 7, 9, 11].map((i) => (
        <rect key={i} y={i * 2} width="38" height="2" fill="#fff" />
      ))}
      <rect width="16" height="14" fill="#3c3b6e" />
      {[3, 8, 13].map((cx) =>
        [3, 7, 11].map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1" fill="#fff" />),
      )}
    </svg>
  );
}
