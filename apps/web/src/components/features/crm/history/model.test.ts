import { describe, expect, it } from "vitest";
import type { HistoryAccount, MirrorEvent } from "~/features/crm/core/contracts";
import {
  accountMeta,
  accountSub,
  avgSpendCents,
  backfillDefaults,
  eventHost,
  eventMeta,
  prettyPhone,
  tenantOptions,
  wasRepLabel,
  windowLabel,
} from "./model";

/** The History / Account screens' pure helpers, against the prototype's copy. */

const ACCOUNT: HistoryAccount = {
  id: "201",
  kind: "business",
  name: "Lee Health",
  centre: "HPFM",
  lifetimeCents: 1_426_000,
  eventCount: 3,
  lastEventDate: "2026-10-17",
  contactNames: ["Renee Alvarado", "Thomas Ng"],
};

const EVENT: MirrorEvent = {
  projectId: "58454076",
  clientKey: "headpinzftmyers",
  centre: "HPFM",
  number: "H2306",
  name: "Chico's FAS — Marketing",
  eventDate: "2025-10-11",
  eventStart: "2025-10-11T22:00:00.000Z",
  persons: 38,
  stateId: "-3",
  stateName: "Confirmation",
  kindId: "-1",
  responsibleUserId: "28267036",
  responsibleName: "Kelsea Kosco",
  rep: { slug: "kelsea", firstName: "Kelsea", initials: "KK" },
  totalValueCents: 289_000,
  balanceCents: 0,
  personName: "Chico's FAS — Marketing",
  personPhone: "+12395554021",
  personEmail: null,
  accountId: "201",
  contactId: "34",
  syncedAt: "2026-09-12T23:00:00.000Z",
};

describe("account rows (crm-shared.js:431)", () => {
  it("meta = events · centre short · contacts", () => {
    expect(accountMeta(ACCOUNT)).toEqual([
      "3 events",
      "HP Fort Myers",
      "Renee Alvarado, Thomas Ng",
    ]);
    expect(accountMeta({ ...ACCOUNT, eventCount: 1, centre: null, contactNames: [] })).toEqual([
      "1 event",
    ]);
  });

  it("sub line = kind · centre name · lifetime (crm-shared.js:434)", () => {
    expect(accountSub(ACCOUNT)).toBe("Business · HeadPinz Fort Myers · lifetime $14,260");
    expect(accountSub({ ...ACCOUNT, kind: "household", centre: null })).toBe(
      "Household · lifetime $14,260",
    );
  });

  it("avg spend = lifetime / events, null with no events", () => {
    expect(avgSpendCents(ACCOUNT)).toBe(475_333);
    expect(avgSpendCents({ lifetimeCents: 0, eventCount: 0 })).toBeNull();
  });
});

describe("last-year rows (crm-shared.js:432)", () => {
  it("meta = date · guests · money · centre · ref", () => {
    expect(eventMeta(EVENT)).toEqual([
      "Sat, Oct 11, 2025",
      "38 guests",
      "$2,890",
      "HP Fort Myers",
      "H2306",
    ]);
  });

  it("host prefers the person, then the project name, then the ref", () => {
    expect(eventHost(EVENT)).toBe("Chico's FAS — Marketing");
    expect(eventHost({ ...EVENT, personName: null })).toBe("Chico's FAS — Marketing");
    expect(eventHost({ ...EVENT, personName: null, name: null })).toBe("H2306");
    expect(eventHost({ ...EVENT, personName: null, name: null, number: null })).toBe(
      "Project 58454076",
    );
  });

  it('"was Kelsea\'s" from the rep chip, else the responsible name, else nothing', () => {
    expect(wasRepLabel(EVENT)).toBe("was Kelsea's");
    expect(wasRepLabel({ ...EVENT, rep: null })).toBe("was Kelsea's");
    expect(wasRepLabel({ ...EVENT, rep: null, responsibleName: null })).toBeNull();
  });

  it("the window pill reads like the prototype's", () => {
    expect(windowLabel({ from: "2025-10-05", till: "2025-11-07" })).toBe("Oct 5 – Nov 7, 2025");
  });
});

describe("the mirror control", () => {
  it("one option per Office tenant, labelled by the centres it serves", () => {
    expect(tenantOptions()).toEqual([
      { clientKey: "headpinzftmyers", label: "HP Fort Myers · FastTrax" },
      { clientKey: "headpinznaples", label: "HP Naples" },
    ]);
  });

  it("defaults to the last 12 ET months", () => {
    expect(backfillDefaults(new Date("2026-09-12T23:30:00.000Z"))).toEqual({
      from: "2025-09-12",
      until: "2026-09-12",
    });
  });

  it("prettyPhone formats NANP E.164 and leaves the rest alone", () => {
    expect(prettyPhone("+12395554021")).toBe("(239) 555-4021");
    expect(prettyPhone("+441onal")).toBe("+441onal");
    expect(prettyPhone(null)).toBeNull();
  });
});
