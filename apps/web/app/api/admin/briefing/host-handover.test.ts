import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * THE WHOLE HAND-OVER, THROUGH THE REAL ROUTE — the night staff described.
 *
 * Ada pulls a group in, Grace runs them. Every press Grace makes used to be
 * silently filed under Ada, and the pit board named Ada until closing. This
 * walks that exact sequence and then the fix: pull as Ada → start as Ada →
 * start as Grace → the response says so → hand over → the key, the assignment
 * rows and the event log all agree it is Grace's group.
 *
 * WHAT IS REAL HERE, deliberately: the route, the briefing service, session-host
 * (the NX and its two new doors), the pure attribution and release rules, the
 * phase timeline, and the Redis room state — driven by an in-memory store, so
 * first-press-wins is exercised rather than asserted. Only the leaves are
 * mocked: Neon, the asset manifest, the room camera and the NVR.
 */

const redis = vi.hoisted(() => {
  const strings = new Map<string, string>();
  return {
    __strings: strings,
    get: vi.fn(async (k: string) => strings.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...rest: unknown[]) => {
      if (rest.includes("NX") && strings.has(k)) return null;
      strings.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (strings.delete(k)) n += 1;
      return n;
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => strings.get(k) ?? null)),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      strings.set(k, v);
      return "OK";
    }),
    expire: vi.fn(async () => 1),
    keys: vi.fn(async () => [] as string[]),
    ttl: vi.fn(async () => -1),
  };
});

/** Every durable write, captured. Neon is not in this test. */
const db = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  /** sessionId → { userId, firstName } | null, standing in for the rows. */
  assignmentStaff: new Map<string, { userId: number; firstName: string } | null>(),
}));

vi.mock("@/lib/redis", () => ({ default: redis }));
vi.mock("server-only", () => ({}));

// Auth is proved by lib/admin-request-auth's own tests and by the token-leak
// gate; stubbing it here keeps this test about attribution. Nothing in the
// route's auth posture is changed by these cases.
vi.mock("@/lib/admin-request-auth", () => ({ isAdminApiRequest: async () => true }));

const ADA = { userId: 77, punchId: "1111", firstName: "Ada", lastName: "Lovelace" };
const GRACE = { userId: 88, punchId: "2222", firstName: "Grace", lastName: "Hopper" };
const byPunch: Record<string, typeof ADA> = { "1111": ADA, "2222": GRACE };

vi.mock("~/features/staff/service", () => ({
  verifyPunchId: vi.fn(async (punchId: string) => {
    const staff = byPunch[punchId];
    return staff
      ? { ok: true as const, staff, stale: false }
      : { ok: false as const, reason: "unknown" };
  }),
}));

vi.mock("~/features/signage/briefing/assignments-db", () => ({
  recordBriefingAssignment: vi.fn(
    async (args: {
      sessionId: string;
      staffUserId?: number | null;
      staffFirstName?: string | null;
    }) => {
      db.assignmentStaff.set(
        args.sessionId,
        args.staffUserId != null && args.staffFirstName
          ? { userId: args.staffUserId, firstName: args.staffFirstName }
          : null,
      );
    },
  ),
  // FIRST CLAIM WINS on the row too — the real one is `WHERE staff_user_id IS NULL`.
  backfillAssignmentStaff: vi.fn(async (sessionId: string, userId: number, firstName: string) => {
    if (!db.assignmentStaff.get(sessionId))
      db.assignmentStaff.set(sessionId, { userId, firstName });
  }),
  // The hand-over's write: no IS NULL guard, every row of the session.
  setAssignmentStaff: vi.fn(async (sessionId: string, userId: number, firstName: string) => {
    db.assignmentStaff.set(sessionId, { userId, firstName });
    return [
      {
        id: "1",
        venue: "FT",
        businessDay: "2026-09-07",
        room: "red" as const,
        track: "red",
        sessionId,
        heatNumber: 60,
        raceType: "Intermediate",
        tier: "intermediate" as const,
        mode: "timeline",
        sentAt: "2026-09-07T22:00:00.000Z",
        staffUserId: userId,
        staffFirstName: firstName,
      },
    ];
  }),
  listBriefingAssignments: vi.fn(async () => []),
}));

vi.mock("~/features/signage/briefing/events-db", () => ({
  recordBriefingEvent: vi.fn(async (args: Record<string, unknown>) => {
    db.events.push(args);
  }),
  listBriefingEvents: vi.fn(async () => []),
}));

vi.mock("~/features/signage/data/signage-assets-db", () => ({
  loadSignageAssetsSafe: vi.fn(async () => ({
    "briefing.video.intermediate": { url: "https://blob/film.mp4", durationMs: 120_000 },
  })),
  saveSignageAsset: vi.fn(),
  deleteSignageAsset: vi.fn(),
}));

vi.mock("~/features/signage/briefing/room-photo.server", () => ({
  captureRoomPhoto: vi.fn(async () => null),
}));
vi.mock("~/features/signage/briefing/bookmarks.server", () => ({
  bookmarkBriefingStartAfter: vi.fn(),
}));
vi.mock("~/features/signage/service/checkin-progress", () => ({
  calledAtMsFor: vi.fn(async () => null),
  sessionCheckinTimes: vi.fn(async () => null),
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));

import { POST } from "./route";
import { readSessionHost } from "~/features/staff/session-host";

const SESSION = "60";

interface Body {
  ok?: boolean;
  error?: string;
  host?: { userId: number; firstName: string } | null;
  acting?: { userId: number; firstName: string } | null;
  hostConflict?: boolean;
}

async function post(body: Record<string, unknown>): Promise<{ status: number; json: Body }> {
  const req = new NextRequest("https://x/api/admin/briefing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Body };
}

const pull = (punchId?: string) =>
  post({
    action: "send",
    room: "red",
    track: "red",
    sessionId: SESSION,
    heatNumber: 60,
    raceType: "Intermediate",
    punchId,
  });
const start = (punchId?: string) => post({ action: "start", room: "red", punchId });
const restart = (punchId?: string) => post({ action: "restart", room: "red", punchId });
const clear = () => post({ action: "clear", room: "red" });

beforeEach(() => {
  redis.__strings.clear();
  db.events.length = 0;
  db.assignmentStaff.clear();
  vi.clearAllMocks();
});

describe("the night that was reported", () => {
  it("tells Grace the group is Ada's, and hands it over when she says so", async () => {
    // Ada pulls the group into the red room and rolls the film.
    expect((await pull(ADA.punchId)).json.host).toMatchObject({ userId: 77, firstName: "Ada" });
    expect((await start(ADA.punchId)).json.hostConflict).toBe(false);

    // Grace — who is actually running this group — presses Start. The claim
    // still defers (first press wins), and NOW she is told.
    const grace = await start(GRACE.punchId);
    expect(grace.status).toBe(200);
    expect(grace.json.hostConflict).toBe(true);
    expect(grace.json.host).toMatchObject({ userId: 77, firstName: "Ada" });
    expect(grace.json.acting).toEqual({ userId: 88, firstName: "Grace" });
    // Nothing moved on a press alone.
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77 });

    // She answers the modal.
    const handed = await post({
      action: "reassign-host",
      sessionId: SESSION,
      punchId: GRACE.punchId,
    });
    expect(handed.status).toBe(200);
    expect(handed.json).toMatchObject({ ok: true, hostConflict: false });
    expect(handed.json.host).toMatchObject({ userId: 88, firstName: "Grace" });

    // All three records agree.
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 88, firstName: "Grace" });
    expect(db.assignmentStaff.get(SESSION)).toEqual({ userId: 88, firstName: "Grace" });
    const handover = db.events.find((e) => e.action === "host-changed");
    expect(handover).toMatchObject({ sessionId: SESSION, reason: "Ada → Grace" });

    // And her next press is unremarkable.
    expect((await start(GRACE.punchId)).json.hostConflict).toBe(false);
  });

  it("says nothing when the group is unclaimed — the ordinary press", async () => {
    const first = await pull(ADA.punchId);
    expect(first.json.hostConflict).toBe(false);
    expect(first.json.host).toMatchObject({ firstName: "Ada" });
  });

  it("never raises the question on Play it again, and never claims from it", async () => {
    await pull(ADA.punchId);
    await start(ADA.punchId);

    const again = await restart(GRACE.punchId);
    expect(again.status).toBe(200);
    // The names travel for the receipt…
    expect(again.json.host).toMatchObject({ firstName: "Ada" });
    expect(again.json.acting).toEqual({ userId: 88, firstName: "Grace" });
    // …but the question is not put, and nothing was taken.
    expect(again.json.hostConflict).toBe(false);
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77 });
  });

  it("refuses a hand-over it cannot put a name to", async () => {
    await pull(ADA.punchId);
    const res = await post({ action: "reassign-host", sessionId: SESSION, punchId: "9999" });
    expect(res.status).toBe(400);
    // The standing attribution is untouched — a hand-over with nobody to hand
    // to must never blank the host.
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77 });
  });

  it("refuses a hand-over with no session", async () => {
    expect((await post({ action: "reassign-host", punchId: GRACE.punchId })).status).toBe(400);
  });
});

describe("a group pulled into the wrong room", () => {
  it("gives the host back when Undo lands before the film", async () => {
    await pull(ADA.punchId);
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77 });

    await clear();
    expect(await readSessionHost(SESSION)).toBeNull();

    // Which is the whole point: the person who actually briefs them claims it.
    await pull(GRACE.punchId);
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 88, firstName: "Grace" });
  });

  it("KEEPS the host when the film has already rolled", async () => {
    await pull(ADA.punchId);
    await start(ADA.punchId);

    await clear();
    // Ada briefed this group. Clearing the room does not unmake that.
    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77, firstName: "Ada" });
  });

  it("gives the host back when another group replaces them before the film", async () => {
    await pull(ADA.punchId);

    await post({
      action: "send",
      room: "red",
      track: "red",
      sessionId: "61",
      heatNumber: 61,
      raceType: "Intermediate",
      punchId: GRACE.punchId,
    });

    expect(await readSessionHost(SESSION)).toBeNull();
    expect(await readSessionHost("61")).toMatchObject({ userId: 88 });
  });

  it("KEEPS a briefed group's host when they are replaced", async () => {
    await pull(ADA.punchId);
    await start(ADA.punchId);

    await post({
      action: "send",
      room: "red",
      track: "red",
      sessionId: "61",
      heatNumber: 61,
      raceType: "Intermediate",
      punchId: GRACE.punchId,
    });

    expect(await readSessionHost(SESSION)).toMatchObject({ userId: 77, firstName: "Ada" });
  });
});
