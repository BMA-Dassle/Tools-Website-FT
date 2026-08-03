import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

/**
 * setProjectState must never report success for a CUSTOM state id it cannot
 * prove landed.
 *
 * This is the 2026-08-03 resend loop in unit form: BMI Office 403'd writes while
 * reads stayed healthy, so every send fell back to Pandora — which returns 200
 * and silently no-ops custom state ids. setProjectState resolved anyway, the
 * dispatch cron treated that as its loop-breaker, emailed the guest, and repeated
 * on the next pass (~88 duplicate contract emails to 4 guests).
 *
 * The decision table under test, for a custom (non-negative) state id:
 *
 *   write path | verify read      | outcome
 *   -----------|------------------|---------------------------------
 *   office     | == target        | resolve
 *   office     | != target        | THROW
 *   office     | unreadable       | resolve  (Office PUT is the proven path)
 *   pandora    | == target        | resolve
 *   pandora    | != target        | THROW    (the incident)
 *   pandora    | unreadable       | THROW    (Pandora lies about these)
 *   pandora    | (write rejected) | THROW
 */

const CUSTOM_STATE = "48952154"; // Pending Signed Contract — a custom id
const PROJECT_ID = "57575682";

/** Scripted Office responses, consumed per request in order of matcher. */
type OfficeHandler = (method: string, path: string) => { status: number; body: string };

const state = vi.hoisted(() => ({
  officeHandler: null as unknown,
  pandoraOk: true,
  pandoraCalls: 0,
}));

vi.mock("https", () => ({
  default: {
    request: (
      opts: { method: string; path: string },
      cb: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        write: () => void;
        end: () => void;
        setTimeout: () => void;
        destroy: () => void;
      };
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const handler = state.officeHandler as OfficeHandler;
        const { status, body } = handler(opts.method, opts.path);
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = status;
        setImmediate(() => {
          cb(res);
          res.emit("data", body);
          res.emit("end");
        });
      };
      return req;
    },
  },
}));

const { setProjectState } = await import("../bmi-office-actions");

/**
 * Build an Office handler.
 * @param putStatus  status for PUT /project (403 forces the Pandora fallback)
 * @param readsState what a subsequent GET /project/<id> reports as stateId;
 *                   null => the read itself fails (500)
 */
function office(putStatus: number, readsState: string | null): OfficeHandler {
  return (method, path) => {
    if (path === "/auth/token") {
      return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
    }
    if (method === "GET" && path.includes(`/project/${PROJECT_ID}`)) {
      if (readsState === null) return { status: 500, body: "boom" };
      return {
        status: 200,
        body: JSON.stringify({ id: PROJECT_ID, number: "H3248", stateId: readsState }),
      };
    }
    if (method === "PUT" && path.endsWith("/project")) {
      return { status: putStatus, body: putStatus >= 400 ? "forbidden" : "{}" };
    }
    return { status: 404, body: "{}" };
  };
}

beforeEach(() => {
  state.pandoraOk = true;
  state.pandoraCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      state.pandoraCalls++;
      return { ok: state.pandoraOk } as Response;
    }),
  );
});

/** confirmGapMs: 0 keeps the retry loop instant. */
const call = () =>
  setProjectState({
    centerCode: "fort-myers",
    projectId: PROJECT_ID,
    stateId: CUSTOM_STATE,
    label: "Pending Signed Contract",
    confirmGapMs: 0,
  });

describe("setProjectState — custom state id must be proven, not assumed", () => {
  it("resolves when the Office PUT lands and the read confirms it", async () => {
    state.officeHandler = office(200, CUSTOM_STATE);
    await expect(call()).resolves.toBeUndefined();
    expect(state.pandoraCalls).toBe(0); // Office-first: no fallback needed
  });

  it("THROWS when the Office PUT 200s but the project still reads the old state", async () => {
    state.officeHandler = office(200, "49130082"); // still Send Contract
    await expect(call()).rejects.toThrow(/treating as NOT landed/);
  });

  it("trusts the Office PUT when reads die between the write and the verify", async () => {
    // Note the shape: viaOfficeApi does GET-then-PUT, so an Office write can only
    // happen while reads are healthy. This branch is reachable ONLY when reads fail
    // after the PUT — hence the first GET succeeds and every later one 500s.
    let gets = 0;
    state.officeHandler = ((method: string, path: string) => {
      if (path === "/auth/token")
        return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
      if (method === "GET" && path.includes(`/project/${PROJECT_ID}`)) {
        gets++;
        return gets === 1
          ? { status: 200, body: JSON.stringify({ id: PROJECT_ID, stateId: "49130082" }) }
          : { status: 500, body: "boom" };
      }
      if (method === "PUT") return { status: 200, body: "{}" };
      return { status: 404, body: "{}" };
    }) as OfficeHandler;
    await expect(call()).resolves.toBeUndefined();
    expect(state.pandoraCalls).toBe(0);
  });

  it("resolves when the Pandora fallback lands and the read confirms it", async () => {
    state.officeHandler = office(403, CUSTOM_STATE);
    await expect(call()).resolves.toBeUndefined();
    expect(state.pandoraCalls).toBe(1);
  });

  it("THROWS when Pandora reports success but the state never moved — the 2026-08-03 loop", async () => {
    state.officeHandler = office(403, "49130082"); // Pandora 200s, no-ops, still Send Contract
    await expect(call()).rejects.toThrow(/written via pandora/);
    expect(state.pandoraCalls).toBe(1);
  });

  it("THROWS on a Pandora write it cannot verify — silence is not success for custom ids", async () => {
    state.officeHandler = office(403, null);
    await expect(call()).rejects.toThrow(/unreadable/);
  });

  it("THROWS when both write paths fail", async () => {
    state.officeHandler = office(403, CUSTOM_STATE);
    state.pandoraOk = false;
    await expect(call()).rejects.toThrow(/failed on both paths/);
  });

  it("re-reads more than once, so an async Pandora propagation still counts as landed", async () => {
    let reads = 0;
    state.officeHandler = ((method: string, path: string) => {
      if (path === "/auth/token")
        return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
      if (method === "GET" && path.includes(`/project/${PROJECT_ID}`)) {
        reads++;
        // Lands only on the 3rd read — mirrors Firebird propagation lag.
        return {
          status: 200,
          body: JSON.stringify({ stateId: reads >= 3 ? CUSTOM_STATE : "49130082" }),
        };
      }
      if (method === "PUT") return { status: 403, body: "forbidden" };
      return { status: 404, body: "{}" };
    }) as OfficeHandler;
    await expect(call()).resolves.toBeUndefined();
  });
});
