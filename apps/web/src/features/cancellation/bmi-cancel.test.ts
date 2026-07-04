/**
 * cancelBmiProject: public-delete short-circuit, W-number search resolution
 * (with 17-digit id precision), already--4 short-circuit, number-mismatch
 * candidate rejection, and verify-after semantics. The Office API (Node
 * https) is mocked with a route table; the public API rides the fetch stub.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable Office route table: first entry whose key is a substring of the
// request path wins.
const officeRoutes: Array<{ match: string; status: number; body: () => string }> = [];

vi.mock("https", () => {
  function respond(path: string, cb?: (res: unknown) => void) {
    const route = officeRoutes.find((r) => path.includes(r.match));
    const status = route?.status ?? 404;
    const body = route ? route.body() : "{}";
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = status;
    queueMicrotask(() => {
      cb?.(res);
      queueMicrotask(() => {
        res.emit("data", body);
        res.emit("end");
      });
    });
    return res;
  }
  function mkReq() {
    return Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    });
  }
  const api = {
    get: (opts: { path: string }, cb: (res: unknown) => void) => {
      respond(opts.path, cb);
      return mkReq();
    },
    request: (opts: { path: string }, cb: (res: unknown) => void) => {
      respond(opts.path, cb);
      return mkReq();
    },
  };
  return { default: api, ...api };
});

vi.mock("@/lib/bmi-office-actions", () => ({ setProjectState: vi.fn(async () => {}) }));

import { setProjectState } from "@/lib/bmi-office-actions";
import { cancelBmiProject } from "./bmi-cancel";

const BILL = "63000000004093398";
const PROJECT = "63000000004093399"; // billId + 1 — 17 digits, precision-sensitive
const W = "W46405";

/** Public-booking fetch stub: auth + DELETE bill/cancel. */
function mockPublic(deleteResult: "true" | "false" | "error") {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/auth/")) {
      return new Response(JSON.stringify({ AccessToken: "pt", ExpiresIn: "3600" }), {
        status: 200,
      });
    }
    if (url.includes("/bill/") && init?.method === "DELETE") {
      if (deleteResult === "error") return new Response("boom", { status: 500 });
      return new Response(deleteResult, { status: 200 });
    }
    throw new Error(`unmocked public BMI call: ${url}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

/** Standard Office world: auth + search + a project that flips to -4 when setProjectState runs. */
function mockOffice(opts: { stateId?: string; searchHit?: boolean; number?: string } = {}) {
  const state = { stateId: opts.stateId ?? "-3", userUpdatedId: "17750" };
  officeRoutes.length = 0;
  officeRoutes.push({
    match: "/auth/token",
    status: 200,
    body: () => JSON.stringify({ access_token: "ot", expires_in: "86400" }),
  });
  officeRoutes.push({
    match: "/search?token=",
    status: 200,
    body: () =>
      JSON.stringify(
        opts.searchHit === false
          ? []
          : [
              { kind: 1, localId: 12345 },
              { kind: 2, localId: PROJECT }, // raw string in mock; real API sends a bare 17-digit number — parseWithRawIds covers both
            ],
      ),
  });
  officeRoutes.push({
    match: `/project/${PROJECT}`,
    status: 200,
    body: () =>
      JSON.stringify({
        stateId: state.stateId,
        userUpdatedId: state.userUpdatedId,
        number: opts.number ?? W,
      }),
  });
  vi.mocked(setProjectState).mockImplementation(async (p) => {
    state.stateId = p.stateId;
    state.userUpdatedId = "17750"; // API2's user — never -1
  });
  return state;
}

const params = {
  pandoraStateSlug: "fasttrax",
  bmiClientKey: "headpinzftmyers",
  bmiBillId: BILL,
  bmiReservationNumber: W,
};

beforeEach(() => {
  officeRoutes.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cancelBmiProject", () => {
  it("public delete true → done, Office never consulted", async () => {
    mockPublic("true");
    const r = await cancelBmiProject(params);
    expect(r).toMatchObject({ ok: true, method: "public_delete" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("confirmed bill: resolves via W-number search, writes -4, verifies", async () => {
    mockPublic("false");
    mockOffice();
    const r = await cancelBmiProject(params);
    expect(r).toMatchObject({
      ok: true,
      method: "office_state",
      projectId: PROJECT, // full 17-digit precision preserved
      verifiedStateId: "-4",
    });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ centerCode: "fasttrax", projectId: PROJECT, stateId: "-4" }),
    );
    expect(r.userUpdatedId).not.toBe("-1");
  });

  it("already at -4 → success without writing", async () => {
    mockPublic("false");
    mockOffice({ stateId: "-4" });
    const r = await cancelBmiProject(params);
    expect(r).toMatchObject({ ok: true, method: "already_cancelled", verifiedStateId: "-4" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("search miss → falls back to the order id when its project number matches", async () => {
    mockPublic("false");
    const state = mockOffice({ searchHit: false });
    // project also resolvable at the ORDER id (attraction-cancel prior art)
    officeRoutes.push({
      match: `/project/${BILL}`,
      status: 200,
      body: () =>
        JSON.stringify({ stateId: state.stateId, userUpdatedId: state.userUpdatedId, number: W }),
    });
    const r = await cancelBmiProject(params);
    expect(r.ok).toBe(true);
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: BILL }),
    );
  });

  it("rejects a candidate whose W-number does not match, then reports unresolved", async () => {
    mockPublic("false");
    mockOffice({ searchHit: false });
    officeRoutes.push({
      match: `/project/${BILL}`,
      status: 200,
      body: () => JSON.stringify({ stateId: "-3", userUpdatedId: "5", number: "W99999" }),
    });
    const r = await cancelBmiProject(params);
    expect(r).toMatchObject({ ok: false, method: "unresolved" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("verify failure (state write did not stick) → ok:false with detail", async () => {
    mockPublic("false");
    mockOffice();
    vi.mocked(setProjectState).mockImplementation(async () => {
      /* write silently lost */
    });
    const r = await cancelBmiProject(params);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/did not stick/);
  });

  it("public delete hard error is non-fatal — Office path still runs", async () => {
    mockPublic("error");
    mockOffice();
    const r = await cancelBmiProject(params);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("office_state");
  });
});
