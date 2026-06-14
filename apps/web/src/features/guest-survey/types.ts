/**
 * Shared types for the guest-survey feature.
 *
 * Schema-level types (GuestSurveyRow, GuestSurveyQuestion, SurveyOrigin, etc.)
 * live in apps/web/lib/guest-survey-db.ts and are re-exported here for the
 * convenience of feature-internal consumers — so they import from one place.
 */

export type {
  SurveyOrigin,
  SurveyRewardKind,
  SurveyQuestionKind,
  SurveyQuestionTag,
  GuestSurveyQuestion,
  GuestSurveyRow,
  GuestSurveyPromoCode,
} from "@/lib/guest-survey-db";

import type { SurveyQuestionTag } from "@/lib/guest-survey-db";

/** Outcome of an enqueue attempt — returned for ops logging + tests. */
export type EnqueueOutcome =
  | { status: "sent"; surveyId: string; token: string; tags: SurveyQuestionTag[] }
  | { status: "skipped"; reason: SkipReason; detail?: string };

/**
 * Reasons we deliberately did not send. Each value gets recorded as a
 * `marketing_touches` row with event = 'skipped' for ops visibility.
 */
export type SkipReason =
  | "already_sent_for_origin_ref"
  | "within_frequency_window"
  | "no_marketing_consent"
  | "audience_resolve_failed"
  | "no_phone"
  | "no_db"
  // Racing only: the racer is a minor (a guardian is on file). We never
  // survey minors, and we never redirect the survey to the guardian.
  | "minor";

export interface EnqueueBowlingSurveyInput {
  /** Neon bowling_reservations.id — used as the origin_ref. */
  reservationId: string;
  /** Guest phone — passed through audience resolve. */
  phone: string;
  /** Guest display name (single string, e.g. "Ada Lovelace"). */
  guestName?: string;
  /** Guest email — optional, used to enrich the Square customer record. */
  guestEmail?: string;
  /** QAMF center code — e.g. "TXBSQN0FEKQ11". */
  centerCode: string;
  /** Visit date in YYYY-MM-DD (center timezone). */
  visitDate: string;
  /** ISO timestamp the guest is considered to have completed the visit. */
  completedAt?: string;
}

export interface EnqueueRacingSurveyInput {
  /** vt3 video code — unique per race video; used as the origin_ref so the
   *  (origin='racing', origin_ref) unique index makes the send idempotent. */
  videoCode: string;
  /** Racer's OWN phone (never the guardian's). Empty/absent → skip. */
  phone?: string;
  /** Racer display name (single string, e.g. "Ada Lovelace"). */
  guestName?: string;
  /** Racer's OWN email — optional, used for the SMS-failure fallback. */
  guestEmail?: string;
  /** FastTrax Square location id (center_code) — "LAB52GY480CJF". */
  centerCode: string;
  /** Visit date in YYYY-MM-DD (center timezone). */
  visitDate: string;
  /** True when a guardian is on file for this racer (i.e. a minor). When
   *  true the survey is skipped outright — minors are never surveyed and
   *  the invite is never redirected to the guardian. */
  isMinor?: boolean;
}
