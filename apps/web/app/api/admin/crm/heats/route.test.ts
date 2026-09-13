import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/admin/crm/heats` — the karting side of the same question.
 *
 * The branch that matters most here is the one the panel used to throw away: an
 * Office outage answers `source:"unavailable"` with a sentence of its own, and
 * a planner must not be told "no heats are published for this day yet" when the
 * truth is that we could not reach the centre. `HeatsPanel` now branches on
 * exactly these two fields (`heatsPanelState`), so they are pinned here.
 */

const bag = vi.hoisted(() => ({
  session: null as unknown,
  lead: null as unknown,
  heats: null as unknown,
  heatsError: null as null | Error,
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

vi.mock("~/features/crm/availability/service/heats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/features/crm/availability/service/heats")>();
  return {
    ...actual,
    readHeats: async () => {
      if (bag.heatsError) throw bag.heatsError;
      return bag.heats;
    },
  };
});

const { GET } = await import("./route");

const STATIC = "static-admin-token-for-tests";
const BASE = "http://localhost:3000/api/admin/crm/heats";

const call = (qs: string) =>
  GET(new NextRequest(`${BASE}?${qs}`, { method: "GET", headers: { "x-admin-token": STATIC } }));

const BLOCK = (start: number, freePlaces: number) => ({
  start,
  stop: start + 12,
  label: "4:12 PM",
  capacity: 14,
  freePlaces,
  bookedSpots: 14 - freePlaces,
  description: "Blue Track",
});

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  delete process.env.ADMIN_API_SIGNING_SECRET;
  delete process.env.ADMIN_PROXY_KEY;
  bag.session = {
    user: { email: "kelsea@headpinz.com", name: "Kelsea Kosco" },
    roles: ["access", "sales"],
    sub: "oid",
    expires: "2026-09-14T00:00:00.000Z",
  };
  bag.lead = null;
  bag.heatsError = null;
  bag.heats = {
    centre: "FT",
    clientKey: "headpinzftmyers",
    locationId: 467486,
    date: "2026-10-17",
    resources: [
      {
        resourceId: "63000000001234567",
        resourceName: "Blue Track",
        capacity: 14,
        isTrack: true,
        blocks: [BLOCK(16 * 60, 14), BLOCK(16 * 60 + 12, 14), BLOCK(16 * 60 + 24, 2)],
      },
    ],
    readAt: "2026-10-17T20:00:00.000Z",
    cached: false,
  };
});

describe("a day planner that was read", () => {
  it("answers the track, the heats needed and the first run with room", async () => {
    const body = await (await call("centre=FT&date=2026-10-17&guests=20")).json();
    expect(body.source).toBe("heats");
    expect(body.selectedResourceId).toBe("63000000001234567");
    expect(body.heatsNeeded).toBe(2);
    expect(body.firstRun).toHaveLength(2);
    // The resource id is a 17-digit Office id and stays a STRING end to end.
    expect(typeof body.resources[0].resourceId).toBe("string");
    expect(body.resources[0].resourceId).toBe("63000000001234567");
  });
});

describe("an Office outage", () => {
  it("is reported as an outage, not as an empty day planner", async () => {
    bag.heatsError = new Error("Office 500 headpinzftmyers dayPlanner: Value cannot be null.");
    const res = await call("centre=FT&date=2026-10-17&guests=20");
    const text = await res.text();
    // `clientKey` is ours and belongs in the body; the upstream error does not.
    expect(text).not.toMatch(/dayPlanner|cannot be null|Office 500/);
    const body = JSON.parse(text);
    expect(body.source).toBe("unavailable");
    expect(body.error).toBe(
      "Heat availability could not be read from the centre just now. Try Refresh in a moment.",
    );
    expect(body.resources).toEqual([]);
    expect(body.heatsNeeded).toBe(0);
  });
});

describe("a lead the CRM does not have", () => {
  it("says so rather than seeding the request from nothing", async () => {
    const body = await (await call("lead=L-9999&centre=FT&date=2026-10-17&guests=20")).json();
    expect(body.leadMissing).toBe(true);
    expect(body.lead).toBeNull();
  });
});
