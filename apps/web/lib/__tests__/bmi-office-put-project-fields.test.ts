import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * `putProjectFields` — the CRM's ONE project-field writer (brief R5) — drives
 * the SAME private `putProject` the other rails use, and proves it:
 *
 *   • GET (raw ids) → minimal payload + patch → PUT → GET verify: three Office
 *     calls, the PUT body is the UI's field set plus the patch, never the whole
 *     entity, and 17-digit ids in the read survive as strings.
 *   • a 403 soft-refusal is retried EXACTLY once with `confirm:true` (the
 *     existing protocol), then verified.
 *   • a verify that reads the OLD value throws and there is NO second PUT.
 *   • the per-project Redis lock is taken before the GET and released after.
 *
 * Same wire mock as `bmi-office-set-state.test.ts`: `https.request` is scripted
 * per (method, path); Redis is an in-memory map with SET NX / EVAL.
 */

type OfficeHandler = (
  method: string,
  path: string,
  body: string,
) => { status: number; body: string };

const state = vi.hoisted(() => ({
  officeHandler: null as unknown,
  requests: [] as { method: string; path: string; body: string; sessionId: string }[],
  redis: new Map<string, string>(),
  lockRefused: false,
}));

vi.mock("https", () => ({
  default: {
    Agent: class {
      destroy() {}
    },
    request: (
      opts: { method: string; path: string; headers: Record<string, string> },
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
        state.requests.push({
          method: opts.method,
          path: opts.path,
          body: sent,
          sessionId: opts.headers["x-session-id"],
        });
        const { status, body } = (state.officeHandler as OfficeHandler)(
          opts.method,
          opts.path,
          sent,
        );
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

vi.mock("@/lib/redis", () => ({
  default: {
    get: async (k: string) => state.redis.get(k) ?? null,
    setex: async (k: string, _ttl: number, v: string) => {
      state.redis.set(k, v);
      return "OK";
    },
    del: async (k: string) => (state.redis.delete(k) ? 1 : 0),
    set: async (k: string, v: string, _px: string, _ms: number, nx?: string) => {
      if (state.lockRefused) return null;
      if (nx === "NX" && state.redis.has(k)) return null;
      state.redis.set(k, v);
      return "OK";
    },
    eval: async (_script: string, _n: number, k: string, v: string) => {
      if (state.redis.get(k) === v) {
        state.redis.delete(k);
        return 1;
      }
      return 0;
    },
  },
}));

const {
  CRM_PROJECT_LOCK_PREFIX,
  OfficeProjectLockedError,
  OfficeProjectVerifyError,
  projectPutJson,
  putProjectFields,
  toMinimalProject,
} = await import("../bmi-office-actions");
const { __resetOfficeTokenCacheForTests } = await import("../bmi-office-token");

const PROJECT_ID = "58454076";
const PERSON_ID = "63000000009561437";

/** The project as Office returns it: bare 17-digit ids, the UI's core fields, plus the parts a PUT must never carry. */
const projectText = (userId: string, extra = "") =>
  `{"id":${PROJECT_ID},"number":"H3248","name":"Acme holiday party","displayName":"Acme holiday party",` +
  `"personId":${PERSON_ID},"persons":42,"confirm":false,"balance":0,"stateId":49130082,"kindId":-1,` +
  `"userId":${userId},"userAgentId":${userId},"created":"2026-08-30T14:02:11","updated":"2026-09-10T09:15:40",` +
  `"date":"2026-12-12T18:00:00","publish":true,"companyId":1,"priority":0${extra},` +
  `"bills":[{"id":63000000009561438}],"schedules":[{"id":1}],"products":[{"id":2}],"projectPersons":[{"id":3}],"logs":[]}`;

const OVERBOOK_REFUSAL = {
  IsQuestion: false,
  Kind: 4,
  Message:
    "Total persons (42) is higher than the capacity (0) in Blue Track, overbooking is not allowed.",
  OperationId: "8389cf8a268af9b19134286e9ae39f06",
};

/**
 * @param refusals  how many project PUTs answer with the 403 prompt before a 200
 * @param landed    what the verify GET reports as userId (null = the write silently did not land)
 */
function office(opts: { refusals?: number; landed?: string | null } = {}): OfficeHandler {
  let puts = 0;
  let gets = 0;
  return (method, path) => {
    if (path === "/auth/token") {
      return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
    }
    if (method === "GET" && path.endsWith(`/project/${PROJECT_ID}`)) {
      gets++;
      const after = gets > 1 && puts > 0;
      const userId = after
        ? opts.landed === null
          ? "28267036"
          : (opts.landed ?? "465247")
        : "28267036";
      return { status: 200, body: projectText(userId) };
    }
    if (method === "PUT" && path.endsWith("/project")) {
      puts++;
      if (puts <= (opts.refusals ?? 0))
        return { status: 403, body: JSON.stringify(OVERBOOK_REFUSAL) };
      return { status: 200, body: "{}" };
    }
    return { status: 404, body: "{}" };
  };
}

const puts = () => state.requests.filter((r) => r.method === "PUT");
const gets = () => state.requests.filter((r) => r.method === "GET" && r.path.includes("/project/"));

beforeEach(() => {
  state.requests = [];
  state.redis.clear();
  state.lockRefused = false;
  // The token module refuses to mint with no credentials; these are harness values.
  process.env.BMI_OFFICE_USERNAME = "test-user";
  process.env.BMI_OFFICE_PASSWORD = "test-pass";
  delete process.env.BMI_OFFICE_PASSWORD_B64;
  __resetOfficeTokenCacheForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("putProjectFields", () => {
  it("GET → minimal + patch → PUT → verify GET; the PUT carries the UI's field set, not the entity", async () => {
    state.officeHandler = office({ landed: "465247" });
    const out = await putProjectFields({
      clientKey: "headpinzftmyers",
      projectId: PROJECT_ID,
      patch: { userId: "465247", userAgentId: "465247" },
    });

    expect(out.status).toBe(200);
    expect(gets()).toHaveLength(2);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].path).toBe("/api/headpinzftmyers/project");

    const body = JSON.parse(puts()[0].body) as Record<string, unknown>;
    // EVERY id leaves as a JSON NUMBER — the shape the four pre-CRM callers of
    // putProject have always sent (they build `minimal` from a bare
    // JSON.parse). The CRM reads with parseWithRawIds, so `projectPutJson`
    // undoes the string form on the way out; without it the wire would carry
    // `"userId":"465247"`, a shape no live Office write has ever been proven
    // to accept.
    expect(body.userId).toBe(465247);
    expect(body.userAgentId).toBe(465247);
    expect(body.stateId).toBe(49130082);
    expect(body.confirm).toBe(false);
    expect(puts()[0].body).toContain('"userId":465247');
    expect(puts()[0].body).not.toContain('"userId":"465247"');
    // Never the booking itself.
    for (const k of ["bills", "schedules", "products", "projectPersons", "logs"])
      expect(k in body).toBe(false);
    // The read side kept the 17-digit ids whole (JSON.parse would have rounded them).
    expect(out.project.personId).toBe(PERSON_ID);
    expect((out.project.bills as { id: string }[])[0].id).toBe("63000000009561438");
    // …and the write emits them RAW: full precision, unquoted, exactly as
    // Office sent them. JSON.stringify of the string form, or of a Number,
    // would each be wrong in a different way.
    expect(puts()[0].body).toContain(`"personId":${PERSON_ID}`);
    expect(puts()[0].body).not.toContain(`"personId":"${PERSON_ID}"`);
    expect(puts()[0].body).toContain(`"id":${PROJECT_ID}`);
    expect(puts()[0].body).not.toContain("63000000009561440");
  });

  describe("projectPutJson — the string form the CRM reads in is undone on the way out", () => {
    it("small ids become numbers, 17-digit ids are injected raw, and a SIGNED state id is not left quoted", () => {
      const json = projectPutJson({
        id: PROJECT_ID,
        personId: PERSON_ID,
        userId: "465247",
        userAgentId: "465247",
        // -4 is Cancellation: a small SIGNED id, the case a digits-only
        // serialiser would have left as a string.
        stateId: "-4",
        kindId: -1,
        persons: 42,
        name: "Acme holiday party",
      });

      expect(json).toContain(`"id":${PROJECT_ID}`);
      expect(json).toContain(`"personId":${PERSON_ID}`);
      expect(json).toContain('"userId":465247');
      expect(json).toContain('"stateId":-4');
      expect(json).not.toMatch(/"(id|personId|userId|userAgentId|stateId)":"/);
      // Full precision: JSON.parse rounds this id, the raw injection does not.
      expect(json).not.toContain("63000000009561440");
      expect(JSON.parse(json).name).toBe("Acme holiday party");
    });

    it("a small companyId goes as a number; a 17-digit one is injected raw, never quoted", () => {
      expect(projectPutJson({ id: PROJECT_ID, companyId: "5725529" })).toContain(
        '"companyId":5725529',
      );
      const big = projectPutJson({ id: PROJECT_ID, companyId: PERSON_ID });
      expect(big).toContain(`"companyId":${PERSON_ID}`);
      expect(big).not.toContain(`"companyId":"`);
    });

    it("leaves a non-numeric or absent id alone rather than inventing one", () => {
      const json = projectPutJson({ name: "x", userId: null, invoiceId: "", styleId: "620931" });
      expect(json).toContain('"userId":null');
      expect(json).toContain('"invoiceId":""');
      expect(json).toContain('"styleId":620931');
    });
  });

  it("the write goes through the SAME putProject: a 403 prompt is retried EXACTLY once with confirm:true, same session id", async () => {
    state.officeHandler = office({ refusals: 1, landed: "465247" });
    await putProjectFields({
      clientKey: "headpinzftmyers",
      projectId: PROJECT_ID,
      patch: { userId: "465247" },
    });

    expect(puts()).toHaveLength(2);
    const [first, second] = puts().map((p) => JSON.parse(p.body) as Record<string, unknown>);
    expect(first.confirm).toBe(false);
    expect(second.confirm).toBe(true);
    expect({ ...second, confirm: false }).toEqual(first);
    expect(puts()[0].sessionId).toBe(puts()[1].sessionId);
  });

  it("a prompt that persists after confirm:true throws — never a loop", async () => {
    state.officeHandler = office({ refusals: 5 });
    await expect(
      putProjectFields({
        clientKey: "headpinzftmyers",
        projectId: PROJECT_ID,
        patch: { userId: "465247" },
      }),
    ).rejects.toThrow(/still refused after confirm:true/);
    expect(puts()).toHaveLength(2);
  });

  it("a verify that reads the old value throws OfficeProjectVerifyError with NO second PUT", async () => {
    state.officeHandler = office({ landed: null });
    const err = await putProjectFields({
      clientKey: "headpinzftmyers",
      projectId: PROJECT_ID,
      patch: { userId: "465247" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfficeProjectVerifyError);
    expect((err as InstanceType<typeof OfficeProjectVerifyError>).field).toBe("userId");
    expect(puts()).toHaveLength(1);
    expect(gets()).toHaveLength(2);
  });

  it("takes the per-project lock before the first GET and releases it afterwards — success or failure", async () => {
    const key = `${CRM_PROJECT_LOCK_PREFIX}${PROJECT_ID}`;
    let lockedDuringGet = false;
    const inner = office({ landed: "465247" });
    state.officeHandler = ((method, path, body) => {
      if (method === "GET" && path.includes("/project/")) lockedDuringGet = state.redis.has(key);
      return inner(method, path, body);
    }) as OfficeHandler;
    await putProjectFields({
      clientKey: "headpinzftmyers",
      projectId: PROJECT_ID,
      patch: { userId: "465247" },
    });
    expect(lockedDuringGet).toBe(true);
    expect(state.redis.has(key)).toBe(false);

    state.officeHandler = office({ landed: null });
    await expect(
      putProjectFields({
        clientKey: "headpinzftmyers",
        projectId: PROJECT_ID,
        patch: { userId: "465247" },
      }),
    ).rejects.toBeInstanceOf(OfficeProjectVerifyError);
    expect(state.redis.has(key)).toBe(false);
  });

  it("a lock already held by another writer → OfficeProjectLockedError and ZERO Office calls", async () => {
    vi.useFakeTimers();
    try {
      state.lockRefused = true;
      state.officeHandler = office();
      const p = putProjectFields({
        clientKey: "headpinzftmyers",
        projectId: PROJECT_ID,
        patch: { userId: "1" },
      });
      const settled = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settled).toBeInstanceOf(OfficeProjectLockedError);
      expect(state.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty patch is refused before any call; a missing project is BmiProjectNotFoundError", async () => {
    state.officeHandler = office();
    await expect(
      putProjectFields({ clientKey: "headpinzftmyers", projectId: PROJECT_ID, patch: {} }),
    ).rejects.toThrow(/empty patch/);
    expect(state.requests).toHaveLength(0);

    state.officeHandler = ((method, path) =>
      path === "/auth/token"
        ? { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) }
        : { status: 404, body: "" }) as OfficeHandler;
    await expect(
      putProjectFields({ clientKey: "headpinzftmyers", projectId: "1", patch: { userId: "1" } }),
    ).rejects.toThrow(/does not exist in Office/);
    expect(puts()).toHaveLength(0);
  });

  it("toMinimalProject is the exported UI field set", () => {
    const minimal = toMinimalProject({
      id: "1",
      stateId: "2",
      schedules: [],
      products: [],
      userId: "3",
      extra: 1,
    });
    expect(minimal).toEqual({ id: "1", stateId: "2", userId: "3" });
    expect(toMinimalProject({ id: "1", logs: [] }, ["logs"])).toEqual({ id: "1", logs: [] });
  });

  /**
   * `companyId` — the project's BUSINESS — is a second PERSON id, and it is
   * absent from the DEFAULT `BMI_ID_FIELDS`. `fetchProjectRawIds` used to parse
   * with that default, so a 17-digit value ROUNDED on the way IN and
   * `putProjectFields` would have written the wrong business back: the 2026
   * off-by-one under a new field name. Both tenants' company ids are seven
   * digits today, which is the only reason nobody has been bitten yet.
   *
   * The id below is deliberately NOT a multiple of 8 — doubles are spaced 8
   * apart up here, so a value that happened to land on one would survive
   * `JSON.parse` and this test would pass while proving nothing.
   */
  it("a 17-digit companyId survives the READ and leaves raw, not rounded and not quoted", async () => {
    const COMPANY_ID = "63000000009561513";
    const naive = String(JSON.parse(`{"companyId":${COMPANY_ID}}`).companyId as number);
    expect(naive).not.toBe(COMPANY_ID); // the negative control: it really does corrupt

    state.officeHandler = ((method, path) => {
      if (path === "/auth/token") {
        return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
      }
      if (method === "GET" && path.endsWith(`/project/${PROJECT_ID}`)) {
        return {
          status: 200,
          body: projectText("28267036").replace('"companyId":1', `"companyId":${COMPANY_ID}`),
        };
      }
      if (method === "PUT" && path.endsWith("/project")) return { status: 200, body: "{}" };
      return { status: 404, body: "{}" };
    }) as OfficeHandler;

    await putProjectFields({
      clientKey: "headpinzftmyers",
      projectId: PROJECT_ID,
      patch: { name: "Acme holiday party" },
    });

    const body = puts()[0].body;
    expect(body).toContain(`"companyId":${COMPANY_ID}`);
    // Raw, at full precision — not quoted (a shape no proven write has sent)
    // and not rounded to …512.
    expect(body).not.toContain(`"companyId":"${COMPANY_ID}"`);
    expect(body).not.toContain(`"companyId":${naive}`);
  });

  it("a SMALL companyId still leaves as a plain number, byte-identical to the proven rail", () => {
    expect(projectPutJson({ id: "58454076", companyId: "1" })).toContain('"companyId":1');
  });
});
