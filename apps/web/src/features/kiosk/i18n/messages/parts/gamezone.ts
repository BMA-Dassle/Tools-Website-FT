/**
 * Game Zone card buy/reload flow (KioskGameZone) i18n fragment.
 *
 * Own file so screen conversions never collide on the core en.ts/es.ts. Add
 * `"gamezone.*"` keys to `gamezoneEn`; mirror EVERY key in `gamezoneEs` (the
 * Record type makes a gap a compile error). es values are a first-pass AI
 * translation pending native-Spanish review. "Game Zone" stays untranslated
 * (locked glossary).
 */
export const gamezoneEn = {} as const;

export const gamezoneEs: Record<keyof typeof gamezoneEn, string> = {};
