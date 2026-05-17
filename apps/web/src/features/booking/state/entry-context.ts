/**
 * EntryContext — typed shell for prefilled data carried into a session.
 *
 * Seeded once at session creation (from URL params, cookies, auth, deep
 * links, marketing attribution, etc.) and read by step components for
 * prefill. Every new entry-time data source extends this interface;
 * downstream consumers opt in by reading the new field. This isolates
 * "things known at entry" to one surface so future systems don't have to
 * thread props through the step tree.
 *
 * PR-B2 ships the typed shell. URL/cookie parsing + a single consumer
 * (`prefilledContact` → session contact) land in commit 3. Other fields
 * are dormant in PR-B2 — typed but unused. Do NOT delete them between PRs.
 *
 * Growth pattern: add a new optional field, do NOT overload existing ones.
 */
import type { ContactInfo } from "../types";

/** A single party member known to be coming along. */
export interface PartyMember {
  firstName: string;
  lastName: string;
  /** Member id from whatever directory system supplied them, when known. */
  externalId?: string;
  /** Age band if relevant (drives waiver gating, KBF eligibility, etc.). */
  ageBand?: "child" | "teen" | "adult";
}

/** Promotion code applied at entry. Specific to a marketing source. */
export interface PromoContext {
  code: string;
  /** Which system surfaced the code (e.g. "email-2026-spring", "gbp"). */
  source: string;
}

/**
 * Anything we know at session start. Every field is optional — sessions
 * created from a cold URL have an empty context.
 */
export interface EntryContext {
  /** Customer id from whichever directory looked them up (Pandora, BMI, future). */
  memberId?: string;
  /** Contact fields to seed the session contact with. */
  prefilledContact?: Partial<ContactInfo>;
  /** Known party members (racers, bowlers) attached to the member. */
  partyMembers?: PartyMember[];
  /** Promo code applied via URL or referral. */
  promo?: PromoContext;
  /** Marketing attribution / referrer label (free-form). */
  referrer?: string;
}

/** Convenience: an empty context. Used when the entry URL carried nothing. */
export const EMPTY_ENTRY_CONTEXT: EntryContext = Object.freeze({});
