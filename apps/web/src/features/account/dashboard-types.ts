/**
 * Shared types for the logged-in customer dashboard (GET /api/account/dashboard).
 * One payload aggregates four independent domains; each external section carries
 * its own `status` so a slow/failing upstream (BMI, Square) degrades only that
 * card instead of failing the whole page. Money is in cents; dates are ISO.
 *
 * These are DTOs sent to the browser — they intentionally expose far less than
 * the underlying DB rows / Square objects.
 */

import type { ContactType } from "./types";

/**
 * - `ok`            — the section loaded (it may still be empty, e.g. no rewards account).
 * - `unavailable`   — the upstream errored; show a "couldn't load, retry" state.
 * - `not_applicable`— the verified contact can't access this section (Rewards/Race
 *                     need a verified PHONE; an email-only session shows a prompt).
 */
export type SectionStatus = "ok" | "unavailable" | "not_applicable";

export type DashProductKind = "kbf" | "open" | "race" | "attraction";
export type DashBrand = "fasttrax" | "headpinz";

export interface DashReservation {
  id: number;
  productKind: DashProductKind;
  centerCode: string;
  brand: DashBrand;
  status: string;
  /** True for cancelled rows — always rendered under "past" with a badge. */
  cancelled: boolean;
  /** Naive ET wall-clock ISO ("2026-06-15T13:30:00") — the real event time. */
  eventAt: string;
  bookedAt: string;
  playerCount: number | null;
  guestName: string | null;
  shortCode: string | null;
  /** Absolute `${SITE_URL}/s/{code}` link to the multi-activity confirmation page, or null. */
  confirmationUrl: string | null;
  /** square_dayof_order_id when this row is one leg of a combo; groups the two legs. */
  comboGroupId: string | null;
  comboSpecialId: string | null;
  /** Line-item labels (e.g. "2 × Pizza Bowl", "Laser Tag"). */
  lineSummary: string[];
}

export interface DashGroupEvent {
  id: number;
  eventName: string | null;
  eventDate: string;
  centerName: string;
  status: string;
  totalCents: number;
  collectedCents: number;
  balanceCents: number;
  /** Customer-facing contract/portal link (`/contract/{short_id}`), or null if none. */
  contractUrl: string | null;
}

export interface DashRewards {
  status: SectionStatus;
  account: {
    /** Points balance (integer points, not dollars). */
    balance: number;
    lifetimePoints: number;
    enrolledAt: string | null;
  } | null;
}

export interface DashRaceCandidate {
  personId: string;
  firstName: string;
  lastName: string;
}

export interface DashRaceAccount {
  status: SectionStatus;
  /** True when phone matched >1 BMI person; UI shows a picker instead of guessing. */
  ambiguous?: boolean;
  candidates?: DashRaceCandidate[];
  person: {
    /** RAW string — never coerced through Number(). */
    personId: string;
    firstName: string;
    lastName: string;
    waiverValid: boolean;
    waiverExpiry: string | null;
    lastVisit: string | null;
  } | null;
  /** Redeemable race credits/deposits (sum of positive balances), or null when none. */
  credits: {
    totalBalance: number;
    items: Array<{ kind: string; balance: number }>;
  } | null;
}

export interface AccountDashboardResponse {
  contactMasked: string;
  contactType: ContactType;
  reservations: {
    status: SectionStatus;
    upcoming: DashReservation[];
    past: DashReservation[];
  };
  groupEvents: {
    status: SectionStatus;
    items: DashGroupEvent[];
  };
  rewards: DashRewards;
  raceAccount: DashRaceAccount;
}
