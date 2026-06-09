/**
 * Have-A-Ball league schedule + mid-season join math.
 *
 * Single source of truth shared by the quote endpoint (display) and the join
 * endpoint (charge). Pure, date-string based — no timezone surprises, no
 * floating-point money.
 *
 * The league bills 12 weekly charges of $20 + Lee County tax, every Tuesday
 * from the season start. A mid-season joiner pays the SAME season total:
 *   - back-pay = weeks already played (or playable today), charged once today
 *   - subscription = remaining Tuesdays, capped to stop after the final charge
 *
 * Join-day rule (confirmed with ops): signing up on a league Tuesday counts
 * that day as a back-pay week (they bowl that night); the subscription starts
 * the NEXT Tuesday. Deterministic — no reliance on same-day Square billing.
 */

/** HeadPinz Fort Myers Square location. */
export const HAB_LOCATION_ID = "TXBSQN0FEKQ11";
/** "Have A Ball" subscription plan variation (WEEKLY × 12, RELATIVE pricing). */
export const HAB_PLAN_VARIATION_ID = "VGQZDMULELNJNVLC3SUSY2R3";
/** "Have A Ball" catalog item variation — $20, FIXED pricing. */
export const HAB_ITEM_VARIATION_ID = "HO5ZCRAWE35NMYDHSP2RXMM2";
/** Lee County Sales Tax — 6.5%. HeadPinz Fort Myers sits in Lee County. */
export const HAB_LEE_COUNTY_TAX_ID = "UBPQTR3W6ZKVRYFC7DXN2SJN";

export const HAB_TIMEZONE = "America/New_York";

/** Weekly base price (pre-tax), in cents. */
export const HAB_WEEKLY_BASE_CENTS = 2000;
/** Weekly total incl. 6.5% Lee County tax ($20 × 1.065 = $21.30), in cents. */
export const HAB_WEEKLY_TOTAL_CENTS = 2130;

/**
 * The 12 weekly billing dates (Tuesdays), starting 2026-05-26.
 * Hardcoded rather than computed so DST / off-by-one can never shift a charge.
 * If a future season skips a holiday week, edit this list — it is the schedule.
 */
export const HAB_BILLING_DATES = [
  "2026-05-26",
  "2026-06-02",
  "2026-06-09",
  "2026-06-16",
  "2026-06-23",
  "2026-06-30",
  "2026-07-07",
  "2026-07-14",
  "2026-07-21",
  "2026-07-28",
  "2026-08-04",
  "2026-08-11",
] as const;

export const HAB_SEASON_START = HAB_BILLING_DATES[0];
export const HAB_LAST_CHARGE_DATE = HAB_BILLING_DATES[HAB_BILLING_DATES.length - 1];
/**
 * canceled_date for mid-season subscriptions. Square stops billing a fixed-cycle
 * plan at this date; set to the cycle boundary AFTER the final charge (Aug 11 +
 * 7d) so the Aug 11 charge runs in full and nothing bills after — no proration.
 */
export const HAB_CANCEL_DATE = "2026-08-18";
export const HAB_TOTAL_WEEKS = HAB_BILLING_DATES.length;
export const HAB_SEASON_TOTAL_CENTS = HAB_TOTAL_WEEKS * HAB_WEEKLY_TOTAL_CENTS;

export type JoinStatus = "preseason" | "midseason" | "closed";

export interface JoinPlan {
  status: JoinStatus;
  /** Number of weeks billed as a one-time back-pay lump sum (0 pre-season). */
  backPayWeeks: number;
  /** Back-pay total incl. tax, in cents. */
  backPayAmountCents: number;
  /** YYYY-MM-DD the recurring subscription should start (next unbilled Tuesday). */
  subStartDate: string;
  /** Number of remaining weekly subscription charges. */
  remainingCharges: number;
  /** Per-week charge incl. tax, in cents. */
  weeklyTotalCents: number;
  /** Full-season total incl. tax, in cents (same for every bowler). */
  seasonTotalCents: number;
  /** canceled_date to cap the subscription at the final charge. */
  canceledDate: string;
}

/** Today's date in America/New_York as a YYYY-MM-DD string. */
export function habTodayYmd(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; timeZone pins it to ET regardless of host TZ.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HAB_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Compute the back-pay + go-forward breakdown for a bowler joining on `todayYmd`.
 *
 * - Before the season: back-pay = 0, full 12-week subscription from May 26.
 * - During the season: back-pay covers every billing date on or before today
 *   (today counts — they bowl tonight); the subscription starts the next date.
 * - After the final charge: closed.
 *
 * Invariant: backPayWeeks + remainingCharges === HAB_TOTAL_WEEKS (unless closed),
 * so every bowler's season total is identical.
 */
export function computeJoinPlan(todayYmd: string): JoinPlan {
  const base = {
    weeklyTotalCents: HAB_WEEKLY_TOTAL_CENTS,
    seasonTotalCents: HAB_SEASON_TOTAL_CENTS,
    canceledDate: HAB_CANCEL_DATE,
  };

  // Pre-season — original behavior: no back-pay, full season from day one.
  if (todayYmd < HAB_SEASON_START) {
    return {
      ...base,
      status: "preseason",
      backPayWeeks: 0,
      backPayAmountCents: 0,
      subStartDate: HAB_SEASON_START,
      remainingCharges: HAB_TOTAL_WEEKS,
    };
  }

  // Season over — no more charges to schedule.
  if (todayYmd > HAB_LAST_CHARGE_DATE) {
    return {
      ...base,
      status: "closed",
      backPayWeeks: HAB_TOTAL_WEEKS,
      backPayAmountCents: 0,
      subStartDate: HAB_LAST_CHARGE_DATE,
      remainingCharges: 0,
    };
  }

  // Mid-season: today counts as back-pay; subscription starts the next date.
  const backPayWeeks = HAB_BILLING_DATES.filter((d) => d <= todayYmd).length;
  const futureDates = HAB_BILLING_DATES.filter((d) => d > todayYmd);
  const remainingCharges = futureDates.length;
  const subStartDate = futureDates[0] ?? HAB_LAST_CHARGE_DATE;

  return {
    ...base,
    status: "midseason",
    backPayWeeks,
    backPayAmountCents: backPayWeeks * HAB_WEEKLY_TOTAL_CENTS,
    subStartDate,
    remainingCharges,
  };
}

/** Format a cents amount as a `$X.XX` string. */
export function habFormatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format a YYYY-MM-DD billing date as e.g. "Tuesday, June 16, 2026" (ET). */
export function habFormatDate(ymd: string): string {
  // Parse as a UTC noon to avoid any TZ rollover, then format in ET.
  const dt = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: HAB_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}
