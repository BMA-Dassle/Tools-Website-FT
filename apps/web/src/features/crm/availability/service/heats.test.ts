import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureText } from "../../../../../test/msw/handlers/fixture";
import { OFFICE_BASE, officeHandlers } from "../../../../../test/msw/handlers/office";
import { http, installMsw, rawJson } from "../../../../../test/msw/server";

/**
 * The Office `dayPlanner` read, against MSW, with the raw-id discipline §3.10
 * demands of every Office fixture:
 *
 *   - the fixture is RAW JSON TEXT with BARE 17-digit numbers, never an
 *     `HttpResponse.json({ id: 63000000009561437 })` — a numeric literal is
 *     already rounded by the time the object exists, so a test written that way
 *     would pass while `parseWithRawIds` did nothing;
 *   - and the negative control below names the rounded value, so the test can
 *     actually fail if the transport ever goes back to `JSON.parse`.
 *
 * The shape itself was read live from `headpinzftmyers` location 467486 on
 * 2026-09-13 (`planning[].blocks[] {start, stop, capacity, freePlaces,
 * bookedSpots, description}`, wall clock with no offset).
 */

/** The id as Office sends it, and what `JSON.parse` silently turns it into. */
const TRUE_PROJECT_ID = "63000000009561437";
const ROUNDED_PROJECT_ID = "63000000009561440";

const redisStore = new Map<string, string>();
const cacheWrites: string[] = [];

vi.mock("@/lib/redis", () => ({
  default: {
    get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
    set: (key: string, value: string) => {
      if (key.startsWith("crm:avail")) cacheWrites.push(key);
      redisStore.set(key, value);
      return Promise.resolve("OK");
    },
  },
}));

const dayPlannerText = () => fixtureText("office-dayplanner-fasttrax.json.txt");

installMsw(
  ...officeHandlers,
  http.get(`${OFFICE_BASE}/api/:clientKey/dayPlanner`, () => rawJson(dayPlannerText())),
);

const { firstRunOfHeats, heatsNeeded, projectPlanning, readHeats } = await import("./heats");
const { officeGet } = await import("~/features/daily-events/data/bmi-office");

const DATE = "2026-10-17";

beforeEach(() => {
  redisStore.clear();
  cacheWrites.length = 0;
  process.env.BMI_OFFICE_USERNAME = "test-user";
  process.env.BMI_OFFICE_PASSWORD_B64 = Buffer.from("test-pass").toString("base64");
});

describe("the Office transport keeps 17-digit ids intact", () => {
  it("reads the dayPlanner through parseWithRawIds, and JSON.parse would not", async () => {
    const text = dayPlannerText();
    // NEGATIVE CONTROL, and it is the whole point: the raw text carries a bare
    // 17-digit number, so ordinary parsing rounds it and reads back the WRONG
    // project — the production off-by-one, in one line.
    const naive = JSON.parse(text) as {
      reservations: { projectSchedules: { projectId: number }[] };
    };
    expect(String(naive.reservations.projectSchedules[0].projectId)).toBe(ROUNDED_PROJECT_ID);
    expect(String(naive.reservations.projectSchedules[0].projectId)).not.toBe(TRUE_PROJECT_ID);

    const parsed = await officeGet<{
      reservations: { projectSchedules: { projectId: string }[] };
    }>("headpinzftmyers", `dayPlanner?from=${DATE}&till=${DATE}`);
    expect(parsed.reservations.projectSchedules[0].projectId).toBe(TRUE_PROJECT_ID);
    expect(typeof parsed.reservations.projectSchedules[0].projectId).toBe("string");
  });
});

describe("projectPlanning", () => {
  it("turns planning blocks into heats in centre-local minutes", () => {
    const resources = projectPlanning(JSON.parse(dayPlannerText()), {
      "11208654": "Blue Track",
      "11208660": "Red Track",
    });
    const blue = resources.find((r) => r.resourceName === "Blue Track");
    expect(blue?.isTrack).toBe(true);
    expect(blue?.capacity).toBe(14);
    expect(blue?.blocks).toHaveLength(6);
    expect(blue?.blocks[0]).toEqual({
      start: 16 * 60,
      stop: 16 * 60 + 12,
      label: "4:00 PM",
      capacity: 14,
      freePlaces: 14,
      bookedSpots: 0,
      description: "Blue Track",
    });
  });

  it("names a resource it has no metadata for rather than dropping it", () => {
    const resources = projectPlanning(JSON.parse(dayPlannerText()), {});
    expect(resources.map((r) => r.resourceName)).toContain("Resource 11208654");
  });
});

describe("heatsNeeded", () => {
  it("is the headline estimate, and says nothing when capacity is unknown", () => {
    expect(heatsNeeded(30, 14)).toBe(3);
    expect(heatsNeeded(14, 14)).toBe(1);
    expect(heatsNeeded(1, 14)).toBe(1);
    expect(heatsNeeded(30, 0)).toBe(0);
  });
});

describe("firstRunOfHeats", () => {
  const blue = () =>
    projectPlanning(JSON.parse(dayPlannerText()), { "11208654": "Blue Track" }).find(
      (r) => r.resourceName === "Blue Track",
    )!.blocks;

  it("seats a party across back-to-back heats using each heat's own free places", () => {
    // 14 free at 4:00 + 6 free at 4:12 = 20, and the two heats touch.
    const run = firstRunOfHeats(blue(), 20);
    expect(run?.map((b) => b.label)).toEqual(["4:00 PM", "4:12 PM"]);
  });

  it("will not step over a full heat to make the numbers work", () => {
    // 4:24 is full, so the only run big enough for 30 starts after it.
    const run = firstRunOfHeats(blue(), 30);
    expect(run?.map((b) => b.label)).toEqual(["4:36 PM", "4:48 PM", "5:00 PM"]);
  });

  it("will not split a party across a gap in the schedule", () => {
    // Red Track's two heats are 4:00 and 4:24 — not back to back — so 20
    // racers do not fit even though 24 places are free on paper.
    const red = projectPlanning(JSON.parse(dayPlannerText()), {
      "11208660": "Red Track",
    }).find((r) => r.resourceName === "Red Track")!.blocks;
    expect(firstRunOfHeats(red, 20)).toBeNull();
    expect(firstRunOfHeats(red, 12)?.map((b) => b.label)).toEqual(["4:00 PM"]);
  });

  it("answers null rather than a run it cannot fill", () => {
    expect(firstRunOfHeats(blue(), 1000)).toBeNull();
    expect(firstRunOfHeats([], 10)).toBeNull();
    expect(firstRunOfHeats(blue(), 0)).toBeNull();
  });

  it("can be asked to start after a given time", () => {
    const run = firstRunOfHeats(blue(), 10, { fromMinute: 16 * 60 + 36 });
    expect(run?.[0].label).toBe("4:36 PM");
  });
});

describe("readHeats", () => {
  it("reads FastTrax and caches the projection for a minute", async () => {
    const first = await readHeats("FT", DATE);
    expect(first.cached).toBe(false);
    expect(first.locationId).toBe(467486);
    expect(first.clientKey).toBe("headpinzftmyers");
    expect(first.resources.map((r) => r.resourceName)).toEqual(["Blue Track", "Red Track"]);
    expect(cacheWrites).toEqual(["crm:avail:heats:467486:2026-10-17"]);

    const second = await readHeats("FT", DATE);
    expect(second.cached).toBe(true);
    expect(cacheWrites).toHaveLength(1);
    expect(second.resources).toEqual(first.resources);
  });

  it("goes back to Office when the planner asks for a refresh", async () => {
    await readHeats("FT", DATE);
    const fresh = await readHeats("FT", DATE, { refresh: true });
    expect(fresh.cached).toBe(false);
    expect(cacheWrites).toHaveLength(2);
  });

  it("puts the tracks first, because that is what a party books", async () => {
    const read = await readHeats("FT", DATE);
    expect(read.resources[0].isTrack).toBe(true);
  });
});
