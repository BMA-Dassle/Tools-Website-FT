import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

/**
 * setProjectState must never report success for a CUSTOM state id it cannot
 * prove landed — and for those ids it uses the OFFICE RAIL ONLY.
 *
 * This is the 2026-08-03 resend loop in unit form: BMI Office 403'd writes while
 * reads stayed healthy, so every send fell back to Pandora — which returns 200
 * and silently no-ops custom state ids. setProjectState resolved anyway, the
 * dispatch cron treated that as its loop-breaker, emailed the guest, and repeated
 * on the next pass (~88 duplicate contract emails to 4 guests).
 *
 * Two things changed on 2026-08-12:
 *   • those 403s are a CAPACITY refusal that `confirm:true` overrides — so an
 *     overbooked group function can leave "Send Contract" at all. Our service
 *     account gets the flat "overbooking is not allowed" form rather than the
 *     "Do you want to overbook?" question a staff login gets; the same flag
 *     clears both, and no account-level setting is involved;
 *   • the Pandora fallback is GONE for custom ids (owner: "never fall back to
 *     pandora, just leave them in Send Contract"). It could only no-op or lie.
 *
 * The decision table under test, for a custom (non-negative) state id:
 *
 *   office PUT          | verify read  | outcome
 *   --------------------|--------------|------------------------------------
 *   200                 | == target    | resolve
 *   200                 | != target    | THROW
 *   200                 | unreadable   | resolve (Office PUT is the proven path)
 *   403 + prompt        | == target    | resolve — confirm:true, one retry
 *   403 + prompt        | (still 403)  | THROW   — never loops
 *   403 plain / 5xx     | any          | THROW   — no Pandora, stays in Send Contract
 */

const CUSTOM_STATE = "48952154"; // Pending Signed Contract — a custom id
const PROJECT_ID = "57575682";

/** Scripted Office responses, consumed per request in order of matcher. */
type OfficeHandler = (
  method: string,
  path: string,
  body: string,
) => { status: number; body: string };

const state = vi.hoisted(() => ({
  officeHandler: null as unknown,
  pandoraOk: true,
  pandoraCalls: 0,
  /** Every PUT /project body seen, in order — the confirm-retry is a body assertion. */
  putBodies: [] as string[],
}));

vi.mock("https", () => ({
  default: {
    request: (
      opts: { method: string; path: string },
      cb: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      let sent = "";
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => void;
        end: () => void;
        setTimeout: () => void;
        destroy: () => void;
      };
      req.write = (chunk: string) => {
        sent += chunk;
      };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        if (opts.method === "PUT" && opts.path.endsWith("/project")) state.putBodies.push(sent);
        const handler = state.officeHandler as OfficeHandler;
        const { status, body } = handler(opts.method, opts.path, sent);
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

/**
 * The token cache (lib/bmi-office-token.ts) reads Redis before minting. Stub it
 * so the suite never opens a socket; a real ioredis here would retry against
 * localhost on every test.
 */
vi.mock("@/lib/redis", () => {
  const store = new Map<string, string>();
  return {
    default: {
      get: async (k: string) => store.get(k) ?? null,
      setex: async (k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return "OK";
      },
      del: async (k: string) => (store.delete(k) ? 1 : 0),
    },
  };
});

const { setProjectState } = await import("../bmi-office-actions");
const { __resetOfficeTokenCacheForTests } = await import("../bmi-office-token");

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

/**
 * The two 403 envelopes BMI returns for the SAME over-capacity condition,
 * measured on project 58454076 (2026-08-12). Which one you get depends on the
 * login; `confirm:true` overrides both.
 */
const OVERBOOK_QUESTION = {
  IsQuestion: true,
  Kind: 4,
  Message:
    "Total persons (12) is higher than the capacity (0) in HP Arena: " +
    "8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM. \n Do you want to overbook?",
  OperationId: "24f41237f82a44f3d6b6bee528598f8b",
};
/** What our API2 service account actually gets — reads final, is not. */
const OVERBOOK_REFUSAL = {
  IsQuestion: false,
  Kind: 4,
  Message:
    "Total persons (12) is higher than the capacity (0) in HP Arena: " +
    "8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM, overbooking is not allowed.",
  OperationId: "8389cf8a268af9b19134286e9ae39f06",
};

/**
 * An Office that refuses the first `asks` project PUTs with a soft-refusal
 * envelope, then accepts.
 *
 * @param asks       how many PUTs are refused before one is accepted
 * @param readsState what a subsequent GET reports as stateId
 * @param envelope   which 403 body to send (defaults to the one WE get)
 */
function officeAsking(
  asks: number,
  readsState: string,
  envelope: object = OVERBOOK_REFUSAL,
): OfficeHandler {
  let seen = 0;
  return (method, path) => {
    if (path === "/auth/token") {
      return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
    }
    if (method === "GET" && path.includes(`/project/${PROJECT_ID}`)) {
      return {
        status: 200,
        // `confirm` is part of the real project entity and starts false — it is
        // the field the retry flips, so the fixture has to carry it.
        body: JSON.stringify({
          id: PROJECT_ID,
          confirm: false,
          persons: 12,
          number: "H3248",
          stateId: seen === 0 ? "49130082" : readsState,
        }),
      };
    }
    if (method === "PUT" && path.endsWith("/project")) {
      if (seen++ < asks) return { status: 403, body: JSON.stringify(envelope) };
      return { status: 200, body: "{}" };
    }
    return { status: 404, body: "{}" };
  };
}

beforeEach(() => {
  // These used to come from literal defaults in lib/bmi-office-actions.ts, so
  // this suite was implicitly authenticating with the real service password.
  // Credentials are env-only now (lib/bmi-office-token.ts) — supply fakes, and
  // clear the cached grant so each test mints through the mocked https.
  process.env.BMI_OFFICE_USERNAME = "test-user";
  process.env.BMI_OFFICE_PASSWORD = "test-pass";
  delete process.env.BMI_OFFICE_PASSWORD_B64;
  __resetOfficeTokenCacheForTests();
  state.pandoraOk = true;
  state.pandoraCalls = 0;
  state.putBodies = [];
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

  it("THROWS on a blocked Office write and NEVER touches Pandora — the 2026-08-03 loop", async () => {
    // The read even reports the target state, so the old code's Pandora fallback
    // would have called this a success. It is not one: nothing wrote it.
    state.officeHandler = office(403, CUSTOM_STATE);
    await expect(call()).rejects.toThrow(/Failed to update project status: 403/);
    expect(state.pandoraCalls).toBe(0);
  });

  it("THROWS on a 5xx Office write — the project stays in Send Contract", async () => {
    state.officeHandler = office(500, CUSTOM_STATE);
    await expect(call()).rejects.toThrow(/Failed to update project status: 500/);
    expect(state.pandoraCalls).toBe(0);
  });

  it('confirms through "overbooking is not allowed" — the refusal WE actually get', async () => {
    // The 2026-08-12 failure: an overbooked group function could not leave "Send
    // Contract" because the state PUT 403'd and the old code read that as fatal.
    // Our service account is never offered the dialog — it gets a flat refusal —
    // but `confirm:true` overrides it just the same (verified live on API2).
    state.officeHandler = officeAsking(1, CUSTOM_STATE, OVERBOOK_REFUSAL);
    await expect(call()).resolves.toBeUndefined();
    expect(state.pandoraCalls).toBe(0); // handled on the Office rail — no fallback
    expect(state.putBodies).toHaveLength(2);
    expect(JSON.parse(state.putBodies[0]).confirm).toBe(false);
    expect(JSON.parse(state.putBodies[1]).confirm).toBe(true);
    // The retry differs from the refused body ONLY in `confirm` — the Office UI's
    // own retry is byte-identical apart from that one field (HAR 2026-08-12).
    expect({ ...JSON.parse(state.putBodies[1]), confirm: false }).toEqual(
      JSON.parse(state.putBodies[0]),
    );
  });

  it("confirms through the QUESTION form a staff login gets, too", async () => {
    state.officeHandler = officeAsking(1, CUSTOM_STATE, OVERBOOK_QUESTION);
    await expect(call()).resolves.toBeUndefined();
    expect(state.putBodies).toHaveLength(2);
    expect(JSON.parse(state.putBodies[1]).confirm).toBe(true);
  });

  it("confirms ONCE — a refusal that survives confirm:true throws, never loops", async () => {
    state.officeHandler = officeAsking(Infinity, CUSTOM_STATE);
    await expect(call()).rejects.toThrow(/still refused after confirm:true/);
    expect(state.putBodies).toHaveLength(2);
  });

  it("does not confirm a 403 with no prompt envelope — that is a genuine block", async () => {
    state.officeHandler = office(403, CUSTOM_STATE); // body "forbidden", not JSON
    await expect(call()).rejects.toThrow(/403/);
    expect(state.putBodies).toHaveLength(1); // never retried with confirm:true
  });

  it("re-reads more than once, so an async propagation still counts as landed", async () => {
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
      if (method === "PUT") return { status: 200, body: "{}" };
      return { status: 404, body: "{}" };
    }) as OfficeHandler;
    await expect(call()).resolves.toBeUndefined();
  });
});
