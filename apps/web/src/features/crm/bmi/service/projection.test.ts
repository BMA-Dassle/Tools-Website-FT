import { describe, expect, it } from "vitest";
import { canonicalizePhone } from "@/lib/participant-contact";
import { fixtureText } from "@/test/msw/handlers/fixture";
import {
  FIXTURE_COMPANY_PERSON_ID,
  FIXTURE_HOST_PERSON_ID,
  FIXTURE_ONLINE_PERSON_ID,
  FIXTURE_ONLINE_PROJECT_ID,
  FIXTURE_PROJECT_ID,
  fixtureMetadata,
  officeParse,
} from "../test-support";
import {
  ONLINE_KIND_ID,
  accountKeyFor,
  centreCodeForLocation,
  companyNameOf,
  dayPlannerEntries,
  dayPlannerPersons,
  dayPlannerProjects,
  dayPlannerStubRow,
  idString,
  liveReservationIds,
  liveReservationRow,
  locationIdFor,
  moneyToCents,
  normalizeNameKey,
  officeStampToInstant,
  personContact,
  projectDetail,
  toE164,
  trimRaw,
  type OfficeDayPlanner,
  type OfficeLiveReservation,
  type OfficePersonEntity,
  type OfficeProjectDetail,
} from "./projection";

/**
 * Raw Office text → mirror row. The fixtures are RAW JSON with bare 17-digit
 * ids; every test parses them the way the transport does and carries the
 * negative control (memory `feedback_fixture_must_match_the_ugly_case`).
 */

const PROJECT_TEXT = fixtureText("office-project-58454076.json.txt");
const PERSON_TEXT = fixtureText("office-person-63000000009561437.json.txt");
const COMPANY_TEXT = fixtureText("office-person-63000000009561447.json.txt");

describe("ids survive as strings (R1)", () => {
  it("NEGATIVE CONTROL — JSON.parse rounds the 17-digit ids in the fixtures", () => {
    const naive = JSON.parse(PROJECT_TEXT) as { personId: number };
    expect(String(naive.personId)).not.toBe(FIXTURE_HOST_PERSON_ID);
    const naivePerson = JSON.parse(PERSON_TEXT) as { id: number };
    expect(String(naivePerson.id)).not.toBe(FIXTURE_HOST_PERSON_ID);
  });

  it("projectDetail keeps personId / contact bmiPersonId exact and every small id a string", () => {
    const detail = officeParse<OfficeProjectDetail>(PROJECT_TEXT);
    const person = officeParse<OfficePersonEntity>(PERSON_TEXT);
    const { row, contact } = projectDetail(detail, person, {
      clientKey: "headpinzftmyers",
      source: "backfill",
      lookups: fixtureMetadata(),
    });
    expect(row.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(row.personId).toBe(FIXTURE_HOST_PERSON_ID);
    expect(contact?.bmiPersonId).toBe(FIXTURE_HOST_PERSON_ID);
    expect(row.stateId).toBe("49130082");
    expect(row.responsibleUserId).toBe("28267036");
    expect(row.kindId).toBe("-1");
    for (const v of [row.projectId, row.personId, row.stateId, row.responsibleUserId, row.kindId]) {
      expect(typeof v).toBe("string");
    }
    expect(row.products?.[0]?.productId).toBe("14838862");
    expect(row.products?.[0]?.id).toBe("91000101");
  });
});

describe("projectDetail — names, dates, money, location", () => {
  const detail = officeParse<OfficeProjectDetail>(PROJECT_TEXT);
  const person = officeParse<OfficePersonEntity>(PERSON_TEXT);
  const company = officeParse<OfficePersonEntity>(COMPANY_TEXT);
  const projected = projectDetail(detail, person, {
    clientKey: "headpinzftmyers",
    source: "backfill",
    lookups: fixtureMetadata(),
    scheduleResourceIds: ["305133"],
    companyName: companyNameOf(company),
  });
  const { row, account, contact } = projected;

  it("resolves state and responsible names from metadata", () => {
    expect(row.stateName).toBe("Send Contract");
    expect(row.responsibleName).toBe("Kelsea Kosco");
    expect(row.number).toBe("H3248");
    expect(row.name).toBe("Acme Corp holiday party");
    expect(row.persons).toBe(42);
  });

  it("event date is the Office calendar day; start is that day's real ET offset (EST in December)", () => {
    expect(row.eventDate).toBe("2026-12-12");
    expect(row.eventStart).toBe("2026-12-12T23:00:00.000Z"); // 18:00 EST = 23:00Z
    expect(row.bmiCreatedAt).toBe("2026-08-30T18:02:11.000Z"); // 14:02 EDT = 18:02Z
  });

  it("total = Σ products (price × qty when totalPrice is absent); balance = Office's own field", () => {
    // fixture products: 3 × 399.99 with no totalPrice → 1199.97
    expect(row.totalValueCents).toBe(119_997);
    expect(row.balanceCents).toBe(0);
  });

  it("the host: E.164 phone, lower-cased email key, and a BUSINESS account from the company RECORD", () => {
    expect(contact).toEqual({
      firstName: "Dana",
      lastName: "Acme",
      phoneE164: "+12395554021",
      email: "Dana@AcmeCorp.com",
      emailKey: "dana@acmecorp.com",
      bmiPersonId: FIXTURE_HOST_PERSON_ID,
    });
    expect(row.personName).toBe("Dana Acme");
    expect(row.personPhone).toBe("+12395554021");
    expect(row.personEmail).toBe("Dana@AcmeCorp.com");
    expect(account).toEqual({ kind: "business", name: "Acme Corp., Inc.", nameKey: "acme" });
  });

  it("the company name comes from the project's companyId PERSON — a host entity has no company field", () => {
    // Probed live 2026-09-13: five Naples host records carry no `company` key
    // at all, while `project.companyId` resolves to a person whose `name` is
    // the business ("Naples Bears", "Blossom Academy", "Home Team Pest
    // Defense"). The fixtures now match that shape, so the business branch is
    // exercised through the real rail and not through an invented field.
    expect(person).not.toHaveProperty("company");
    expect(idString(detail.companyId)).toBe(FIXTURE_COMPANY_PERSON_ID);
    expect(companyNameOf(company)).toBe("Acme Corp., Inc.");
    expect(String((JSON.parse(COMPANY_TEXT) as { id: number }).id)).not.toBe(
      FIXTURE_COMPANY_PERSON_ID,
    );
    // Without the company record the same booking is a household, not a business.
    const bare = projectDetail(detail, person, {
      clientKey: "headpinzftmyers",
      source: "backfill",
      lookups: fixtureMetadata(),
    });
    expect(bare.account?.kind).toBe("household");
    // Two different hosts booking the same company land on ONE account key.
    const other = accountKeyFor(
      { id: "5718917", firstName: "Selome", name: "Spurlock" },
      {
        firstName: "Selome",
        lastName: "Spurlock",
        phoneE164: "+12395550001",
        email: null,
        emailKey: null,
        bmiPersonId: "5718917",
      },
      "Acme Corp Inc",
    );
    expect(other?.nameKey).toBe(account?.nameKey);
  });

  it("the Fort Myers tenant splits by schedule resource: lanes → HPFM, karting-only → FT", () => {
    expect(row.locationId).toBe(332160);
    expect(locationIdFor("headpinzftmyers", ["33416821"])).toBe(467486);
    expect(locationIdFor("headpinzftmyers", ["33416821", "305133"])).toBe(332160);
    expect(locationIdFor("headpinzftmyers", [])).toBe(332160);
    expect(locationIdFor("headpinznaples", [])).toBe(332145);
    expect(locationIdFor("nope", [])).toBeNull();
    expect(centreCodeForLocation(467486)).toBe("FT");
    expect(centreCodeForLocation(null)).toBeNull();
  });

  it("raw keeps the entity minus the staff log arrays", () => {
    expect(row.raw).not.toBeNull();
    expect(row.raw).not.toHaveProperty("logs");
    expect(row.raw).toHaveProperty("bills");
    expect(trimRaw({ a: 1, logs: [1], projectLogs: [2] })).toEqual({ a: 1 });
  });
});

describe("households and edge hosts", () => {
  const online = officeParse<OfficeProjectDetail>(fixtureText("office-project-58454077.json.txt"));
  const ana = officeParse<OfficePersonEntity>(
    fixtureText("office-person-63000000009561440.json.txt"),
  );

  it("no company → household keyed by last name + phone digits, named after the PERSON", () => {
    const { row, account, contact } = projectDetail(online, ana, {
      clientKey: "headpinzftmyers",
      source: "backfill",
      lookups: fixtureMetadata(),
    });
    expect(contact?.phoneE164).toBe("+12395558830");
    expect(contact?.email).toBeNull();
    expect(account).toEqual({
      kind: "household",
      // The person's own name, not an invented relationship. Nothing in BMI
      // says these people are a family, and the owner objected to the CRM
      // saying so: "how do you know its family?". `kind` still records that it
      // is a household rather than a business.
      name: "Ana Rodriguez",
      nameKey: "household:rodriguez:12395558830",
    });
    expect(row.kindId).toBe("-10");
    expect(row.personId).toBe(FIXTURE_ONLINE_PERSON_ID);
    expect(row.projectId).toBe(FIXTURE_ONLINE_PROJECT_ID);
    expect(row.totalValueCents).toBe(11_996);
    expect(row.locationId).toBe(467486); // schedule on the Blue Track
  });

  it("a household with no phone falls back to email, then the person id — never the surname alone", () => {
    const base = {
      firstName: "Sam",
      lastName: "Smith",
      phoneE164: null,
      email: null,
      emailKey: null,
      bmiPersonId: null,
    };
    expect(
      accountKeyFor(null, { ...base, emailKey: "sam@x.com", email: "sam@x.com" })?.nameKey,
    ).toBe("household:smith:sam@x.com");
    expect(accountKeyFor(null, { ...base, bmiPersonId: "63000000009561499" })?.nameKey).toBe(
      "household:smith:person:63000000009561499",
    );
    expect(accountKeyFor(null, base)).toBeNull();
    expect(accountKeyFor(null, null)).toBeNull();
  });

  it("a person with no name and no reachable address is no contact; a null person is none", () => {
    expect(personContact({ id: "1", addresses: [] })).toBeNull();
    expect(personContact(null)).toBeNull();
    const { contact, account, row } = projectDetail(online, null, {
      clientKey: "headpinzftmyers",
      source: "delta",
      lookups: null,
    });
    expect(contact).toBeNull();
    expect(account).toBeNull();
    expect(row.stateName).toBeNull();
    expect(row.source).toBe("delta");
  });
});

describe("pure helpers", () => {
  it("toE164 agrees with lib/participant-contact canonicalizePhone", () => {
    for (const raw of [
      "(239) 555-4021",
      "2395558830",
      "12395558830",
      "+1 239 555 8830",
      "555-8830",
      "",
      "abc",
    ]) {
      expect(toE164(raw), raw).toBe(canonicalizePhone(raw));
    }
  });

  it("normalizeNameKey drops legal suffixes and punctuation", () => {
    expect(normalizeNameKey("Acme Corp., Inc.")).toBe("acme");
    expect(normalizeNameKey("Lee Health")).toBe("lee health");
    expect(normalizeNameKey("FGCU — Residence Life")).toBe("fgcu residence life");
    expect(normalizeNameKey("Suncoast Credit Union, LLC")).toBe("suncoast credit union");
    expect(normalizeNameKey("A & B Co")).toBe("a and b");
  });

  it("officeStampToInstant honours DST by calendar day and rejects garbage", () => {
    expect(officeStampToInstant("2026-07-04T18:00:00")).toEqual({
      ymd: "2026-07-04",
      iso: "2026-07-04T22:00:00.000Z",
    });
    expect(officeStampToInstant("2026-12-12T18:00:00")).toEqual({
      ymd: "2026-12-12",
      iso: "2026-12-12T23:00:00.000Z",
    });
    expect(officeStampToInstant("2026-12-12")).toEqual({
      ymd: "2026-12-12",
      iso: "2026-12-12T05:00:00.000Z",
    });
    expect(officeStampToInstant(null)).toBeNull();
    expect(officeStampToInstant("yesterday")).toBeNull();
  });

  it("moneyToCents rounds dollars; non-numbers are null", () => {
    expect(moneyToCents(1299.5)).toBe(129_950);
    expect(moneyToCents(0.1 + 0.2)).toBe(30);
    expect(moneyToCents("12")).toBeNull();
    expect(moneyToCents(NaN)).toBeNull();
  });
});

describe("dayPlanner → the window's projects", () => {
  const dp = officeParse<OfficeDayPlanner>(fixtureText("office-dayplanner-2025-09.json.txt"));

  it("dedupes by id (the FM/FT shared tenant lists a project once per resource) and KEEPS kindId -10", () => {
    const refs = dayPlannerProjects(dp);
    expect(refs.map((r) => r.projectId)).toEqual([FIXTURE_PROJECT_ID, FIXTURE_ONLINE_PROJECT_ID]);
    expect(refs[1]?.kindId).toBe("-10");
    expect(refs[0]?.scheduleResourceIds).toEqual(["305133"]);
    expect(refs[1]?.scheduleResourceIds).toEqual(["33416821"]);
  });

  it("dayPlannerStubRow mirrors an online booking from the entry alone: ids, dates, host name, location — no money, no contact", () => {
    const entries = dayPlannerEntries(dp);
    const persons = dayPlannerPersons(dp);
    const stub = dayPlannerStubRow(entries.get(FIXTURE_ONLINE_PROJECT_ID)!, persons, {
      clientKey: "headpinzftmyers",
      source: "backfill",
      lookups: fixtureMetadata(),
      scheduleResourceIds: ["33416821"],
    });
    expect(stub).toMatchObject({
      projectId: FIXTURE_ONLINE_PROJECT_ID,
      number: "W59922",
      name: "Online booking",
      kindId: ONLINE_KIND_ID,
      stateId: "-3",
      stateName: "Confirmation",
      personId: FIXTURE_ONLINE_PERSON_ID,
      personName: "Ana Rodriguez",
      persons: 4,
      eventDate: "2025-09-21",
      eventStart: "2025-09-21T23:30:00.000Z",
      bmiCreatedAt: "2025-09-20T00:11:00.000Z",
      locationId: 467486,
      totalValueCents: null,
      personPhone: null,
      products: null,
      raw: null,
      source: "backfill",
    });
    expect(
      dayPlannerStubRow({ id: null }, persons, {
        clientKey: "x",
        source: "backfill",
        lookups: null,
      }),
    ).toBeNull();
  });

  it("NEGATIVE CONTROL — the fixture's persons carry bare 17-digit ids that JSON.parse would round", () => {
    const naive = JSON.parse(fixtureText("office-dayplanner-2025-09.json.txt")) as {
      reservations: { projects: { personId: number }[] };
    };
    expect(String(naive.reservations.projects[0]?.personId)).not.toBe(FIXTURE_HOST_PERSON_ID);
    expect(dp.reservations?.projects?.[0]?.personId).toBe(FIXTURE_HOST_PERSON_ID);
  });
});

describe("liveReservations → ids and partial rows", () => {
  const live = officeParse<OfficeLiveReservation[]>(
    fixtureText("office-livereservations.json.txt"),
  );

  it("lists the changed ids once each", () => {
    expect(liveReservationIds([...live, live[0]!])).toEqual([
      FIXTURE_PROJECT_ID,
      FIXTURE_ONLINE_PROJECT_ID,
    ]);
  });

  it("a partial row resolves the live row's NAMES back to ids and never invents one", () => {
    const meta = fixtureMetadata();
    const row = liveReservationRow(live[0]!, "headpinzftmyers", meta);
    expect(row).toMatchObject({
      projectId: FIXTURE_PROJECT_ID,
      number: "H3248",
      stateName: "Send Contract",
      stateId: "49130082",
      responsibleName: "Kelsea Kosco",
      responsibleUserId: "28267036",
      personName: "Dana Acme",
      eventDate: "2025-09-20",
      totalValueCents: 119_997,
      balanceCents: 119_997,
      source: "delta",
      raw: null,
    });
    // Ids the metadata cannot place take their NAME down with them: the upsert
    // COALESCEs the id, so a fresh name beside a stale id would be a lie.
    const unknown = liveReservationRow(
      { ...live[0]!, state: "Fresh Status", responsible: "Nobody At All" },
      "headpinzftmyers",
      meta,
    );
    expect(unknown).toMatchObject({
      stateId: null,
      stateName: null,
      responsibleUserId: null,
      responsibleName: null,
      number: "H3248",
    });
    expect(liveReservationRow({ id: "" }, "x", meta)).toBeNull();
  });
});
