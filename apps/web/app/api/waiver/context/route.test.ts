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

import { GET } from "./route";
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

const detail = (over: Partial<ReservationDetail>): ReservationDetail =>
  ({ id: "123", schedules: [], products: [], payments: [], ...over }) as ReservationDetail;

beforeEach(() => {
  mockDetail.mockReset();
  mockJoins.mockReset().mockResolvedValue([]);
  mockValid.mockReset().mockResolvedValue(false);
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
      ["activity", "centerName", "label", "ok", "signed", "total", "whenLabel"].sort(),
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
    const res = await GET(makeReq("?c=fort-myers&loc=467486&pid=51383608"));
    const body = await res.json();
    expect(body.signed).toBe(1);
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
