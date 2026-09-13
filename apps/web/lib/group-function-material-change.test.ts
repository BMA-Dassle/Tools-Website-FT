import { describe, it, expect } from "vitest";
import {
  classifyMaterialChange,
  canRequestResign,
  type MaterialChangeFacts,
} from "@/lib/group-function-material-change";

/**
 * The fixture is the real incident: contract c31e3aec, "Strikes for Scholarships"
 * (FGCU, HeadPinz Fort Myers, quote 230). Signed 2026-07-01. On 2026-09-13 the
 * dispatch cron saw the event move Sep 13 4:30 PM → Sep 19 4:30 PM with the total
 * unchanged at $8,538.84, wrote version 2 with
 *   changes: ["date: Sep 13 4:30 PM → Sep 19 4:30 PM", "notes"]
 * and — under the price-only rule — asked for no signature.
 */
const facts = (over: Partial<MaterialChangeFacts> = {}): MaterialChangeFacts => ({
  priceChanged: false,
  dateChanged: false,
  venueChanged: false,
  ...over,
});

describe("classifyMaterialChange", () => {
  it("c31e3aec: a date move with the total unchanged is material", () => {
    // The exact shape of the incident — this is the case that used to fall through.
    const verdict = classifyMaterialChange(facts({ dateChanged: true }));
    expect(verdict.isMaterial).toBe(true);
    expect(verdict.reasons).toEqual(["date"]);
  });

  it("a venue move with no money attached is material", () => {
    // syncQuoteCenter can relocate an event between centres for zero money: same
    // products, same total. Nothing else in the change set would flag it.
    const verdict = classifyMaterialChange(facts({ venueChanged: true }));
    expect(verdict.isMaterial).toBe(true);
    expect(verdict.reasons).toEqual(["venue"]);
  });

  it("a price move is still material", () => {
    const verdict = classifyMaterialChange(facts({ priceChanged: true }));
    expect(verdict.isMaterial).toBe(true);
    expect(verdict.reasons).toEqual(["price"]);
  });

  it("CONTROL: notes / contacts only — nothing material moved, no re-sign", () => {
    // c31e3aec's version 2 also carried a "notes" change. If the rule ever widens to
    // catch every field in the change set, this is what breaks: a corrected phone
    // number would start demanding a fresh signature.
    const verdict = classifyMaterialChange(facts());
    expect(verdict.isMaterial).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("reports every term that moved, in a stable order", () => {
    const verdict = classifyMaterialChange(
      facts({ priceChanged: true, dateChanged: true, venueChanged: true }),
    );
    expect(verdict.reasons).toEqual(["price", "date", "venue"]);
    // The order feeds a BMI private note and a log line; pin it so neither reshuffles.
    expect(verdict.reasons.join(" + ")).toBe("price + date + venue");
  });
});

describe("canRequestResign", () => {
  it("allows the three post-signature states", () => {
    expect(canRequestResign("deposit_paid")).toBe(true);
    expect(canRequestResign("balance_charged")).toBe(true);
    // Already awaiting a re-sign and something moved again: re-notify with new terms.
    expect(canRequestResign("resign_required")).toBe(true);
  });

  it("never resurrects a contract that is finished or was never signed", () => {
    for (const status of [
      "pending",
      "pending_approval",
      "contract_sent",
      "completed",
      "cancelled",
      "denied",
      "expired",
    ]) {
      expect(canRequestResign(status)).toBe(false);
    }
  });
});
