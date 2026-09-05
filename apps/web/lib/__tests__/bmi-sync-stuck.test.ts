import { describe, expect, it } from "vitest";
import {
  GIVE_UP_MINUTES,
  STUCK_AFTER_MINUTES,
  CLOCK_GIVE_UP,
  type SyncKind,
} from "@/lib/bmi-sync-queue";

/**
 * "NOTHING IS PARKED" STOPPED MEANING "NOTHING NEEDS A HUMAN".
 *
 * Parked-row reporting was the only alarm this queue had, and it only fires when a
 * row STOPS. On 2026-09-05 two kinds became never-give-up, so they can be owed
 * forever without ever parking — and the only thing that caught a queue problem
 * that day was the owner reading the board by eye. `STUCK_AFTER_MINUTES` is the
 * alarm for work that is still trying and should not still be trying.
 */
describe("STUCK_AFTER_MINUTES", () => {
  it("covers every kind, so a new kind cannot be silently unwatched", () => {
    const kinds = Object.keys(GIVE_UP_MINUTES) as SyncKind[];
    expect(Object.keys(STUCK_AFTER_MINUTES).sort()).toEqual(kinds.sort());
  });

  it("alarms BEFORE the row would give up — otherwise it could never fire", () => {
    // For a clock-give-up kind the row parks at GIVE_UP_MINUTES and is then caught
    // by the parked report. If the stuck threshold sat at or past that, this alarm
    // would be dead code for exactly the kinds that can go quiet.
    for (const kind of Object.keys(CLOCK_GIVE_UP) as SyncKind[]) {
      if (CLOCK_GIVE_UP[kind]) {
        expect(
          STUCK_AFTER_MINUTES[kind],
          `${kind}: stuck threshold must precede its give-up deadline`,
        ).toBeLessThan(GIVE_UP_MINUTES[kind]);
      }
    }
  });

  it("watches the never-give-up kinds, which nothing else would ever report", () => {
    // These never park, so this threshold is their ONLY route to a human.
    expect(CLOCK_GIVE_UP["push-waiver-signature"]).toBe(false);
    expect(CLOCK_GIVE_UP["add-membership"]).toBe(false);
    expect(STUCK_AFTER_MINUTES["push-waiver-signature"]).toBeGreaterThan(0);
    expect(STUCK_AFTER_MINUTES["add-membership"]).toBeGreaterThan(0);
  });

  it("gives add-membership room for the morning cloud→local wait", () => {
    // Measured 2026-09-05: 62 of its 84 slow rows were created 10am-noon ET and
    // waited 2-4 hours with ZERO failed attempts, because a guest who books in the
    // morning is not on the local server until much later. Alarming on those would
    // train everyone to ignore the alarm.
    expect(STUCK_AFTER_MINUTES["add-membership"]).toBeGreaterThanOrEqual(240);
  });

  it("keeps the waiver push among the tightest — it is the one a guest is owed", () => {
    // p95 of landed waiver pushes was 35 min; 90 is generous headroom.
    expect(STUCK_AFTER_MINUTES["push-waiver-signature"]).toBe(90);
    for (const kind of Object.keys(STUCK_AFTER_MINUTES) as SyncKind[]) {
      expect(STUCK_AFTER_MINUTES[kind]).toBeGreaterThanOrEqual(
        STUCK_AFTER_MINUTES["push-waiver-signature"],
      );
    }
  });

  it("sits above the measured p95 of every kind that HAS one, so normal work never alarms", () => {
    /**
     * p95 of rows that LANDED, measured over the table's whole life on 2026-09-05.
     *
     * `repair-person-details` and `attach-project-person` are deliberately absent:
     * 4 landed rows and 0 respectively is not a distribution, and the former's
     * 303-minute tail is an artifact of the 2026-08-13 manual re-drive re-basing
     * `give_up_at`, not of how the kind behaves. Calibrating a threshold against
     * that number would have pushed it past its own give-up deadline — which is
     * exactly the bug the ordering test above caught.
     */
    const p95: Partial<Record<SyncKind, number>> = {
      "add-membership": 5.3,
      "push-waiver-signature": 35.4,
      "stamp-confirmation-state": 96.5,
    };
    for (const [kind, v] of Object.entries(p95) as Array<[SyncKind, number]>) {
      expect(STUCK_AFTER_MINUTES[kind], `${kind} would alarm on normal work`).toBeGreaterThan(v);
    }
  });
});
