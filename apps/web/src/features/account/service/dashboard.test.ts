import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSession } from "../types";

/**
 * buildDashboard must degrade per-section: a failing BMI/Square upstream marks
 * only its own card "unavailable" while the rest of the page renders. And the
 * phone-keyed sections (Rewards, Race) are "not_applicable" for an email session.
 */

const getReservationsByContact = vi.fn();
const getGroupQuotesByContact = vi.fn();
const lookupLoyaltyByPhone = vi.fn();
const resolveBmiPerson = vi.fn();
const getPandoraWaiver = vi.fn();
const getRaceCredits = vi.fn();

vi.mock("@/lib/bowling-db", () => ({
  getReservationsByContact: (...a: unknown[]) => getReservationsByContact(...a),
}));
vi.mock("@/lib/group-function-db", () => ({
  getGroupQuotesByContact: (...a: unknown[]) => getGroupQuotesByContact(...a),
}));
vi.mock("@/lib/booking-confirmation-link", () => ({
  confirmationShortUrl: vi.fn(async () => "https://fasttraxent.com/s/abcd1234"),
}));
vi.mock("../data/loyalty", () => ({
  lookupLoyaltyByPhone: (...a: unknown[]) => lookupLoyaltyByPhone(...a),
}));
vi.mock("../data/bmi-race", () => ({
  resolveBmiPerson: (...a: unknown[]) => resolveBmiPerson(...a),
  getPandoraWaiver: (...a: unknown[]) => getPandoraWaiver(...a),
  getRaceCredits: (...a: unknown[]) => getRaceCredits(...a),
}));

import { buildDashboard } from "./dashboard";

function session(over: Partial<AccountSession>): AccountSession {
  return {
    sid: "sid",
    contact: "+12395551234",
    contactType: "phone",
    squareCustomerIds: [],
    csrf: "csrf",
    createdAt: 0,
    exp: 0,
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe("buildDashboard", () => {
  it("email session → Rewards & Race are not_applicable, reservations still load", async () => {
    getReservationsByContact.mockResolvedValue([]);
    getGroupQuotesByContact.mockResolvedValue([]);

    const data = await buildDashboard(session({ contact: "a@b.com", contactType: "email" }));

    expect(data.rewards.status).toBe("not_applicable");
    expect(data.raceAccount.status).toBe("not_applicable");
    expect(data.reservations.status).toBe("ok");
    // Phone-keyed lookups must not even be attempted for an email session.
    expect(lookupLoyaltyByPhone).not.toHaveBeenCalled();
    expect(resolveBmiPerson).not.toHaveBeenCalled();
  });

  it("BMI failure → raceAccount unavailable, other sections unaffected", async () => {
    getReservationsByContact.mockResolvedValue([]);
    getGroupQuotesByContact.mockResolvedValue([]);
    lookupLoyaltyByPhone.mockResolvedValue(null); // enrolled-check ok, not enrolled
    resolveBmiPerson.mockRejectedValue(new Error("office down"));

    const data = await buildDashboard(session({}));

    expect(data.raceAccount.status).toBe("unavailable");
    expect(data.reservations.status).toBe("ok");
    expect(data.rewards.status).toBe("ok");
    expect(data.rewards.account).toBeNull();
  });

  it("ambiguous BMI match surfaces candidates, never a guessed person", async () => {
    getReservationsByContact.mockResolvedValue([]);
    getGroupQuotesByContact.mockResolvedValue([]);
    lookupLoyaltyByPhone.mockResolvedValue(null);
    resolveBmiPerson.mockResolvedValue({
      person: null,
      ambiguous: true,
      candidates: [{ personId: "1", firstName: "A", lastName: "X" }],
    });

    const data = await buildDashboard(session({}));

    expect(data.raceAccount.ambiguous).toBe(true);
    expect(data.raceAccount.person).toBeNull();
    expect(data.raceAccount.candidates).toHaveLength(1);
    expect(getPandoraWaiver).not.toHaveBeenCalled();
  });
});
