import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/admin/crm/availability`, branch by branch.
 *
 * The three answers this route can give are each a promise to a planner, and
 * two of them were shipped unproved:
 *
 *   `leadMissing`  — the URL named a lead we do not have; the screen must ask
 *                    for the request by hand rather than invent one.
 *   `heats`        — FastTrax has no lane grid at all, so `need` is 0 and the
 *                    sections are empty ON PURPOSE (the screen reads the heats
 *                    route instead). A `||` fallback on `need` would put "30
 *                    guests → 5 lanes" over a karting grid.
 *   `unavailable`  — the vendor could not be read. One flat sentence; NOTHING
 *                    of the upstream error (hostname, status, body) may reach
 *                    the body, same rule as `withCrmRoute`'s fixed 500.
 *
 * And the fourth thing pinned here is the clamp: `readLaneGrid` projects the
 * WHOLE ET day, the timeline draws an evening, and an unclamped afternoon block
 * paints outside the track (negative `left`) while also keeping its lane out of
 * the "free all evening" band.
 *
 * The vendor read and the lead read are stubbed; everything from the query
 * string down to the response body is the real module.
 */

const bag = vi.hoisted(() => ({
  session: null as unknown,
  lead: null as unknown,
  grid: null as unknown,
  gridError: null as null | Error,
}));

vi.mock("@/lib/redis", () => ({
  default: { get: () => Promise.resolve(null), set: () => Promise.resolve("OK") },
}));

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(bag.session),
  hasAdminAccess: (s: { roles?: string[] } | null | undefined) => !!s?.roles?.includes("access"),
}));

vi.mock("~/features/crm/reps", () => ({ findRepByLoginEmail: async () => null }));

vi.mock("~/features/crm/availability/data/lead-lookup", () => ({
  findLeadForAvailability: async () => bag.lead,
}));

vi.mock("~/features/crm/availability/service/qamf-grid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/features/crm/availability/service/qamf-grid")>();
  return {
    ...actual,
    readLaneGrid: async () => {
      if (bag.gridError) throw bag.gridError;
      return bag.grid;
    },
  };
});

const { GET } = await import("./route");
const { LANE_SECTIONS } = await import("~/features/crm/availability/pure");

const STATIC = "static-admin-token-for-tests";
const BASE = "http://localhost:3000/api/admin/crm/availability";

function director() {
  return {
    user: { email: "eric@headpinz.com", name: "Eric" },
    roles: ["access", "sales-director"],
    sub: "oid",
    expires: "2026-09-14T00:00:00.000Z",
  };
}

const call = (qs: string) =>
  GET(new NextRequest(`${BASE}?${qs}`, { method: "GET", headers: { "x-admin-token": STATIC } }));

/** Every HPFM lane free all day, unless `busy` says otherwise. */
function grid(busy: Record<number, { kind: string; label: string; start: number; end: number }[]>) {
  const lanes = LANE_SECTIONS.HPFM.flatMap((s) => s.lanes);
  return {
    centre: "HPFM",
    qamfCenterId: 9172,
    date: "2026-10-17",
    lanes,
    occupancy: lanes.map((lane) => ({ lane, blocks: busy[lane] ?? [] })),
    readAt: "2026-10-17T22:00:00.000Z",
    cached: false,
  };
}

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  delete process.env.ADMIN_API_SIGNING_SECRET;
  delete process.env.ADMIN_PROXY_KEY;
  bag.session = director();
  bag.lead = null;
  bag.gridError = null;
  bag.grid = grid({});
});

describe("a lead the CRM does not have", () => {
  it("says so instead of inventing a request", async () => {
    const res = await call("lead=L-9999&centre=HPFM&date=2026-10-17&start=1080&dur=120&guests=60");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.leadMissing).toBe(true);
    expect(body.lead).toBeNull();
    // The query still drives the grid — the screen is usable by hand.
    expect(body.request).toMatchObject({ centre: "HPFM", guests: 60, start: 1080, dur: 120 });
  });

  it("never claims a lead is missing when the URL named none", async () => {
    const body = await (await call("centre=HPFM&date=2026-10-17")).json();
    expect(body.leadMissing).toBe(false);
  });
});

describe("FastTrax", () => {
  it("answers heats, with a lane count of zero rather than a made-up one", async () => {
    const body = await (await call("centre=FT&date=2026-10-17&guests=30")).json();
    expect(body.source).toBe("heats");
    expect(body.need).toBe(0);
    expect(body.sections).toEqual([]);
    expect(body.lanes).toEqual([]);
    expect(body.lanesExpected).toBe(0);
  });
});

describe("a vendor that cannot be read", () => {
  it("says one flat sentence and leaks nothing of the upstream error", async () => {
    bag.gridError = new Error(
      "QAMF 503 api.qubicaamf.com/bowling-reservations/centers/9172/lanes: upstream timeout",
    );
    const res = await call("centre=HPFM&date=2026-10-17&guests=24");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/qubicaamf|503|upstream timeout|9172/);
    const body = JSON.parse(text);
    expect(body.source).toBe("unavailable");
    expect(body.error).toBe(
      "Lane availability could not be read from the centre just now. Try Refresh in a moment.",
    );
    expect(body.fits).toBe(false);
    expect(body.placement).toBeNull();
  });
});

describe("blocks shipped to the timeline", () => {
  const afternoon = [{ kind: "league", label: "Senior Mixed", start: 13 * 60, end: 15 * 60 }];

  it("clamps every bar into the drawn day, so nothing paints off the track", async () => {
    bag.grid = grid({ 13: afternoon, 15: [...afternoon, { ...afternoon[0], end: 17 * 60 }] });
    const body = await (
      await call("centre=HPFM&date=2026-10-17&start=1080&dur=120&guests=24")
    ).json();
    const bounds = body.bounds;
    expect(bounds).toMatchObject({ openMin: 16 * 60, closeMin: 22 * 60 });
    for (const row of body.lanes) {
      for (const block of row.blocks) {
        expect(block.start).toBeGreaterThanOrEqual(bounds.openMin);
        expect(block.end).toBeLessThanOrEqual(bounds.closeMin);
      }
    }
    // Lane 15's block runs 1-5 PM, so an hour of it survives inside the day.
    const lane15 = body.lanes.find((r: { lane: number }) => r.lane === 15);
    expect(lane15.blocks).toEqual([
      { kind: "league", label: "Senior Mixed", start: 16 * 60, end: 17 * 60 },
    ]);
  });

  it("lets a lane busy only in the afternoon collapse into the free band", async () => {
    bag.grid = grid({ 13: afternoon });
    const body = await (
      await call("centre=HPFM&date=2026-10-17&start=1080&dur=120&guests=24")
    ).json();
    const lane13 = body.lanes.find((r: { lane: number }) => r.lane === 13);
    expect(lane13.blocks).toEqual([]);
    // …and the engine, which keeps the UNCLAMPED map, still counts it free for
    // an evening request.
    expect(body.fits).toBe(true);
  });
});

describe("lanes the centre did not report", () => {
  it("counts them as unavailable and says how many are missing", async () => {
    const full = grid({});
    const missing = new Set([13, 14, 15, 16]);
    bag.grid = {
      ...full,
      lanes: full.lanes.filter((l: number) => !missing.has(l)),
      occupancy: full.occupancy.filter((r: { lane: number }) => !missing.has(r.lane)),
    };
    const body = await (
      await call("centre=HPFM&date=2026-10-17&start=1080&dur=120&guests=120")
    ).json();
    expect(body.lanesExpected).toBe(28);
    expect(body.lanesReported).toBe(24);
    const regular = body.sections.find((s: { name: string }) => s.name === "Regular");
    expect(regular.runs.flat()).not.toContain(13);
    expect(regular.free).toBe(12);
  });
});
