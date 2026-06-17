/**
 * Have-A-Ball league schedule + mid-season join math.
 *
 * Single source of truth shared by the quote endpoint (display) and the join
 * endpoint (charge). Pure, date-string based — no timezone surprises, no
 * floating-point money.
 *
 * The league bills 12 weekly charges of $20 + Lee County tax, every Tuesday
 * from the season start. The online form only sets up the SUBSCRIPTION over the
 * remaining Tuesdays — it does not charge for weeks already played. A mid-season
 * joiner is, however, responsible for a one-time RETRO payment covering the
 * weeks already missed; that amount is disclosed here (missedWeeks /
 * retroAmountCents) for the form + emails, but collected separately by staff —
 * the form never charges it.
 *
 * Join-day rule: the subscription starts the NEXT Tuesday after signup, so a
 * bowler who joins on a league Tuesday is not billed for that night by the
 * subscription (it counts as a missed/retro week). Deterministic — no reliance
 * on same-day Square billing.
 */

/** HeadPinz Fort Myers Square location. */
export const HAB_LOCATION_ID = "TXBSQN0FEKQ11";
/** "Have A Ball" full-season plan variation (WEEKLY × 12, RELATIVE pricing). */
export const HAB_PLAN_VARIATION_ID = "VGQZDMULELNJNVLC3SUSY2R3";

/**
 * "Have A Ball" WEEKLY plan variations keyed by the number of charges remaining.
 * Each is RELATIVE-priced (price comes from the subscription's order template)
 * and has a fixed `periods` count equal to its key, so the subscription bills
 * exactly that many Tuesdays and then completes on its own — no `canceled_date`
 * needed, which also sidesteps Square's future-date +1 shift on the cap.
 * All under plan LAKSOX2AKTJ7AAY6UTPYK7E7. Created 2026-06-16.
 */
export const HAB_PLAN_VARIATION_BY_REMAINING: Readonly<Record<number, string>> = {
  12: HAB_PLAN_VARIATION_ID,
  11: "3J7LPA4KLZ25BOOYPBJBCLJM",
  10: "ZERDVGN2OHTR4PFV67DSD2IH",
  9: "7LUSLN3DHFSHRRCXTLN56SWY",
  8: "TVLPFCHCPHGVZNFEXMG5X35O",
  7: "2ULH65AUVNG4D2EX4PAUC5GL",
  6: "LQIT4BG2FFS5ZQEO4433545U",
  5: "GWX46J37YAPSSKQC2W6J4YEG",
  4: "2POXMBXRGHEVEGZMWDMCZI5D",
  3: "NVQBYL5ATAEVB3CM6EIYBA45",
  2: "HAQ4JRDW3N7WJROQTR77XFGA",
  1: "664QU2SYYHXJMH2M5TOUTSWH",
};

/**
 * The Square plan variation whose fixed period count matches `remaining` weekly
 * charges. Throws if there's no variation for that count (only 1–12 exist).
 */
export function habPlanVariationForRemaining(remaining: number): string {
  const id = HAB_PLAN_VARIATION_BY_REMAINING[remaining];
  if (!id) {
    throw new Error(`No Have-A-Ball plan variation for ${remaining} remaining week(s)`);
  }
  return id;
}
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
export const HAB_TOTAL_WEEKS = HAB_BILLING_DATES.length;
export const HAB_SEASON_TOTAL_CENTS = HAB_TOTAL_WEEKS * HAB_WEEKLY_TOTAL_CENTS;

export type JoinStatus = "preseason" | "midseason" | "closed";

export interface JoinPlan {
  status: JoinStatus;
  /** YYYY-MM-DD the recurring subscription starts (next upcoming Tuesday). */
  subStartDate: string;
  /** Number of remaining weekly subscription charges. */
  remainingCharges: number;
  /** Per-week charge incl. tax, in cents. */
  weeklyTotalCents: number;
  /** Subscription total over the remaining weeks (auto-charged), in cents. */
  totalDueCents: number;
  /**
   * Weeks already played before this signup. DISCLOSURE ONLY — the bowler owes
   * a one-time retro payment for these, collected separately by staff. The form
   * never charges this.
   */
  missedWeeks: number;
  /** One-time retro amount owed for missed weeks incl. tax, in cents (disclosure only). */
  retroAmountCents: number;
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
 * Compute the go-forward subscription plan for a bowler joining on `todayYmd`,
 * plus the disclosure-only retro amount owed for weeks already missed.
 *
 * - Before the season: full 12-week subscription from May 26, no retro.
 * - During the season: a subscription over the remaining (future) Tuesdays only.
 *   Weeks already played are surfaced as missedWeeks / retroAmountCents so the
 *   form + emails can tell the bowler they owe a one-time retro payment — but
 *   the form never charges it (staff collect it separately).
 * - After the final charge: closed.
 *
 * Invariant: missedWeeks + remainingCharges === HAB_TOTAL_WEEKS (unless closed).
 */
export function computeJoinPlan(todayYmd: string): JoinPlan {
  const base = {
    weeklyTotalCents: HAB_WEEKLY_TOTAL_CENTS,
  };

  // Pre-season — full season from day one, nothing missed.
  if (todayYmd < HAB_SEASON_START) {
    return {
      ...base,
      status: "preseason",
      subStartDate: HAB_SEASON_START,
      remainingCharges: HAB_TOTAL_WEEKS,
      totalDueCents: HAB_TOTAL_WEEKS * HAB_WEEKLY_TOTAL_CENTS,
      missedWeeks: 0,
      retroAmountCents: 0,
    };
  }

  // Season over — no more charges to schedule.
  if (todayYmd > HAB_LAST_CHARGE_DATE) {
    return {
      ...base,
      status: "closed",
      subStartDate: HAB_LAST_CHARGE_DATE,
      remainingCharges: 0,
      totalDueCents: 0,
      missedWeeks: HAB_TOTAL_WEEKS,
      retroAmountCents: HAB_TOTAL_WEEKS * HAB_WEEKLY_TOTAL_CENTS,
    };
  }

  // Mid-season: subscription picks up the remaining (future) Tuesdays only.
  // Weeks on or before today are "missed" — disclosed as a retro amount owed.
  const missedWeeks = HAB_BILLING_DATES.filter((d) => d <= todayYmd).length;
  const futureDates = HAB_BILLING_DATES.filter((d) => d > todayYmd);
  const remainingCharges = futureDates.length;
  const subStartDate = futureDates[0] ?? HAB_LAST_CHARGE_DATE;

  return {
    ...base,
    status: "midseason",
    subStartDate,
    remainingCharges,
    totalDueCents: remainingCharges * HAB_WEEKLY_TOTAL_CENTS,
    missedWeeks,
    retroAmountCents: missedWeeks * HAB_WEEKLY_TOTAL_CENTS,
  };
}

/** Format a cents amount as a `$X.XX` string. */
export function habFormatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Return the YYYY-MM-DD one day before `ymd`.
 *
 * Square's CreateSubscription stores an explicit future `start_date` as the date
 * we send PLUS ONE DAY — verified empirically: every weekday maps +1 (Mon→Tue,
 * Tue→Wed, …). Existing members don't show this because they were created with
 * an immediate start, not a future date. So to make the first charge land on the
 * intended Tuesday, we send (intended − 1 day). If Square ever fixes this, the
 * first charge will land a day early and this compensation must be removed.
 */
export function habMinusOneDay(ymd: string): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
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
