/**
 * Combo Specials — declarative registry. The single source of truth for
 * (a) the marketing cards (attractions / pricing / home teaser) and
 * (b) the v2 booking flow's fixed combo pricing.
 *
 * Adding a future combo is a data change here, not a UI/booking refactor.
 * Mirrors the declarative pattern of `lib/packages.ts` and
 * `features/booking/service/membership-discounts.ts`.
 *
 * NAMING: in this codebase "combo" alone already means the 3-pack race SKUs
 * (`packType: "combo"`). This feature is "combo SPECIALS" — always
 * `comboSpecialId` / `ComboSpecial`, never bare `comboId`.
 *
 * See tasks/combo-specials-plan.md for the locked owner decisions:
 *  - any race tier/track (Mega included) at the flat price
 *  - Mon–Thu (incl. Mega Tuesday) = weekday tier; Fri–Sun = weekend tier
 *  - 100% of the combo price is charged upfront at booking
 */

import { scheduleForDate } from "~/features/booking/service/race-pricing";
import type { CenterCode } from "~/features/booking/types";

/** One component of a combo. `choose-one` is a forward-compat option group. */
export type ComboComponent =
  | { kind: "race"; raceCount: number }
  | { kind: "bowling"; durationMinutes: number }
  | { kind: "attraction"; slug: string }
  | { kind: "choose-one"; label: string; options: ComboComponent[] };

export interface ComboSpecial {
  /** Kebab slug — route param + session.comboSpecialId. */
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  /** Display bullets, e.g. ["2 Go-Kart Races", "1.5 Hours of Bowling"]. */
  includes: string[];
  heroImage: string;
  /** Tailwind-free accent (used for the card's dashed border / badge). */
  accentColor: string;
  /** Physical complex. Racing is Fort Myers-only. */
  center: CenterCode;
  /** Per-PERSON price in CENTS by day tier (Mega Tuesday = weekday). */
  price: { weekday: number; weekend: number };
  components: ComboComponent[];
  enabled: boolean;
  displayOrder?: number;
  /** Optional seasonal window for future combos (mirrors discount-codes). */
  availability?: { startsAt?: string; expiresAt?: string; allowedWeekdays?: number[] };
}

/**
 * Flag: default ON unless explicitly set to "false" (plan §booking layer —
 * Vercel prod keeps it "false" until the staff canary passes).
 */
const COMBO_RACE_BOWL_ENABLED = process.env.NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED !== "false";

export const COMBO_SPECIALS: ComboSpecial[] = [
  {
    id: "race-bowl",
    name: "Race + Bowl Combo",
    shortDescription: "2 go-kart races plus 1.5 hours of bowling — one price, one booking.",
    longDescription:
      "Race two heats on our high-speed electric karts, then wind down with 1.5 hours " +
      "of bowling at HeadPinz — all in one visit, booked and paid in one checkout.",
    includes: ["2 Go-Kart Races", "1.5 Hours of Bowling"],
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-combos.webp",
    accentColor: "rgb(228,28,29)",
    center: "fort-myers",
    price: { weekday: 6500, weekend: 7500 },
    components: [
      { kind: "race", raceCount: 2 },
      { kind: "bowling", durationMinutes: 90 },
    ],
    enabled: COMBO_RACE_BOWL_ENABLED,
    displayOrder: 10,
  },
];

/** Look up a combo by id (enabled or not — callers gate separately). */
export function getComboSpecial(id: string): ComboSpecial | null {
  return COMBO_SPECIALS.find((c) => c.id === id) ?? null;
}

/** Is the combo within its availability window (if it has one)? */
export function comboAvailableOn(combo: ComboSpecial, dateYmd: string | Date): boolean {
  const a = combo.availability;
  if (!a) return true;
  const d = typeof dateYmd === "string" ? dateYmd.split("T")[0] : toYmd(dateYmd);
  if (a.startsAt && d < a.startsAt.split("T")[0]) return false;
  if (a.expiresAt && d > a.expiresAt.split("T")[0]) return false;
  if (a.allowedWeekdays && a.allowedWeekdays.length > 0) {
    const day = localDay(d);
    if (!a.allowedWeekdays.includes(day)) return false;
  }
  return true;
}

/** Enabled combos in display order — what the marketing surfaces render. */
export function enabledCombos(): ComboSpecial[] {
  return COMBO_SPECIALS.filter((c) => c.enabled).sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  );
}

/**
 * Per-person combo price (cents) for a calendar date. Reuses the race
 * schedule resolution: `weekend` (Fri/Sat/Sun) → weekend tier; `weekday`
 * AND `mega` (Tuesday) → weekday tier — Mega Tuesday is priced as weekday
 * by locked owner decision.
 */
export function comboPriceCentsForDate(combo: ComboSpecial, dateYmd: string | Date): number {
  return scheduleForDate(dateYmd) === "weekend" ? combo.price.weekend : combo.price.weekday;
}

/** Total combo price (cents) for a date × headcount. */
export function comboTotalCents(
  combo: ComboSpecial,
  dateYmd: string | Date,
  headcount: number,
): number {
  return comboPriceCentsForDate(combo, dateYmd) * Math.max(0, Math.floor(headcount));
}

/** The fixed race component (first `race` entry), if the combo has one. */
export function comboRaceComponent(
  combo: ComboSpecial,
): { kind: "race"; raceCount: number } | null {
  return (
    (combo.components.find((c) => c.kind === "race") as { kind: "race"; raceCount: number }) ?? null
  );
}

/** The fixed bowling component (first `bowling` entry), if the combo has one. */
export function comboBowlingComponent(
  combo: ComboSpecial,
): { kind: "bowling"; durationMinutes: number } | null {
  return (
    (combo.components.find((c) => c.kind === "bowling") as {
      kind: "bowling";
      durationMinutes: number;
    }) ?? null
  );
}

/* ── local helpers ─────────────────────────────────────────────────── */

function toYmd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Day-of-week (0–6) of a YYYY-MM-DD via local-time construction (UTC-trap safe). */
function localDay(ymd: string): number {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(ymd).getDay();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}
