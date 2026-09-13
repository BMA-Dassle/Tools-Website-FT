import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, installMsw, rawJson } from "@/test/msw/server";
import { OFFICE_BASE } from "@/test/msw/handlers/office";
import {
  BUILDER_PRODUCT_ID,
  BUILDER_PRODUCT_ROW_BASE,
  BUILDER_PROJECT_ID,
  FULL_RESOURCE_ID,
  OPEN_RESOURCE_ID,
  callsTo,
  officeBuilderHandlers,
  officeProjectState,
  officeWriteCalls,
  resetOfficeBuilderState,
  seedExistingProject,
  setPandoraLocalSynced,
} from "@/test/msw/handlers/office-builder";
import type { QuoteLine, QuoteLinePatch } from "../contracts";
import type { BuilderLeadRow } from "../data/builder-lead-db";
import type { CrmUser } from "~/features/crm/core/types";

/**
 * The builder's write rail, end to end: the REAL Office transport against MSW,
 * with Neon replaced by an in-memory double.
 *
 * NO LIVE TENANT IS TOUCHED. `onUnhandledRequest: "error"` is what makes that
 * a guarantee — and it is the reason these tests can be run on any machine by
 * anyone, which is the whole argument for them existing before a live smoke
 * rather than instead of one.
 *
 * WHAT IS PROVEN HERE (each invariant has its own describe block):
 *
 *   R2  the Neon row exists BEFORE the Office call, and survives its failure
 *   R3  a line is idempotent by `projectProduct.id`
 *   R4  writes are paused by the kill switch; a lost claim race is cleaned up
 *   R5  a 200 is not a result — the verify re-read decides
 *   R6  a 403 on linkSchedule is a soft refusal, surfaced and never retried
 *
 * WHAT IS NOT PROVEN HERE, and cannot be: whether a live Office accepts these
 * REQUEST BODIES. MSW answers whatever it is asked. That is the live smoke's
 * job, and `office-write.ts` keeps each body in one named function so a
 * correction lands in one place.
 */

vi.mock("@/lib/redis", () => {
  const store = new Map<string, string>();
  return {
    default: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ..._rest: unknown[]) => {
        const nx = _rest.includes("NX");
        if (nx && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      },
      setex: async (k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return "OK";
      },
      del: async (k: string) => (store.delete(k) ? 1 : 0),
      eval: async (_script: string, _n: number, key: string) => (store.delete(key) ? 1 : 0),
      on: () => undefined,
    },
  };
});

const server = installMsw(...officeBuilderHandlers);

const {
  addQuoteLine,
  applyTemplate,
  ensureOfficeProject,
  linkLineSchedule,
  loadBuilderState,
  moveProjectDate,
  removeQuoteLine,
  retryQuoteLine,
  syncStateFor,
  writesStateFor,
} = await import("./builder");

const { CrmHttpError } = await import("~/features/crm/core/http");

// ---------------------------------------------------------------------------
// The in-memory store — Neon's seam
// ---------------------------------------------------------------------------

const LEAD: BuilderLeadRow = {
  rowId: "1",
  publicId: "L-1042",
  title: "Acme Corp",
  centre: "FT",
  clientKey: "headpinzftmyers",
  eventDate: "2026-10-17",
  eventTime: "18:00",
  guests: 12,
  statusId: "quote",
  bmiProjectId: null,
  firstName: "Dana",
  lastName: "Acme",
  email: "dana@example.com",
  phoneE164: "+12395551234",
};

const USER: CrmUser = {
  email: "kelsea@headpinz.com",
  name: "Kelsea",
  sub: null,
  roles: ["access", "sales"],
  role: "rep",
  rep: null,
};

const DIRECTOR: CrmUser = { ...USER, email: "eric@headpinz.com", role: "director" };

interface Fake {
  lead: BuilderLeadRow;
  lines: QuoteLine[];
  nextId: number;
  bmiWrites: unknown;
  templates: Map<
    string,
    {
      id: string;
      lines: Array<{ productId: string; per?: number; min?: number }>;
      baselineGuests: number;
    }
  >;
  templateUses: string[];
  mintFailures: string[];
}

let fake: Fake;

function newLine(input: {
  leadId: string;
  bmiProjectId: string | null;
  productId: string;
  productName: string;
  nameOverride?: string | null;
  quantity: number;
  pricePerUnitCents: number;
  priceDate: string | null;
  actorEmail: string;
}): QuoteLine {
  return {
    id: String(fake.nextId++),
    leadId: input.leadId,
    bmiProjectId: input.bmiProjectId,
    productId: input.productId,
    productName: input.productName,
    nameOverride: input.nameOverride ?? null,
    quantity: input.quantity,
    pricePerUnitCents: input.pricePerUnitCents,
    priceDate: input.priceDate,
    resourceId: null,
    scheduleBlocks: [],
    bmiProjectProductId: null,
    bmiScheduleIds: [],
    status: "pending",
    writeError: null,
    officePrompt: null,
    actorEmail: input.actorEmail,
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
  };
}

function store() {
  return {
    async findLead(publicId: string) {
      return publicId === fake.lead.publicId ? { ...fake.lead } : null;
    },
    async claimLeadProject(_rowId: string, projectId: string) {
      if (fake.lead.bmiProjectId) return null; // lost the race
      fake.lead = { ...fake.lead, bmiProjectId: projectId };
      return projectId;
    },
    async recordMintFailure(_rowId: string, error: string) {
      fake.mintFailures.push(error);
    },
    async updateLeadEventDate(_rowId: string, date: string) {
      fake.lead = { ...fake.lead, eventDate: date };
    },
    async listLines(leadRowId: string) {
      return fake.lines.filter((l) => l.leadId === leadRowId).map((l) => ({ ...l }));
    },
    async getLine(id: string) {
      const found = fake.lines.find((l) => l.id === id);
      return found ? { ...found } : null;
    },
    async insertLine(input: Parameters<typeof newLine>[0]) {
      const line = newLine(input);
      fake.lines.push(line);
      return { ...line };
    },
    async patchLine(id: string, patch: QuoteLinePatch) {
      const idx = fake.lines.findIndex((l) => l.id === id);
      if (idx < 0) return null;
      const next = { ...fake.lines[idx] } as QuoteLine & Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) next[k] = v;
      }
      next.updatedAt = new Date().toISOString();
      fake.lines[idx] = next;
      return { ...next };
    },
    async claimProjectProduct(id: string, ppId: string, projectId: string) {
      const idx = fake.lines.findIndex((l) => l.id === id);
      if (idx < 0) return null;
      if (fake.lines[idx].bmiProjectProductId) return null; // already claimed
      fake.lines[idx] = {
        ...fake.lines[idx],
        bmiProjectProductId: ppId,
        bmiProjectId: projectId,
        status: "written",
        writeError: null,
        officePrompt: null,
        updatedAt: new Date().toISOString(),
      };
      return { ...fake.lines[idx] };
    },
    async getTemplate(id: string) {
      const t = fake.templates.get(id);
      return t
        ? {
            id: t.id,
            name: "Party package",
            centre: null,
            baselineGuests: t.baselineGuests,
            description: null,
            lines: t.lines,
            uses: 0,
            createdBy: null,
            createdAt: "2026-09-13T12:00:00.000Z",
            updatedAt: "2026-09-13T12:00:00.000Z",
          }
        : null;
    },
    async bumpTemplateUse(id: string) {
      fake.templateUses.push(id);
    },
    async bmiWritesSetting() {
      return fake.bmiWrites;
    },
  };
}

function ctx(user: CrmUser = USER) {
  return { store: store() as never, user };
}

beforeEach(() => {
  resetOfficeBuilderState();
  fake = {
    lead: { ...LEAD },
    lines: [],
    nextId: 1,
    bmiWrites: { enabled: true, offCentres: [] },
    templates: new Map(),
    templateUses: [],
    mintFailures: [],
  };
  delete process.env.CRM_BMI_WRITES;
  delete process.env.CRM_BMI_WRITES_OFF_CENTRES;
  process.env.BMI_OFFICE_USERNAME = "API2";
  process.env.BMI_OFFICE_PASSWORD_B64 = "JGMxbjFlbGxv";
  delete process.env.SWAGGER_ADMIN_KEY;
});

// ---------------------------------------------------------------------------

describe("the write sequence", () => {
  it("creates the project: autocreate → search/person → autosave, then verifies", async () => {
    const state = await ensureOfficeProject(ctx(), "L-1042");

    const paths = officeWriteCalls
      .filter((c) => !c.path.endsWith("/auth/token"))
      .map((c) => `${c.method} ${c.path.replace("/api/headpinzftmyers", "")}`);

    expect(paths).toEqual([
      "POST /project/autocreate",
      "GET /search/person",
      "POST /project/autosave",
      // R5: the verified re-read, BEFORE the lead is told it has a project.
      `GET /project/${BUILDER_PROJECT_ID}`,
      // …and the state load that follows every mutation, so the caller gets a
      // project it has seen rather than one it assumed.
      `GET /project/${BUILDER_PROJECT_ID}`,
    ]);
    expect(state.project?.projectId).toBe(BUILDER_PROJECT_ID);
    expect(fake.lead.bmiProjectId).toBe(BUILDER_PROJECT_ID);
  });

  it("the host search uses ?token= (never ?q=) and tries email before phone", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    const search = callsTo("/search/person")[0];
    expect(search.search.get("token")).toBe("dana@example.com");
    expect(search.search.get("q")).toBeNull();
    expect(search.search.get("maxResults")).toBe("20");
  });

  it("adds a line: price for the DATE, then projectProduct, then the verify read", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    officeWriteCalls.length = 0;

    const state = await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 2,
    });

    const paths = officeWriteCalls.map((c) => `${c.method} ${c.path.split("/headpinzftmyers")[1]}`);
    expect(paths).toContain("POST /projectProduct/price");
    expect(paths).toContain("POST /projectProduct");
    expect(paths.filter((p) => p.startsWith("GET /project/")).length).toBeGreaterThan(0);

    const line = state.lines[0];
    expect(line.status).toBe("written");
    expect(line.bmiProjectProductId).toBe(String(BUILDER_PRODUCT_ROW_BASE));
    // 2026-10-17 is a Saturday: the weekend price, because the price call
    // carried the event's own date.
    expect(line.pricePerUnitCents).toBe(2499);
  });
});

describe("R2 — Neon first, Office second", () => {
  it("the line is recorded before Office is asked, and survives a refusal", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    // Make the project vanish from Office's point of view: the projectProduct
    // POST still answers, but the verify re-read 404s.
    officeProjectState.exists = false;

    const state = await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });

    // The quote is NOT lost. That is the whole point.
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0].productName).toBe("Race pack");
  });

  it("a paused kill switch records the line and sends nothing at all", async () => {
    seedExistingProject();
    fake.lead = { ...fake.lead, bmiProjectId: BUILDER_PROJECT_ID };
    process.env.CRM_BMI_WRITES = "false";
    officeWriteCalls.length = 0;

    const state = await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });

    expect(state.writes.enabled).toBe(false);
    expect(state.writes.message).toBe("BMI writes are paused by admin");
    expect(state.lines[0].status).toBe("paused");
    // Not one byte went to Office.
    expect(callsTo("/projectProduct")).toHaveLength(0);
    expect(callsTo("/projectProduct/price")).toHaveLength(0);
  });
});

describe("R3 — idempotent by projectProduct.id", () => {
  it("retrying a written line does NOT create a second Office row", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });
    expect(officeProjectState.products).toHaveLength(1);

    await retryQuoteLine(ctx(), "L-1042", fake.lines[0].id);

    expect(officeProjectState.products).toHaveLength(1);
    expect(fake.lines[0].bmiProjectProductId).toBe(String(BUILDER_PRODUCT_ROW_BASE));
  });

  it("a lost claim race deletes the duplicate instead of orphaning it", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    const base = store();
    // Simulate the loser: the conditional UPDATE finds an id already there.
    const losing = {
      ...base,
      claimProjectProduct: async () => null,
    };

    await addQuoteLine(
      { store: losing as never, user: USER },
      {
        leadPublicId: "L-1042",
        productId: BUILDER_PRODUCT_ID,
        productName: "Race pack",
        quantity: 1,
      },
    );

    // Created, then immediately removed — the project is left clean.
    expect(callsTo("/projectProduct").filter((c) => c.method === "POST")).toHaveLength(1);
    expect(callsTo("/projectProduct").filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(officeProjectState.products).toHaveLength(0);
  });
});

describe("R5 — never trust a 200", () => {
  it("a delete Office answers 200 to but does not honour stays FAILED", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });
    const lineId = fake.lines[0].id;
    const ppId = fake.lines[0].bmiProjectProductId;

    // The documented "removeItem 200 ≠ success" hazard, reproduced: Office
    // cheerfully answers 200 and keeps the row.
    server.use(http.delete(`${OFFICE_BASE}/api/:clientKey/projectProduct`, () => rawJson("{}")));

    const state = await removeQuoteLine(ctx(), "L-1042", lineId);

    expect(state.lines[0].status).toBe("failed");
    expect(state.lines[0].writeError).toContain("still on the project");
    // The Office id is KEPT, so a later retry deletes the real row rather than
    // losing track of it.
    expect(state.lines[0].bmiProjectProductId).toBe(ppId);
    expect(officeProjectState.products).toHaveLength(1);
  });

  it("an honest delete really removes the row and marks the line removed", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });

    const state = await removeQuoteLine(ctx(), "L-1042", fake.lines[0].id);
    expect(state.lines[0].status).toBe("removed");
    expect(officeProjectState.products).toHaveLength(0);
  });

  it("a line Office never really took is marked failed, not written", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    officeWriteCalls.length = 0;

    // The POST succeeds; the project then forgets the row before the verify.
    const originalPush = officeProjectState.products.push.bind(officeProjectState.products);
    officeProjectState.products.push = ((...rows: never[]) => {
      const n = originalPush(...rows);
      officeProjectState.products.length = 0; // Office "loses" it
      return n;
    }) as typeof officeProjectState.products.push;

    const state = await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });

    expect(state.lines[0].status).toBe("failed");
    expect(state.lines[0].writeError).toContain("not on the project");
  });
});

describe("R6 — the 403 soft refusal", () => {
  async function withWrittenLine() {
    await ensureOfficeProject(ctx(), "L-1042");
    await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });
    return fake.lines[0].id;
  }

  const fullHeat = [
    {
      resourceId: FULL_RESOURCE_ID,
      start: "2026-10-17T18:00:00",
      stop: "2026-10-17T18:12:00",
      persons: 12,
    },
  ];

  it("surfaces 'heat_full' with Office's own words and does NOT retry", async () => {
    const lineId = await withWrittenLine();
    officeWriteCalls.length = 0;

    await expect(
      linkLineSchedule(ctx(), { leadPublicId: "L-1042", lineId, blocks: fullHeat }),
    ).rejects.toMatchObject({
      status: 409,
      message: "heat_full",
      officePrompt: { message: expect.stringContaining("higher than the capacity") },
    });

    // ONE attempt. A blind retry against a full heat is how a rep ends up
    // overbooking a track without ever deciding to.
    expect(callsTo("/projectProduct/linkSchedule")).toHaveLength(1);

    // The refusal is recorded on the line so the screen can show it after a reload.
    expect(fake.lines[0].status).toBe("failed");
    expect(fake.lines[0].writeError).toBe("This heat is full — pick another.");
    expect(fake.lines[0].officePrompt?.message).toContain("overbooking is not allowed");
  });

  it("a rep may not force; a director may, and it is logged", async () => {
    const lineId = await withWrittenLine();

    await expect(
      linkLineSchedule(ctx(USER), {
        leadPublicId: "L-1042",
        lineId,
        blocks: fullHeat,
        force: true,
      }),
    ).rejects.toMatchObject({ status: 403, message: "director_only" });

    const state = await linkLineSchedule(ctx(DIRECTOR), {
      leadPublicId: "L-1042",
      lineId,
      blocks: fullHeat,
      force: true,
    });
    expect(state.lines[0].status).toBe("written");
    expect(state.lines[0].scheduleBlocks).toHaveLength(1);
    expect(state.lines[0].bmiScheduleIds).toHaveLength(1);

    const forced = callsTo("/projectProduct/linkSchedule").at(-1)!;
    expect(forced.body).toContain('"confirm":true');
  });

  it("an open heat links first time, with confirm:false", async () => {
    const lineId = await withWrittenLine();
    const state = await linkLineSchedule(ctx(), {
      leadPublicId: "L-1042",
      lineId,
      blocks: [
        {
          resourceId: OPEN_RESOURCE_ID,
          start: "2026-10-17T18:00:00",
          stop: "2026-10-17T18:12:00",
          persons: 12,
        },
      ],
    });
    expect(state.lines[0].status).toBe("written");
    expect(callsTo("/projectProduct/linkSchedule")[0].body).toContain('"confirm":false');
  });
});

describe("changed in Office", () => {
  it("names a product row we did not add, and never deletes it", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    // Somebody adds a line in the Office UI.
    officeProjectState.products.push({
      id: "63000000009561599",
      productId: "999",
      quantity: 1,
      pricePerUnit: 50,
      name: "Added by Lori in Office",
    });

    const state = await loadBuilderState(ctx(), "L-1042");
    expect(state.changedInOffice).toBe(true);
    expect(state.officeOnly).toHaveLength(1);
    expect(state.officeOnly[0].name).toBe("Added by Lori in Office");
    expect(state.officeOnly[0].bmiProjectProductId).toBe("63000000009561599");
    // Still there: the builder reports, it does not tidy.
    expect(officeProjectState.products).toHaveLength(1);
  });
});

describe("moving the date", () => {
  it("goes through putProjectFields and RE-PRICES every line", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    await addQuoteLine(ctx(), {
      leadPublicId: "L-1042",
      productId: BUILDER_PRODUCT_ID,
      productName: "Race pack",
      quantity: 1,
    });
    expect(fake.lines[0].pricePerUnitCents).toBe(2499); // Saturday

    const state = await moveProjectDate(ctx(), "L-1042", "2026-10-13"); // a Tuesday

    expect(callsTo("/project").some((c) => c.method === "PUT")).toBe(true);
    expect(fake.lead.eventDate).toBe("2026-10-13");
    // The whole reason to re-price: a weekend rate left on a weekday event is money.
    expect(state.lines[0].pricePerUnitCents).toBe(1999);
    expect(state.lines[0].priceDate).toBe("2026-10-13");
  });
});

describe("templates", () => {
  it("scales to the party, prices for the date, and counts the use", async () => {
    await ensureOfficeProject(ctx(), "L-1042");
    fake.templates.set("7", {
      id: "7",
      baselineGuests: 20,
      lines: [{ productId: BUILDER_PRODUCT_ID, per: 6, min: 2 }],
    });

    const state = await applyTemplate(ctx(), "L-1042", "7");

    // 12 guests ÷ 6 per = 2, and the floor is 2 anyway.
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0].quantity).toBe(2);
    // Priced live, for the event's own (Saturday) date — never a stored number.
    expect(state.lines[0].pricePerUnitCents).toBe(2499);
    expect(fake.templateUses).toEqual(["7"]);
  });
});

describe("syncing to centre", () => {
  it("says 'syncing' until Pandora reads the project back, then 'clean'", async () => {
    process.env.SWAGGER_ADMIN_KEY = "test-key";
    setPandoraLocalSynced(false);
    expect(await syncStateFor("FT", BUILDER_PROJECT_ID, Date.now())).toBe("syncing");

    setPandoraLocalSynced(true);
    expect(await syncStateFor("FT", BUILDER_PROJECT_ID, Date.now())).toBe("clean");
  });

  it("stops guessing rather than spinning forever", async () => {
    process.env.SWAGGER_ADMIN_KEY = "test-key";
    setPandoraLocalSynced(false);
    const longAgo = Date.now() - 60 * 60 * 1000;
    expect(await syncStateFor("FT", BUILDER_PROJECT_ID, longAgo)).toBe("unknown");
  });

  it("is 'unknown', never a false 'clean', when Pandora cannot be asked", async () => {
    delete process.env.SWAGGER_ADMIN_KEY;
    expect(await syncStateFor("FT", BUILDER_PROJECT_ID, Date.now())).toBe("unknown");
  });
});

describe("kill switches are kill switches", () => {
  it("every switch defaults ON — unset, empty and garbage all mean enabled", () => {
    delete process.env.CRM_BMI_WRITES;
    expect(writesStateFor("headpinzftmyers", undefined).enabled).toBe(true);
    expect(writesStateFor("headpinzftmyers", null).enabled).toBe(true);
    expect(writesStateFor("headpinzftmyers", "nonsense").enabled).toBe(true);
    expect(writesStateFor("headpinzftmyers", {}).enabled).toBe(true);

    process.env.CRM_BMI_WRITES = "true";
    expect(writesStateFor("headpinzftmyers", undefined).enabled).toBe(true);
    process.env.CRM_BMI_WRITES = "yes";
    expect(writesStateFor("headpinzftmyers", undefined).enabled).toBe(true);
  });

  it("only the literal string 'false' turns writes off", () => {
    process.env.CRM_BMI_WRITES = "false";
    const off = writesStateFor("headpinzftmyers", undefined);
    expect(off.enabled).toBe(false);
    expect(off.reason).toBe("env");
  });

  it("one centre can be paused without touching the other", () => {
    process.env.CRM_BMI_WRITES_OFF_CENTRES = "headpinznaples";
    expect(writesStateFor("headpinznaples", undefined).enabled).toBe(false);
    expect(writesStateFor("headpinzftmyers", undefined).enabled).toBe(true);
  });

  it("the director's Neon toggle pauses without a deploy", () => {
    expect(writesStateFor("headpinzftmyers", { enabled: false }).enabled).toBe(false);
    expect(
      writesStateFor("headpinzftmyers", { enabled: true, offCentres: ["headpinzftmyers"] }).enabled,
    ).toBe(false);
  });
});

describe("refusals a rep must act on", () => {
  it("a lead with no project refuses rather than inventing one", async () => {
    await expect(
      addQuoteLine(ctx(), {
        leadPublicId: "L-1042",
        productId: BUILDER_PRODUCT_ID,
        productName: "Race pack",
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(CrmHttpError);
  });

  it("an unknown lead is a 404, not an empty builder", async () => {
    await expect(ensureOfficeProject(ctx(), "L-9999")).rejects.toMatchObject({
      status: 404,
      message: "lead_not_found",
    });
  });
});
