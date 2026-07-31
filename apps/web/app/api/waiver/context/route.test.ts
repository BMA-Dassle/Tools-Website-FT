import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/redis", () => ({
  default: { get: vi.fn(async () => null), setex: vi.fn(async () => {}) },
}));
vi.mock("~/features/daily-events/service", () => ({ getReservationDetail: vi.fn() }));
vi.mock("~/features/kiosk/data/kiosk-waiver-joins-db", () => ({
  listJoinsForProject: vi.fn(async () => []),
}));
// Only the Pandora read is stubbed; unionValidWithJoins stays REAL so the count
// under test is the same rule the kiosk roster uses.
vi.mock("~/features/kiosk/waiver/valid-count", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/features/kiosk/waiver/valid-count")>();
  return { ...actual, waiverValidNow: vi.fn(async () => false) };
});

vi.mock("@/lib/waiver-short-link", () => ({
  WAIVER_LINK_COOKIE: "wv_cap",
  waiverLinkGrantsOrganizerFor: vi.fn(async () => false),
}));

import { GET } from "./route";
import redis from "@/lib/redis";
import { waiverLinkGrantsOrganizerFor } from "@/lib/waiver-short-link";
import { getReservationDetail } from "~/features/daily-events/service";
import { listJoinsForProject } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { waiverValidNow } from "~/features/kiosk/waiver/valid-count";
import type { ReservationDetail } from "~/features/daily-events/types";

const mockDetail = vi.mocked(getReservationDetail);
const mockJoins = vi.mocked(listJoinsForProject);
const mockValid = vi.mocked(waiverValidNow);

function makeReq(qs: string) {
  return new NextRequest(`https://x/api/waiver/context${qs}`);
}

const mockGrant = vi.mocked(waiverLinkGrantsOrganizerFor);
// ioredis's overloaded signature defeats vi.mocked — cast to the plain mock.
const mockRedisGet = redis.get as unknown as ReturnType<typeof vi.fn>;

/** A request carrying an ORGANIZER grant — the only way a roster is returned. */
function makeOrganizerReq(qs: string) {
  mockGrant.mockResolvedValue(true);
  const req = new NextRequest(`https://x/api/waiver/context${qs}`);
  req.cookies.set("wv_cap", "ORGcode1234567890");
  return req;
}

const detail = (over: Partial<ReservationDetail>): ReservationDetail =>
  ({ id: "123", schedules: [], products: [], payments: [], ...over }) as ReservationDetail;

beforeEach(() => {
  mockDetail.mockReset();
  mockJoins.mockReset().mockResolvedValue([]);
  mockValid.mockReset().mockResolvedValue(false);
  mockGrant.mockReset().mockResolvedValue(false);
});

describe("GET /api/waiver/context", () => {
  it("returns a lean, PII-safe summary for a group event", async () => {
    mockDetail.mockResolvedValue(
      detail({
        name: "Smith Birthday Party",
        kind: "Group function",
        when: "2026-08-02T14:00:00",
        persons: 12,
        // sensitive fields present on the source — must NOT reach the response
        balance: 999_00,
        schedules: [
          { resourceName: "Laser Tag" },
          { resourceName: "Blue Track" },
        ] as unknown as ReservationDetail["schedules"],
        persons_list: [
          { firstName: "Jane", name: "Doe" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      label: "Smith Birthday Party",
      activity: "Laser Tag · Blue Track",
      centerName: "FastTrax Fort Myers",
      total: 12,
    });
    expect(body.whenLabel).toContain("Aug");
    // Only these keys — no balance / persons_list / products / payments leak.
    expect(Object.keys(body).sort()).toEqual(
      ["activity", "canManage", "centerName", "label", "ok", "signed", "total", "whenLabel"].sort(),
    );
    expect(mockDetail).toHaveBeenCalledWith(467486, "51383608");
  });

  it("counts signed waivers without returning WHO signed", async () => {
    mockDetail.mockResolvedValue(
      detail({
        name: "Fireservice Inc",
        kind: "Group function",
        when: "2026-12-18T12:00:00",
        persons: 4,
        persons_list: [
          { personId: "1", firstName: "Ann", name: "Alpha" },
          { personId: "2", firstName: "Bob", name: "Beta" },
          { personId: "3", firstName: "Cid", name: "Gamma" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    // Ann + Cid hold valid Pandora waivers; Dee signed via /waiver (a Neon join)
    // and is NOT on the BMI person list at all.
    mockValid.mockImplementation(async (personId: string) => personId === "1" || personId === "3");
    mockJoins.mockResolvedValue([{ personId: "9", displayName: "Dee D." }] as unknown as Awaited<
      ReturnType<typeof listJoinsForProject>
    >);

    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(body.signed).toBe(3); // Ann, Cid, Dee
    expect(body.total).toBe(4);
    // The whole point of this endpoint: a forwardable link never carries names.
    const serialized = JSON.stringify(body);
    for (const name of ["Ann", "Alpha", "Bob", "Beta", "Cid", "Gamma", "Dee"]) {
      expect(serialized).not.toContain(name);
    }
  });

  it("omits `signed` rather than reporting 0 when the count cannot be produced", async () => {
    // A count that never resolves must not hold up the header, and must not be
    // rendered as a confident "0 of 100".
    mockDetail.mockResolvedValue(
      detail({
        name: "Big Event",
        persons: 100,
        persons_list: [
          { personId: "1", firstName: "A", name: "One" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockImplementation(() => new Promise<boolean>(() => {})); // never settles
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.label).toBe("Big Event"); // header still renders
    expect(body.total).toBe(100);
    expect("signed" in body).toBe(false);
  }, 10_000);

  it("never reports more signed than registered", async () => {
    mockDetail.mockResolvedValue(detail({ name: "Small Party", persons: 1, persons_list: [] }));
    mockJoins.mockResolvedValue([
      { personId: "7", displayName: "Extra One" },
      { personId: "8", displayName: "Extra Two" },
    ] as unknown as Awaited<ReturnType<typeof listJoinsForProject>>);
    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(body.signed).toBe(1);
  });

  // ── Online-booking roster (owner 2026-07-30) ────────────────────────
  // "For regular racing, laser and gel reservation, it should always pull up
  // everyone that has registered for that reservation. I don't think we need this
  // for contract events because those people make way back to contract
  // confirmation page."

  it("returns a REDACTED roster with per-person validity for an online booking", async () => {
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        when: "2026-08-02T14:00:00",
        persons: 3,
        persons_list: [
          { personId: "11", firstName: "Ann", name: "Alpha" },
          { personId: "12", firstName: "Bob", name: "Beta" },
          { personId: "13", firstName: "Cid", name: "Gamma" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockImplementation(
      async (personId: string) => personId === "11" || personId === "13",
    );

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    // Everyone on the booking is returned — including the ones still unsigned,
    // which is the entire point: the page can preload the party.
    expect(body.roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "12", displayName: "Bob B.", waiverValid: false },
      { personId: "13", displayName: "Cid G.", waiverValid: true },
    ]);
    // The fraction and the list are one result — they cannot disagree.
    expect(body.signed).toBe(2);
    expect(body.total).toBe(3);
    expect(body.roster.filter((r: { waiverValid: boolean }) => r.waiverValid)).toHaveLength(
      body.signed,
    );
    // Redacted, not anonymous: "Ann A." is allowed here, a full name never is.
    const serialized = JSON.stringify(body);
    for (const surname of ["Alpha", "Beta", "Gamma", "Gallagher"]) {
      expect(serialized).not.toContain(surname);
    }
  });

  it("returns NO roster for a group function (contract parties return via the contract page)", async () => {
    mockDetail.mockResolvedValue(
      detail({
        name: "Fireservice Inc",
        kind: "Group function",
        persons: 3,
        persons_list: [
          { personId: "11", firstName: "Ann", name: "Alpha" },
          { personId: "12", firstName: "Bob", name: "Beta" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockResolvedValue(true);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect("roster" in body).toBe(false);
    expect(body.signed).toBe(2); // the count still works exactly as before
    // NOTHING may leak for a contract event — not even a redacted first name.
    const serialized = JSON.stringify(body);
    for (const name of ["Ann", "Alpha", "Bob", "Beta"]) {
      expect(serialized).not.toContain(name);
    }
  });

  it("redacts a full name whatever shape BMI's persons_list sends it in", async () => {
    // The 2026-07-30 leak: BMI's personsByIds profiles routinely park the WHOLE
    // name in `firstName` with an empty surname, and the roster passed that field
    // through verbatim onto a link built to be forwarded to a party.
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        persons: 5,
        persons_list: [
          { personId: "11", firstName: "Ann Alpha", name: "" }, // whole name in first
          { personId: "12", firstName: "Mary Jane Watson-Parker" }, // no surname key at all
          { personId: "13", firstName: "", name: "Beta" }, // surname only
          { personId: "14", firstName: "Cher", name: "" }, // mononym
          { personId: "15", firstName: "Ana", name: "García Pérez" }, // two-part surname
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockResolvedValue(true);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(body.roster.map((r: { displayName: string }) => r.displayName)).toEqual([
      "Ann A.",
      "Mary W.",
      "B.", // never a bare surname
      "Cher", // a mononym is already as redacted as it gets
      "Ana G.", // the surname FIELD stays authoritative — not "Ana P."
    ]);
    // Nothing in the wire payload carries a second name token.
    const serialized = JSON.stringify(body);
    for (const surname of ["Alpha", "Watson", "Parker", "Beta", "Pérez", "Gallagher"]) {
      expect(serialized).not.toContain(surname);
    }
  });

  it("holds the roster's display-name property for every row it returns", async () => {
    // The invariant itself, not a list of examples: a forwardable roster row may
    // carry a given name and at most ONE initial. Nothing else.
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        persons: 3,
        persons_list: [
          { personId: "11", firstName: "Ann Alpha" },
          { personId: "12", firstName: "  Mary   Jane   Watson-Parker  ", name: "  " },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockResolvedValue(false);
    // A legacy kiosk_waiver_joins row, written before the helper was fixed.
    mockJoins.mockResolvedValue([
      { personId: "99", displayName: "Dee Delta Epsilon" },
    ] as unknown as Awaited<ReturnType<typeof listJoinsForProject>>);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(body.roster).toHaveLength(3);
    for (const row of body.roster as Array<{ displayName: string }>) {
      const tokens = row.displayName.split(" ");
      expect(tokens.length, row.displayName).toBeLessThanOrEqual(2);
      if (tokens.length === 2) expect(tokens[1], row.displayName).toMatch(/^\p{L}\.$/u);
    }
    expect(JSON.stringify(body)).not.toMatch(/Alpha|Watson|Parker|Delta|Epsilon/);
  });

  it("keeps a 17-digit BMI person id a string end to end", async () => {
    const bigId = "51383608123456789"; // > Number.MAX_SAFE_INTEGER
    expect(Number(bigId)).toBeGreaterThan(Number.MAX_SAFE_INTEGER); // guard the guard
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        persons: 1,
        persons_list: [
          { personId: bigId, firstName: "Ann", name: "Alpha" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockResolvedValue(true);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const text = await res.text();
    // Quoted in the wire payload — never serialized as a bare number (which would
    // round the last digits, the production off-by-one).
    expect(text).toContain(`"personId":"${bigId}"`);
    const body = JSON.parse(text);
    expect(body.roster[0].personId).toBe(bigId);
    expect(typeof body.roster[0].personId).toBe("string");
  });

  it("marks a registered person signed from our Neon join, and rosters a join-only signer", async () => {
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        persons: 4,
        persons_list: [
          { personId: "11", firstName: "Ann", name: "Alpha" },
          { personId: "12", firstName: "Bob", name: "Beta" },
          { personId: "13", firstName: "Cid", name: "Gamma" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockImplementation(async (personId: string) => personId === "11");
    mockJoins.mockResolvedValue([
      // Bob signed through /waiver; his join carries the SHORT Pandora id while BMI
      // surfaces a different id for the same human — the flag must land on HIS row.
      { personId: "9912", displayName: "Bob B." },
      // Dee signed but her BMI attach failed, so she is on no BMI person list.
      { personId: "99", displayName: "Dee D." },
    ] as unknown as Awaited<ReturnType<typeof listJoinsForProject>>);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(body.roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "12", displayName: "Bob B.", waiverValid: true }, // via the join
      { personId: "13", displayName: "Cid G.", waiverValid: false },
      { personId: "99", displayName: "Dee D.", waiverValid: true }, // attach failed
    ]);
    // Bob is counted ONCE, not once as a registered row and again as a join.
    expect(body.signed).toBe(3);
    expect(body.roster.filter((r: { waiverValid: boolean }) => r.waiverValid)).toHaveLength(
      body.signed,
    );
  });

  it("omits the roster (not just `signed`) when the waiver sweep misses the deadline", async () => {
    // `roster` present must mean every `waiverValid` is real. Shipping the names
    // with validity guessed `false` would tell signed guests to sign again.
    mockDetail.mockResolvedValue(
      detail({
        name: "Ross Gallagher",
        kind: "Online booking",
        persons: 2,
        persons_list: [
          { personId: "11", firstName: "Ann", name: "Alpha" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    mockValid.mockImplementation(() => new Promise<boolean>(() => {})); // never settles

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(body.label).toBe("Ross G."); // header still renders
    expect("signed" in body).toBe(false);
    expect("roster" in body).toBe(false);
  }, 10_000);

  // ── The ORGANIZER gate ────────────────────────────────────────────────────
  // Every roster test above passes a granted request. These are the ones that
  // prove the grant is load-bearing rather than decorative.

  it("withholds the roster from a link that carries NO grant", async () => {
    mockDetail.mockResolvedValue(
      detail({
        kind: "Online booking",
        name: "Ross Geller",
        persons: 3,
        persons_list: [
          { personId: "11", firstName: "Ross", name: "Geller" },
          { personId: "12", firstName: "Mon", name: "Geller" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    // No cookie at all — a plain /waiver?c=&loc=&pid= visit.
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(body.roster).toBeUndefined();
    expect(body.canManage).toBe(false);
    // The COUNT still works — the fraction is not a privilege.
    expect(body.total).toBe(3);
    expect(body.signed).toBe(0);
    // And no name leaks in some other field.
    expect(JSON.stringify(body)).not.toContain("Geller");
  });

  it("withholds the roster when the grant is for ANOTHER reservation", async () => {
    // waiverLinkGrantsOrganizerFor binds the code to a projectId; a cookie left by a
    // different booking (or another guest on a shared in-center device) grants nothing.
    mockGrant.mockResolvedValue(false);
    mockDetail.mockResolvedValue(
      detail({
        kind: "Online booking",
        persons: 2,
        persons_list: [
          { personId: "11", firstName: "Ross", name: "Geller" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    const req = new NextRequest(
      "https://x/api/waiver/context?c=fort-myers&loc=467486&pid=51383608",
    );
    req.cookies.set("wv_cap", "SOMEONEELSEScode1");
    const body = await (await GET(req)).json();
    expect(body.roster).toBeUndefined();
    expect(body.canManage).toBe(false);
  });

  it("marks the response private so no cache can replay it to another holder", async () => {
    // The body varies by cookie now. A shared cache entry would hand a register-code
    // holder the organizer's party list.
    mockDetail.mockResolvedValue(detail({ kind: "Online booking", persons: 1 }));
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("vary")).toContain("cookie");
  });

  it("never reports completion for a party whose headcount BMI sent as 0", async () => {
    // The false-completion bug: total came from detail.persons while the people came
    // from persons_list. With persons=0 the clamp fell back to the signed count, so
    // "0 of 0" rendered as done over a list of guests who had signed nothing.
    mockDetail.mockResolvedValue(
      detail({
        kind: "Online booking",
        persons: 0,
        persons_list: [
          { personId: "11", firstName: "Ross", name: "Geller" },
          { personId: "12", firstName: "Mon", name: "Geller" },
          { personId: "13", firstName: "Joey", name: "Trib" },
        ] as unknown as ReservationDetail["persons_list"],
      }),
    );
    const body = await (
      await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"))
    ).json();
    expect(body.total).toBe(3);
    expect(body.signed).toBe(0);
    expect(body.signed).toBeLessThan(body.total);
  });

  it("reduces an online reservation's full name to a short label (no PII)", async () => {
    mockDetail.mockResolvedValue(
      detail({ name: "Ross Gallagher", kind: "Online booking", persons: 2, schedules: [] }),
    );
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=999"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.label).not.toContain("Gallagher"); // last name redacted
  });

  it("400s on an invalid center", async () => {
    const res = await GET(makeReq("?c=miami&loc=467486&pid=1"));
    expect(res.status).toBe(400);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it("400s when the locationId is not part of the center", async () => {
    const res = await GET(makeReq("?c=naples&loc=467486&pid=1")); // 467486 is a Fort Myers loc
    expect(res.status).toBe(400);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric projectId (no bigint coercion)", async () => {
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=abc"));
    expect(res.status).toBe(400);
    expect(mockDetail).not.toHaveBeenCalled();
  });
});

describe("GET /api/waiver/context — cache interplay", () => {
  const onlineDetail = () =>
    detail({
      name: "Ross Gallagher",
      kind: "Online booking",
      when: "2026-08-02T14:00:00",
      persons: 2,
      persons_list: [
        { personId: "11", firstName: "Ann", name: "Alpha" },
        { personId: "12", firstName: "Bob", name: "Beta" },
      ] as unknown as ReservationDetail["persons_list"],
    });

  const cachedSummary = JSON.stringify({
    ok: true,
    label: "Ross G.",
    activity: "Blue Track",
    whenLabel: "Sun, Aug 2 · 2:00 PM",
    centerName: "FastTrax Fort Myers",
    total: 2,
  });

  beforeEach(() => {
    mockRedisGet.mockReset().mockResolvedValue(null);
  });

  it("re-runs the sweep when the summary is cached but the sweep state is not", async () => {
    // THE 2026-07-31 production symptom: one cold sweep missed its deadline, the
    // summary cached anyway, and every request for the next 120s early-returned
    // off that summary — the organizer never saw a roster at all.
    mockRedisGet.mockImplementation(async (key: string) =>
      key.startsWith("waiver:ctx:state:") ? null : cachedSummary,
    );
    mockDetail.mockResolvedValue(onlineDetail());
    mockValid.mockResolvedValue(true);

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(mockDetail).toHaveBeenCalled(); // fell through — did NOT answer from cache
    expect(res.headers.get("x-waiver-cache")).toBe("miss");
    expect(body.signed).toBe(2);
    expect(body.roster).toHaveLength(2);
  });

  it("answers from cache when BOTH the summary and the sweep state are present", async () => {
    const state = JSON.stringify({
      signed: 1,
      roster: [
        { personId: "11", displayName: "Ann A.", waiverValid: true },
        { personId: "12", displayName: "Bob B.", waiverValid: false },
      ],
    });
    mockRedisGet.mockImplementation(async (key: string) =>
      key.startsWith("waiver:ctx:state:") ? state : cachedSummary,
    );

    const res = await GET(makeOrganizerReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(mockDetail).not.toHaveBeenCalled();
    expect(res.headers.get("x-waiver-cache")).toBe("hit");
    expect(body.signed).toBe(1);
    expect(body.roster).toHaveLength(2);
  });

  it("retries the detail fetch once before giving up (transient BMI failure)", async () => {
    mockDetail
      .mockRejectedValueOnce(new Error("BMI hiccup"))
      .mockResolvedValueOnce(onlineDetail());

    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();

    expect(mockDetail).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
  });

  it("still 502s when the detail fetch fails twice", async () => {
    mockDetail.mockRejectedValue(new Error("BMI down"));
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    expect(res.status).toBe(502);
    expect(mockDetail).toHaveBeenCalledTimes(2);
  });
});
