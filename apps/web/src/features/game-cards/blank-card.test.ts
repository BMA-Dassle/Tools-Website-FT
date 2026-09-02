import { describe, expect, it } from "vitest";
import { classifySwipedCard } from "./blank-card";

const zero = { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 };

describe("classifySwipedCard", () => {
  it("a CONFIRMED not-found is a blank (no account until first credit)", () => {
    expect(classifySwipedCard({ exists: false, notFound: "confirmed" })).toBe("blank");
  });

  it("an AMBIGUOUS not-found (upstream exception) is unknown — never sold as new", () => {
    expect(classifySwipedCard({ exists: false, notFound: "ambiguous" })).toBe("unknown");
    // Legacy shape without the marker at all → still not a blank.
    expect(classifySwipedCard({ exists: false })).toBe("unknown");
  });

  it("any balance component makes it active", () => {
    expect(classifySwipedCard({ exists: true, balance: { ...zero, tokens: 5 } })).toBe("active");
    expect(classifySwipedCard({ exists: true, balance: { ...zero, bonusTokens: 1 } })).toBe(
      "active",
    );
    expect(classifySwipedCard({ exists: true, balance: { ...zero, eTickets: 90 } })).toBe("active");
    expect(classifySwipedCard({ exists: true, balance: { ...zero, timeMinutes: 15 } })).toBe(
      "active",
    );
  });

  it("cash on the card counts as value (nothing displays cash, but it is somebody's card)", () => {
    expect(classifySwipedCard({ exists: true, balance: zero, cashBalance: 20 })).toBe("active");
  });

  it("a fully spent card (zero balances, has history) is still active — it is somebody's card", () => {
    expect(
      classifySwipedCard({
        exists: true,
        balance: zero,
        transactions: [
          {
            device: "Hot Wheels",
            transType: "Game Play",
            tokens: -20,
            bonusTokens: 0,
            points: 0,
            cash: 0,
            timeStamp: "2026-07-15 22:26:08",
            location: "FastTrax Fort Myers",
          },
        ],
      }),
    ).toBe("active");
  });

  it("exists, all-zero, and history CAME BACK EMPTY is recycled zero stock — blank", () => {
    expect(classifySwipedCard({ exists: true, balance: zero, transactions: [] })).toBe("blank");
  });

  it("exists, all-zero, but history UNAVAILABLE → unknown, never blank", () => {
    // `undefined` is not "no history" — it is "we could not read the history".
    // The onsite proxy serves balance and history as two separate calls, so the
    // balance can answer while history fails. Treating that as "no history" made
    // every SPENT-OUT card look like fresh stock the moment onsite became the
    // default transport (measured 2026-09-01: 0 of 36 production reads carried
    // any history), which would sell a guest their own card as a new one.
    expect(classifySwipedCard({ exists: true, balance: zero })).toBe("unknown");
    expect(classifySwipedCard({ exists: true, balance: zero, transactions: undefined })).toBe(
      "unknown",
    );
  });

  it("exists but no balance block we could read → unknown, not blank", () => {
    expect(classifySwipedCard({ exists: true })).toBe("unknown");
  });
});
