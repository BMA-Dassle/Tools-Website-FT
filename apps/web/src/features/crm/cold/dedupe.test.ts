import { describe, expect, it } from "vitest";
import { accountNameKey } from "~/features/crm/leads/data/accounts-db";
import { parseCsv } from "./csv";
import {
  ColdSeenKeys,
  hasNoKeys,
  matchKeysFor,
  pickMatch,
  verdictFor,
  type ColdCandidate,
} from "./dedupe";
import { projectRecord, suggestColumnMap } from "./mapping";
import { UGLY_CSV } from "./test-support";

function candidate(over: Partial<ColdCandidate>): ColdCandidate {
  return {
    contactId: null,
    accountId: null,
    accountName: null,
    contactName: null,
    bmiPersonId: null,
    phoneE164: null,
    emailKey: null,
    nameKey: null,
    ...over,
  };
}

const KEYS = {
  bmiPersonId: "63000000009561437",
  phoneE164: "+12395557015",
  emailKey: "devon@brightpath.example",
  nameKey: "brightpath dental",
};

describe("pickMatch order", () => {
  it("prefers the BMI person id over every other key", () => {
    const hit = pickMatch(KEYS, [
      candidate({ contactId: "9", phoneE164: KEYS.phoneE164, contactName: "By phone" }),
      candidate({ contactId: "7", bmiPersonId: KEYS.bmiPersonId, contactName: "By person id" }),
    ]);
    expect(hit).toMatchObject({ key: "bmi_person_id", contactId: "7", label: "By person id" });
  });

  it("prefers the phone over the email, as upsertContact does", () => {
    const hit = pickMatch(KEYS, [
      candidate({ contactId: "3", emailKey: KEYS.emailKey, contactName: "By email" }),
      candidate({ contactId: "4", phoneE164: KEYS.phoneE164, contactName: "By phone" }),
    ]);
    expect(hit).toMatchObject({ key: "phone", contactId: "4" });
  });

  it("prefers the email over the company name", () => {
    const hit = pickMatch(KEYS, [
      candidate({ accountId: "11", nameKey: KEYS.nameKey, accountName: "BrightPath Dental" }),
      candidate({ contactId: "5", emailKey: KEYS.emailKey, contactName: "By email" }),
    ]);
    expect(hit).toMatchObject({ key: "email", contactId: "5" });
  });

  it("falls back to the account name and labels it with the account", () => {
    const hit = pickMatch(KEYS, [
      candidate({ accountId: "11", nameKey: KEYS.nameKey, accountName: "BrightPath Dental" }),
    ]);
    expect(hit).toMatchObject({
      key: "account_name",
      accountId: "11",
      label: "BrightPath Dental",
    });
  });

  it("carries the account through when the contact matched", () => {
    const hit = pickMatch(KEYS, [
      candidate({
        contactId: "5",
        accountId: "11",
        accountName: "BrightPath Dental",
        phoneE164: KEYS.phoneE164,
      }),
    ]);
    expect(hit).toMatchObject({ contactId: "5", accountId: "11", label: "BrightPath Dental" });
  });

  it("is null when nothing matches, and when there are no candidates", () => {
    expect(pickMatch(KEYS, [candidate({ contactId: "1", phoneE164: "+12395550000" })])).toBeNull();
    expect(pickMatch(KEYS, [])).toBeNull();
  });

  it("never matches on a key the row does not have", () => {
    const noKeys = { bmiPersonId: null, phoneE164: null, emailKey: null, nameKey: null };
    expect(hasNoKeys(noKeys)).toBe(true);
    expect(
      pickMatch(noKeys, [candidate({ contactId: "1", phoneE164: null, emailKey: null })]),
    ).toBeNull();
  });
});

describe("ColdSeenKeys", () => {
  it("flags the second appearance of a phone, not the first", () => {
    const seen = new ColdSeenKeys();
    expect(seen.add({ ...KEYS })).toBe(false);
    expect(seen.add({ ...KEYS })).toBe(true);
  });

  it("flags a repeat of the email alone", () => {
    const seen = new ColdSeenKeys();
    seen.add({
      bmiPersonId: null,
      phoneE164: "+12395550001",
      emailKey: "a@b.example",
      nameKey: null,
    });
    expect(
      seen.add({
        bmiPersonId: null,
        phoneE164: "+12395550002",
        emailKey: "a@b.example",
        nameKey: null,
      }),
    ).toBe(true);
  });

  it("does not flag two rows of the same COMPANY with different people", () => {
    const seen = new ColdSeenKeys();
    seen.add({
      bmiPersonId: null,
      phoneE164: "+12395550001",
      emailKey: null,
      nameKey: "lee health",
    });
    expect(
      seen.add({
        bmiPersonId: null,
        phoneE164: "+12395550002",
        emailKey: null,
        nameKey: "lee health",
      }),
    ).toBe(false);
  });

  it("ignores rows with nothing to compare", () => {
    const seen = new ColdSeenKeys();
    const empty = { bmiPersonId: null, phoneE164: null, emailKey: null, nameKey: null };
    expect(seen.add(empty)).toBe(false);
    expect(seen.add(empty)).toBe(false);
    expect(seen.size).toBe(0);
  });
});

describe("verdictFor defaults", () => {
  it("a CRM match defaults to LINK — the prototype's promise", () => {
    const v = verdictFor(KEYS, [candidate({ contactId: "5", phoneE164: KEYS.phoneE164 })], false);
    expect(v.matchedBy).toBe("phone");
    expect(v.decision).toBe("link");
  });

  it("an in-file duplicate with no CRM match defaults to SKIP", () => {
    const v = verdictFor(KEYS, [], true);
    expect(v.matchedBy).toBe("in_file");
    expect(v.decision).toBe("skip");
    expect(v.match).toBeNull();
  });

  it("a CRM match wins over the in-file flag, but the flag is still carried", () => {
    const v = verdictFor(KEYS, [candidate({ contactId: "5", phoneE164: KEYS.phoneE164 })], true);
    expect(v.matchedBy).toBe("phone");
    expect(v.duplicateInFile).toBe(true);
  });

  it("an unmatched row imports", () => {
    const v = verdictFor(KEYS, [], false);
    expect(v.matchedBy).toBeNull();
    expect(v.decision).toBe("new");
  });
});

describe("the ugly fixture, end to end", () => {
  const table = parseCsv(UGLY_CSV);
  const map = suggestColumnMap(table.headers);
  const rows = table.records.map((r) => {
    const projection = projectRecord(r.values, map);
    const nameKey = projection.company ? accountNameKey(projection.company) : null;
    return { projection, keys: matchKeysFor(projection, nameKey || null) };
  });

  it("finds exactly one in-file duplicate: the row that repeats BrightPath's number", () => {
    const seen = new ColdSeenKeys();
    const dups = rows.map((r) => seen.add(r.keys));
    expect(dups.filter(Boolean)).toHaveLength(1);
    // Row 1 is BrightPath; row 6 is "Duplicate Dental" with the same number.
    expect(dups[0]).toBe(false);
    expect(rows[dups.indexOf(true)]!.projection.company).toBe("Duplicate Dental");
  });

  it("matches an existing account by name even when the phone is new", () => {
    const coastal = rows.find((r) => r.projection.company === "Coastal Title Co.")!;
    // "Coastal Title Co." and "coastal title, llc" are one account (SUFFIXES).
    expect(coastal.keys.nameKey).toBe("coastal title");
    const v = verdictFor(
      coastal.keys,
      [candidate({ accountId: "88", nameKey: "coastal title", accountName: "Coastal Title, LLC" })],
      false,
    );
    expect(v.matchedBy).toBe("account_name");
    expect(v.match?.accountId).toBe("88");
  });

  it("a row with an unreadable phone can still match on its email", () => {
    const broken = rows.find((r) => r.projection.company === "Broken Phone Co")!;
    expect(broken.keys.phoneE164).toBeNull();
    const v = verdictFor(
      broken.keys,
      [candidate({ contactId: "12", emailKey: "sam@broken.example", contactName: "Sam Vane" })],
      false,
    );
    expect(v.matchedBy).toBe("email");
  });

  it("a row with no keys at all matches nothing and still imports", () => {
    const keys = matchKeysFor(
      { ...rows[0]!.projection, phoneE164: null, emailKey: null, bmiPersonId: null, company: null },
      null,
    );
    expect(hasNoKeys(keys)).toBe(true);
    expect(verdictFor(keys, [candidate({ contactId: "1" })], false).decision).toBe("new");
  });
});
