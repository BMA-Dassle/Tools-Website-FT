/**
 * English message catalog — the SOURCE OF TRUTH.
 *
 * Keys are dot-namespaced by screen (`attract.*`, `categories.*`, …). Values are
 * ICU MessageFormat strings: `{name}` interpolates, `{n, plural, …}` pluralizes.
 * Every other locale (es.ts) is typed to `MessageKey` so a missing/extra key is
 * a compile error, and falls back to English at runtime.
 *
 * SCOPE: guest-facing kiosk copy only. Staff/admin, device, and legal-waiver
 * body text are intentionally NOT keyed here (they stay English). See
 * tasks/kiosk-i18n-spanish-plan.md.
 *
 * Locked glossary — NEVER translate these proper nouns in any locale:
 * FastTrax, HeadPinz, Game Zone, Podium, Pit Crew, Duckpin.
 */
export const en = {
  // --- Attract screen (Phase 0 spike) ---
  "attract.letsPlay": "Let’s play.",
  "attract.subtitle.racing":
    "Book racing, bowling & attractions right here — takes about a minute.",
  "attract.subtitle.bowling":
    "Book bowling, blasters & laser tag right here — takes about a minute.",
  "attract.touchToStart": "Touch to get started",

  // --- Category chooser (KioskCategories) ---
  "categories.heading.addAnything": "Add anything else?",
  "categories.heading.whatToday": "What are we doing today?",
  "categories.exp.title": "Experiences",
  "categories.exp.eyebrowFallback": "Bundled experiences",
  "categories.exp.blurb": "Multiple attractions combined into one easy price",
  "categories.attr.title": "Attractions",
  "categories.attr.eyebrow": "{count, plural, one {# attraction} other {# attractions}}",
  "categories.attr.blurb.naples": "Bowling, gel blasters, laser tag & more — pick a time and go",
  "categories.attr.blurb.default": "Racing, bowling, blasters & more — pick a time and go",
  "categories.gameZone.eyebrow.reload": "Reload · check balance",
  "categories.gameZone.eyebrow.full": "Reload · buy · 1 to 10 cards",
  "categories.gameZone.blurb.reload": "Reload your arcade card or check its balance — no waiting",
  "categories.gameZone.blurb.full": "Buy or reload arcade tokens — no waiting",
  "categories.disabled.experience":
    "Not available right now — please check back or ask an attendant.",
  "categories.disabled.attraction":
    "Nothing left to book today — the front desk can help with walk-ins.",
  "categories.backToCategories": "All categories",
  "categories.pick.experience": "Pick your experience",
  "categories.pick.attraction": "Pick an attraction",
  "categories.eyebrow.mostPopular": "Most popular",
  "categories.eyebrow.premiumRacing": "Premium racing",
  "categories.combo.priceLine": "{weekday}/person Mon–Thu · {weekend}/person Fri–Sun",
  "categories.qualifier.blurb":
    "Qualify on a Starter, then level up — POV video, free appetizer & license included.",
  "categories.qualifier.fromWeekday": "From {price}/person Mon–Thu",
  "categories.qualifier.fromWeekend": "From {price}/person Fri–Sun",
  "categories.qualifier.disabled":
    "Not enough time left today to fit both races — please check back or ask an attendant.",
  "categories.emptyShelf": "No bundled experiences are running at this location today.",
  "categories.gameZone.unavailable.title": "Game Zone cards not available on this kiosk",
  "categories.gameZone.unavailable.note": "Please use another kiosk or see Guest Services",
  "categories.tile.unavailable": "Unavailable",
  "categories.tile.atVenue": "At {venue}",
  "categories.exp.nextAvailable": "Next available · {time}",
  "categories.exp.nextAvailableSlots":
    "Next available · {time} · {count, plural, one {# slot} other {# slots}}",
  "categories.tile.nextLane": "Next lane · {time}",
  "categories.tile.countTables": "{count, plural, one {# table} other {# tables}} · {time}",
  "categories.tile.countPlayers": "{count, plural, one {# player} other {# players}} · {time}",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
