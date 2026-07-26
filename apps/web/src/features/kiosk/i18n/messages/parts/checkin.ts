/** NEW check-in strings from main's reworked KioskCheckinFlow (split itinerary +
 *  sign-in pages, race-assignment UX, express pills, done-screen race button).
 *  The ORIGINAL check-in keys still live in the core en.ts/es.ts under
 *  `checkin.*` — REUSE those where the string is unchanged; only add keys HERE
 *  that don't already exist in en.ts (disjoint key sets — no collision). */
export const checkinEn = {} as const;

export const checkinEs: Record<keyof typeof checkinEn, string> = {};
