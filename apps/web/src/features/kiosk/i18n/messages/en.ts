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
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
