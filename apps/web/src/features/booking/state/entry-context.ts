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
import type { ContactInfo, CenterCode } from "../types";

/**
 * A party member HINT — pre-known info carried in via deep link / member
 * portal / etc. NOT the live roster type — the wizard's party step uses
 * these as seeds and produces full `PartyMember`s in `state/types.ts`.
 *
 * Renamed from `PartyMember` (2026-05-21) to disambiguate from the live
 * roster type that lives at session.party[].
 */
export interface KnownPartyMember {
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
  partyMembers?: KnownPartyMember[];
  /** Promo code applied via URL or referral. */
  promo?: PromoContext;
  /** Marketing attribution / referrer label (free-form). */
  referrer?: string;
  /**
   * Physical center the visitor arrived for, parsed from `?location=`
   * (naples / fort-myers / headpinz / fasttrax → CenterCode). Seeds
   * session.center so cross-sell, availability, and the BMI/QAMF clientKey
   * resolve to the right complex — and so the `/book/v2` landing can scope to a
   * single center (Naples shows ONLY Naples-available activities).
   */
  center?: CenterCode;
  /**
   * World Cup VIP Bowling entry (`?experience=world-cup`) — seeds the bowling
   * item in match-picker mode (tier pinned to VIP, fixture-kickoff slots).
   * Ignored when the feature window is over or the center's flag is off.
   */
  worldCup?: true;
  /**
   * NFL Ticket on NeoVerse entry (`?experience=nfl`, or the short `/book/nfl`
   * link that redirects to it) — seeds the bowling item in game-picker mode.
   *
   * Its OWN entry, not a card inside the bowling wizard. The package fixes the
   * tier, the duration, the price and the food, and the game fixes the date and
   * the time, so every step the normal flow would ask is already answered —
   * routing a guest through them asks four questions with one legal answer
   * each. Ignored when no center can sell it (nflEnabledCenters is empty).
   */
  nfl?: true;
  /**
   * Session started on an in-center self-service kiosk (/kiosk). Read by the
   * reserve path to stamp bookingSource="kiosk" (admin board badge) and by
   * steps that behave differently on a shared public device.
   */
  kiosk?: true;
  /**
   * Session started on a TEST kiosk (kiosk 99 — isTestKiosk). Test-rig
   * affordances only, never guest behavior: e.g. the race heat grid rolls to
   * the NEXT day when today's races have run out (owner 2026-08-10: after
   * close there is nothing to test against), phone requirements relax, etc.
   */
  kioskTest?: true;
  /**
   * Preview opt-in for the single-time-pick bowling flow (`?bowlingV3=1`) —
   * activates the v3 Date/Experience/Time steps for this session while the
   * env flag is still dark. See src/features/booking/flags.ts.
   */
  bowlingV3?: true;
  /** Voucher-redemption preview opt-in (?kioskVoucher=1) — persisted on the
   *  session like bowlingV3 so idle-reset/navigation can't drop it. */
  voucherRedeem?: boolean;
  /**
   * Preview opt-in for FastTrax QAMF duckpin (`?ftDuckpin=1`) — routes the
   * duck-pin offering to QAMF center 11542 for this session while the env flag
   * is dark. See src/features/booking/flags.ts.
   */
  ftDuckpin?: true;
  /**
   * "Play Now" per-lane QR entry (`?playNow=1`) — a guest scanned the QR on a
   * specific duckpin lane. Compresses the wizard to immediate time (date/time
   * steps hidden), holds the pinned lane on entry, and auto-opens the lane on
   * the confirmation screen. Designed to generalize to other attractions later.
   * See src/features/booking/flags.ts (playNowActive) and BookingFlow's seed.
   */
  playNow?: true;
  /**
   * The physical resource (duckpin lane number) the scanned QR is attached to,
   * from `?lane=N`. Seeds BowlingItem.pinnedLaneNumber so the hold pins THIS
   * lane instead of letting QAMF auto-assign. Only meaningful with `playNow`.
   */
  pinnedLane?: number;
  /**
   * Prepaid voucher codes carried in from `?voucher=HPW-…` (comma-separated for
   * a multi-pack buy) — the hand-off from a deal-pack purchase, and from the
   * "Book this now" button on a voucher's own /v/{code} page.
   *
   * Codes only, not resolved coverage: the checkout applies them through the
   * SAME native-peek path a typed code takes, so there is one implementation of
   * "what can this voucher cover" rather than a seeded shortcut that can drift
   * from it. Discovery has to be a server call anyway — the legs depend on which
   * items are already spent.
   */
  voucherCodes?: string[];
}

/** Convenience: an empty context. Used when the entry URL carried nothing. */
export const EMPTY_ENTRY_CONTEXT: EntryContext = Object.freeze({});
