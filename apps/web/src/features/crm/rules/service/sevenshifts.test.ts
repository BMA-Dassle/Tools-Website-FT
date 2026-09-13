import { describe, expect, it } from "vitest";
import { HttpResponse, http, installMsw, rawJson } from "@/test/msw/server";
import {
  SEVEN_SHIFTS_BASE,
  sevenShiftsFixtures,
  sevenShiftsHandlers,
} from "@/test/msw/handlers/sevenshifts";
import {
  SEVEN_SHIFTS_API_VERSION,
  SEVEN_SHIFTS_TOKEN_MISSING,
  SEVEN_SHIFTS_USER_AGENT,
  SevenShiftsClient,
  SevenShiftsError,
  isLiveShift,
  sevenShiftsConfig,
  shiftsQuery,
} from "./sevenshifts";

/**
 * The 7shifts client against MSW (brief B2 "MSW 7shifts: include_draft +
 * deleted filtering, offset timestamps, cursor pagination") plus the pacing,
 * headers and retry rules of §1.9. No real host is ever reached
 * (`onUnhandledRequest: "error"`).
 */

const server = installMsw(...sevenShiftsHandlers);

const ENV = { SEVEN_SHIFTS_API_TOKEN: "test-token" };

/** A sleeper that records the waits instead of waiting. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("config", () => {
  it("reads SEVEN_SHIFTS_API_TOKEN, falls back to SEVEN_SHIFTS_ACCESS_TOKEN, company 265994", () => {
    expect(sevenShiftsConfig({})).toEqual({
      token: null,
      companyId: "265994",
      baseUrl: "https://api.7shifts.com/v2/company/265994",
    });
    expect(sevenShiftsConfig({ SEVEN_SHIFTS_ACCESS_TOKEN: "b" }).token).toBe("b");
    expect(
      sevenShiftsConfig({
        SEVEN_SHIFTS_API_TOKEN: "a",
        SEVEN_SHIFTS_ACCESS_TOKEN: "b",
        SEVEN_SHIFTS_COMPANY_ID: "1",
      }),
    ).toEqual({ token: "a", companyId: "1", baseUrl: "https://api.7shifts.com/v2/company/1" });
  });

  it("without a token the client refuses before any request", async () => {
    const client = new SevenShiftsClient({ env: {}, sleep: fakeSleep().sleep });
    expect(client.configured).toBe(false);
    await expect(
      client.listShifts({ locationId: 332160, fromYmd: "2026-09-12", toYmd: "2026-09-13" }),
    ).rejects.toThrow(SEVEN_SHIFTS_TOKEN_MISSING);
  });
});

describe("shiftsQuery (§1.9, portal T5)", () => {
  it("wall-clock bounds, end + 1 day 04:59:59, limit 500, include_draft, no Z", () => {
    const q = shiftsQuery(332160, "2026-09-12", "2026-09-13");
    expect(q.get("location_id")).toBe("332160");
    expect(q.get("start[gte]")).toBe("2026-09-12 00:00:00");
    expect(q.get("start[lte]")).toBe("2026-09-14 04:59:59");
    expect(q.get("limit")).toBe("500");
    expect(q.get("include_draft")).toBe("true");
    expect(q.toString()).not.toContain("Z");
  });

  it("isLiveShift drops deleted and *_deleted rows", () => {
    expect(isLiveShift({ deleted: false, publish_status: "published" })).toBe(true);
    expect(isLiveShift({ deleted: true, publish_status: "published" })).toBe(false);
    expect(isLiveShift({ deleted: false, publish_status: "published_deleted" })).toBe(false);
    expect(isLiveShift({ deleted: false, publish_status: "draft" })).toBe(true);
    expect(isLiveShift({})).toBe(true);
  });
});

describe("listShifts against the fixture", () => {
  it("sends the browser UA, the api version and the bearer; filters the deleted row; keeps offsets verbatim", async () => {
    let seen: Headers | null = null;
    let url = "";
    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/shifts`, ({ request }) => {
        seen = request.headers;
        url = request.url;
        return rawJson(sevenShiftsFixtures.shifts());
      }),
    );
    const client = new SevenShiftsClient({ env: ENV, sleep: fakeSleep().sleep });
    const shifts = await client.listShifts({
      locationId: 332160,
      fromYmd: "2026-09-12",
      toYmd: "2026-09-13",
    });

    expect(seen!.get("user-agent")).toBe(SEVEN_SHIFTS_USER_AGENT);
    expect(seen!.get("x-api-version")).toBe(SEVEN_SHIFTS_API_VERSION);
    expect(seen!.get("authorization")).toBe("Bearer test-token");
    const params = new URL(url).searchParams;
    expect(params.get("include_draft")).toBe("true");
    expect(params.get("start[lte]")).toBe("2026-09-14 04:59:59");

    // 3 in the fixture, one published_deleted → 2 live; the open shift stays with userId null.
    expect(shifts.map((s) => s.id)).toEqual(["8801234501", "8801234503"]);
    expect(shifts[0]).toEqual({
      id: "8801234501",
      userId: 6543210,
      locationId: 332160,
      start: "2026-09-12T10:00:00-04:00",
      end: "2026-09-12T18:00:00-04:00",
      localDate: "2026-09-12",
    });
    expect(shifts[1].userId).toBeNull();
    expect(shifts[1].localDate).toBe("2026-09-13");
  });

  it("follows meta.cursor.next until it is null and concatenates the pages", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/shifts`, ({ request }) => {
        const c = new URL(request.url).searchParams.get("cursor");
        cursors.push(c);
        if (!c) {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                user_id: 10,
                location_id: 332160,
                start: "2026-09-12T09:00:00-04:00",
                end: "2026-09-12T12:00:00-04:00",
              },
            ],
            meta: { cursor: { next: "page-2" } },
          });
        }
        return HttpResponse.json({
          data: [
            {
              id: 2,
              user_id: 11,
              location_id: 332160,
              start: "2026-09-12T13:00:00-04:00",
              end: "2026-09-12T17:00:00-04:00",
            },
          ],
          meta: { cursor: { next: null } },
        });
      }),
    );
    const client = new SevenShiftsClient({ env: ENV, sleep: fakeSleep().sleep });
    const shifts = await client.listShifts({
      locationId: 332160,
      fromYmd: "2026-09-12",
      toYmd: "2026-09-12",
    });
    expect(cursors).toEqual([null, "page-2"]);
    expect(shifts.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("calls are serial with the 150 ms gap between them (none before the first)", async () => {
    const { waits, sleep } = fakeSleep();
    const client = new SevenShiftsClient({ env: ENV, sleep });
    await Promise.all([
      client.listShifts({ locationId: 332160, fromYmd: "2026-09-12", toYmd: "2026-09-13" }),
      client.listShifts({ locationId: 467486, fromYmd: "2026-09-12", toYmd: "2026-09-13" }),
      client.listUsers(),
    ]);
    expect(waits).toEqual([150, 150]);
  });

  it("retries a 429 then succeeds; a 401 is not retried; three 503s give up with the status", async () => {
    let n = 0;
    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/shifts`, () => {
        n++;
        return n === 1
          ? new HttpResponse("slow down", { status: 429 })
          : rawJson(sevenShiftsFixtures.shifts());
      }),
    );
    const a = fakeSleep();
    const client = new SevenShiftsClient({ env: ENV, sleep: a.sleep });
    const shifts = await client.listShifts({
      locationId: 332160,
      fromYmd: "2026-09-12",
      toYmd: "2026-09-13",
    });
    expect(shifts).toHaveLength(2);
    expect(n).toBe(2);
    expect(a.waits).toEqual([150]); // the retry backoff; no inter-call gap for the first call

    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/users`, () => new HttpResponse("nope", { status: 401 })),
    );
    let calls = 0;
    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/users`, () => {
        calls++;
        return new HttpResponse("nope", { status: 401 });
      }),
    );
    await expect(client.listUsers()).rejects.toBeInstanceOf(SevenShiftsError);
    expect(calls).toBe(1);

    let fails = 0;
    server.use(
      http.get(`${SEVEN_SHIFTS_BASE}/shifts`, () => {
        fails++;
        return new HttpResponse("down", { status: 503 });
      }),
    );
    const err = await client
      .listShifts({ locationId: 332145, fromYmd: "2026-09-12", toYmd: "2026-09-13" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SevenShiftsError);
    expect((err as SevenShiftsError).status).toBe(503);
    expect(fails).toBe(3);
  });

  it("listUsers returns the join key", async () => {
    const client = new SevenShiftsClient({ env: ENV, sleep: fakeSleep().sleep });
    const users = await client.listUsers();
    expect(users.find((u) => u.email === "kelsea@headpinz.com")?.id).toBe(6543210);
  });
});
