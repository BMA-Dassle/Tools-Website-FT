import { describe, expect, it } from "vitest";
import {
  CLOCK_GIVE_UP,
  GIVE_UP_MINUTES,
  MAX_ATTEMPTS,
  backoffSeconds,
  type SyncKind,
} from "@/lib/bmi-sync-queue";

/**
 * WHAT MAY BE ABANDONED ON A CLOCK, AND WHAT MAY NOT.
 *
 * The 2026-09-05 incident in one sentence: a Pandora outage outlasted a timer, and
 * work that was still perfectly doable got written off — 69 captured signatures,
 * 13 of them guests who raced with no waiver record at BMI. The rule that came out
 * of it (owner): "it should never completely give up unless reservation is in past
 * and it cant do anything with it."
 *
 * These tests pin the DISTINCTION, because it is the part a future edit is most
 * likely to flatten back into one number.
 */
describe("CLOCK_GIVE_UP", () => {
  it("never abandons a waiver on a clock — it is a legal record tied to a person, not a visit", () => {
    // A waiver is valid for a year and is the evidence behind a chargeback. A past
    // reservation does not make it worthless, so no timer may write it off.
    expect(CLOCK_GIVE_UP["push-waiver-signature"]).toBe(false);
  });

  it("never abandons a membership on a clock — the guest PAID for it", () => {
    expect(CLOCK_GIVE_UP["add-membership"]).toBe(false);
  });

  it("does abandon the check-in stamp — once the visit is over it has nothing to say", () => {
    // This is the ONE "reservation is in past" case, and it ends as `lapsed`
    // (not `parked`) via lapseSyncRow, so it never becomes a work order.
    expect(CLOCK_GIVE_UP["stamp-confirmation-state"]).toBe(true);
  });

  it("does abandon the in-flight booking followups — hours later there is nothing to attach to", () => {
    expect(CLOCK_GIVE_UP["repair-person-details"]).toBe(true);
    expect(CLOCK_GIVE_UP["attach-project-person"]).toBe(true);
  });

  it("covers every kind, so a new kind cannot silently inherit a default", () => {
    // Both maps are Record<SyncKind, …>, so tsc already enforces this — but a
    // kind added to one and not the other is exactly the drift that produced the
    // `persons-local` barrier skew, so assert it at runtime too.
    const kinds = Object.keys(GIVE_UP_MINUTES) as SyncKind[];
    for (const k of kinds) {
      expect(CLOCK_GIVE_UP[k], `CLOCK_GIVE_UP is missing "${k}"`).toBeTypeOf("boolean");
    }
    expect(Object.keys(CLOCK_GIVE_UP).sort()).toEqual(kinds.sort());
  });
});

describe("backoffSeconds", () => {
  it("checks fast early, because a cloud→local person lands in 19-32s", () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
  });

  it("caps at 10 minutes through the normal attempt budget", () => {
    expect(backoffSeconds(20)).toBe(600);
    expect(backoffSeconds(MAX_ATTEMPTS - 1)).toBe(600);
  });

  it("stretches to 30 minutes once a row is a long-hauler", () => {
    // Only a CLOCK_GIVE_UP:false kind can get past MAX_ATTEMPTS at all. What it is
    // waiting for is measured in hours, and hammering a down vendor every 10
    // minutes for a week buys nothing — it is how the waiver consumer turned the
    // 2026-08-14 outage into congestive collapse.
    expect(backoffSeconds(MAX_ATTEMPTS)).toBe(1_800);
    expect(backoffSeconds(MAX_ATTEMPTS + 500)).toBe(1_800);
  });

  it("never returns a non-positive delay, which would spin the cron", () => {
    for (const a of [-5, 0, 1, 7, 39, 40, 1_000]) {
      expect(backoffSeconds(a)).toBeGreaterThan(0);
    }
  });
});

/**
 * The park decision itself, as `markSyncRetry` computes it. Reproduced here rather
 * than exercised through the DB because the branch is pure arithmetic and the
 * value of pinning it is that it stays readable.
 */
function wouldPark(kind: SyncKind, attempts: number, expired: boolean): boolean {
  const patienceSpent = expired || attempts >= MAX_ATTEMPTS;
  return patienceSpent && CLOCK_GIVE_UP[kind] !== false;
}

describe("the park decision", () => {
  it("keeps a waiver pending through an outage that outlasts its deadline", () => {
    // Precisely the 2026-09-05 shape: deadline blown, attempts exhausted, and the
    // work still doable the moment the vendor answers.
    expect(wouldPark("push-waiver-signature", MAX_ATTEMPTS + 10, true)).toBe(false);
    expect(wouldPark("add-membership", MAX_ATTEMPTS + 10, true)).toBe(false);
  });

  it("ends a stamp once its deadline passes", () => {
    expect(wouldPark("stamp-confirmation-state", 0, true)).toBe(true);
  });

  it("leaves everything alone while patience remains", () => {
    for (const k of Object.keys(CLOCK_GIVE_UP) as SyncKind[]) {
      expect(wouldPark(k, 1, false)).toBe(false);
    }
  });
});
