/**
 * The pin walk and the vendor refusals it has to understand.
 *
 * Extracted from the arrangement engine's suite because these two modules ship ahead of
 * it: the availability guard depends on them, and code in the booking path does not go to
 * main untested.
 */
import { describe, expect, it } from "vitest";
import { classifyPinFailure, shouldFailOpen } from "./pin-errors";
import { createWithLanePlan, describePinOutcome } from "./pin";

describe("reading QAMF's refusals", () => {
  // Both strings captured from live 409s at FM on 2026-08-25.
  it("treats an out-of-group lane as recoverable", () => {
    const v = classifyPinFailure(
      `createReservation(9172) failed: 409 {"detail":"weboffer has validation errors: [{Type: LanesNotCompatible, Reason: 'Lanes passed are not compatible with web offer configuration (Lane Groups)'}]"}`,
    );
    expect(v.tryNextLane).toBe(true);
    expect(v.code).toBe("lanes_not_compatible");
  });

  it("treats an occupied lane as recoverable — this is the vendor backstop", () => {
    const v = classifyPinFailure(
      `createReservation(9172) failed: 409 {"title":"Conflict","status":409,"detail":"Not enough resources available for the request"}`,
    );
    expect(v.tryNextLane).toBe(true);
    expect(v.code).toBe("lane_unavailable");
  });

  it("fails open on anything it does not recognise — a lane preference is not worth a booking", () => {
    const v = classifyPinFailure("500 Internal Server Error");
    expect(v.tryNextLane).toBe(false);
    expect(v.code).toBe("unknown");
    expect(shouldFailOpen("500 Internal Server Error")).toBe(true);
  });
});

describe("walking candidates without losing the booking", () => {
  // Live 409 bodies, captured at FM 2026-08-25.
  const OCCUPIED = `createReservation(9172) failed: 409 {"title":"Conflict","status":409,"detail":"Not enough resources available for the request"}`;
  const OUT_OF_GROUP = `createReservation(9172) failed: 409 {"detail":"[{Type: LanesNotCompatible}]"}`;

  /** A fake vendor: every lane in `blocked` refuses with `error`, anything else succeeds. */
  const vendor = (blocked: Map<number, string>) => {
    const seen: Array<number[] | null> = [];
    const create = async (lanes: readonly number[] | null) => {
      seen.push(lanes ? [...lanes] : null);
      const bad = lanes?.find((l) => blocked.has(l));
      if (bad !== undefined) throw new Error(blocked.get(bad));
      return { Id: lanes ? `X-on-${lanes.join("+")}` : "X-auto" };
    };
    return { create, seen };
  };

  it("CONTINUES past an occupied lane instead of aborting — the bug", async () => {
    // Lane 25 is booked, 26 is booked, 19 is free. The original loop stopped at 25.
    const v = vendor(
      new Map([
        [25, OCCUPIED],
        [26, OCCUPIED],
      ]),
    );
    const out = await createWithLanePlan({
      candidates: [[25], [26], [19]],
      create: v.create,
      maxAttempts: 3,
    });
    expect(v.seen).toEqual([[25], [26], [19]]);
    expect(out.pinnedTo).toEqual([19]);
    expect(out.failedOpen).toBe(false);
    expect(out.reservation).toEqual({ Id: "X-on-19" });
  });

  it("continues past an out-of-group lane too", async () => {
    const v = vendor(new Map([[6, OUT_OF_GROUP]]));
    const out = await createWithLanePlan({ candidates: [[6], [13]], create: v.create });
    expect(out.pinnedTo).toEqual([13]);
    expect(out.attempts[0].failure?.code).toBe("lanes_not_compatible");
  });

  it("still produces a booking when every candidate is refused", async () => {
    const v = vendor(
      new Map([
        [25, OCCUPIED],
        [26, OCCUPIED],
        [27, OCCUPIED],
      ]),
    );
    const out = await createWithLanePlan({
      candidates: [[25], [26], [27]],
      create: v.create,
      maxAttempts: 3,
    });
    // The last call sent no lanes at all — the guest is booked regardless.
    expect(v.seen[v.seen.length - 1]).toBeNull();
    expect(out.failedOpen).toBe(true);
    expect(out.pinnedTo).toBeNull();
    expect(out.reservation).toEqual({ Id: "X-auto" });
  });

  it("stops trying lanes on an unrecognised error, but still books", async () => {
    const v = vendor(new Map([[13, "500 Internal Server Error"]]));
    const out = await createWithLanePlan({ candidates: [[13], [14], [15]], create: v.create });
    // 14 and 15 are never attempted — another lane would not fix a 500.
    expect(v.seen).toEqual([[13], null]);
    expect(out.failedOpen).toBe(true);
  });

  it("honours maxAttempts so a guest is not left waiting on round-trips", async () => {
    const v = vendor(new Map([1, 2, 3, 4, 5].map((l) => [l, OCCUPIED])));
    await createWithLanePlan({
      candidates: [[1], [2], [3], [4], [5]],
      create: v.create,
      maxAttempts: 2,
    });
    expect(v.seen).toEqual([[1], [2], null]);
  });

  it("books unpinned when the engine had no candidate at all", async () => {
    const v = vendor(new Map());
    const out = await createWithLanePlan({ candidates: [], create: v.create });
    expect(v.seen).toEqual([null]);
    expect(out.failedOpen).toBe(true);
  });

  it("lets a genuine booking failure surface — that is not a lane problem", async () => {
    const create = async () => {
      throw new Error("400 BookedAt is in the past");
    };
    await expect(createWithLanePlan({ candidates: [[13]], create })).rejects.toThrow(
      /BookedAt is in the past/,
    );
  });

  it("describes the walk for the decision log", async () => {
    const v = vendor(new Map([[25, OCCUPIED]]));
    const out = await createWithLanePlan({ candidates: [[25], [19]], create: v.create });
    expect(describePinOutcome(out)).toBe("pinned to 19 after 25 (lane_unavailable) refused");
  });
});
