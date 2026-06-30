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
const getRacerAccounts = vi.fn();

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
  getRacerAccounts: (...a: unknown[]) => getRacerAccounts(...a),
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
    expect(getRacerAccounts).not.toHaveBeenCalled();
  });

  it("BMI failure → raceAccount unavailable, other sections unaffected", async () => {
    getReservationsByContact.mockResolvedValue([]);
    getGroupQuotesByContact.mockResolvedValue([]);
    lookupLoyaltyByPhone.mockResolvedValue(null); // enrolled-check ok, not enrolled
    getRacerAccounts.mockRejectedValue(new Error("office down"));

    const data = await buildDashboard(session({}));

    expect(data.raceAccount.status).toBe("unavailable");
    expect(data.reservations.status).toBe("ok");
    expect(data.rewards.status).toBe("ok");
    expect(data.rewards.account).toBeNull();
  });

  it("lists every racer linked to the phone", async () => {
    getReservationsByContact.mockResolvedValue([]);
    getGroupQuotesByContact.mockResolvedValue([]);
    lookupLoyaltyByPhone.mockResolvedValue(null);
    getRacerAccounts.mockResolvedValue([
      {
        personId: "1",
        fullName: "Mom One",
        lastSeen: null,
        races: 3,
        memberships: ["Pro"],
        credits: [],
      },
      {
        personId: "2",
        fullName: "Kid Two",
        lastSeen: null,
        races: 1,
        memberships: [],
        credits: [],
      },
    ]);

    const data = await buildDashboard(session({}));

    expect(data.raceAccount.status).toBe("ok");
    expect(data.raceAccount.accounts).toHaveLength(2);
    expect(data.raceAccount.accounts.map((a) => a.fullName)).toEqual(["Mom One", "Kid Two"]);
  });
});
