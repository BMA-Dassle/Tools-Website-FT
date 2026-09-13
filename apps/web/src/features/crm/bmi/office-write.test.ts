import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMsw } from "@/test/msw/server";
import {
  BUILDER_PERSON_ID,
  BUILDER_PRODUCT_ID,
  BUILDER_PROJECT_ID,
  BUILDER_PRODUCT_ROW_BASE,
  FULL_RESOURCE_ID,
  LINK_SCHEDULE_REFUSAL,
  OPEN_RESOURCE_ID,
  callsTo,
  officeBuilderHandlers,
  officeWriteCalls,
  resetOfficeBuilderState,
  seedExistingProject,
} from "@/test/msw/handlers/office-builder";

/**
 * The CRM's Office WRITE transport, through the real code against MSW.
 *
 * NOTHING HERE TOUCHES A LIVE TENANT, and `onUnhandledRequest: "error"` makes
 * that a guarantee rather than an intention: a request to a path this file has
 * not mocked fails the test loudly instead of reaching `office-api22`.
 *
 * What these tests are actually for:
 *
 *  1. **Precision.** Every id Office returns is 17 digits in the fixtures, and
 *     every one is asserted as an exact STRING. A naive `JSON.parse` turns
 *     63000000009561437 into 63000000009561440 — the negative control below
 *     shows it doing exactly that, so the assertion cannot pass by luck.
 *  2. **Bytes.** Each request body is captured verbatim off the wire and
 *     compared to what a live Office is expected to accept, so a future edit
 *     to a body builder is a failing test rather than a 400 at a rep's desk.
 *  3. **The 403.** `linkSchedule` against a full resource returns Office's own
 *     soft-refusal envelope, and the transport must hand it back as a VALUE —
 *     never throw, never retry.
 */

vi.mock("@/lib/redis", () => ({
  default: {
    get: async () => null,
    setex: async () => "OK",
    set: async () => "OK",
    eval: async () => 1,
    on: () => undefined,
  },
}));

installMsw(...officeBuilderHandlers);

const {
  autocreateBody,
  autocreateProject,
  autosaveBody,
  createProjectProduct,
  deleteProjectProduct,
  downloadPerson,
  linkSchedule,
  linkScheduleBody,
  newWriteSession,
  officeStamp,
  officeWrite,
  centsToDollars,
  dollarsToCents,
  productPrice,
  projectBalance,
  projectProductBody,
  putPerson,
  searchPerson,
  toWirePrompt,
} = await import("./office-write");

const CK = "headpinzftmyers";

beforeEach(() => {
  resetOfficeBuilderState();
});

describe("precision (R1)", () => {
  it("a 17-digit projectProduct id survives the round trip as an exact string", async () => {
    seedExistingProject();
    const session = newWriteSession();
    const res = await createProjectProduct(CK, session, {
      projectId: BUILDER_PROJECT_ID,
      productId: BUILDER_PRODUCT_ID,
      quantity: 2,
      pricePerUnit: 19.99,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id).toBe(String(BUILDER_PRODUCT_ROW_BASE));
    expect(typeof res.data.id).toBe("string");
  });

  it("NEGATIVE CONTROL: the same payload through JSON.parse is corrupted", async () => {
    seedExistingProject();
    const res = await createProjectProduct(CK, newWriteSession(), {
      projectId: BUILDER_PROJECT_ID,
      productId: BUILDER_PRODUCT_ID,
      quantity: 1,
      pricePerUnit: 19.99,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const naive = JSON.parse(res.raw) as { id: number };
    // The proof the assertion above is load-bearing: standard parsing does not
    // merely risk corrupting this id, it DOES corrupt it, silently.
    expect(String(naive.id)).not.toBe(String(BUILDER_PRODUCT_ROW_BASE));
    expect(Number.isSafeInteger(naive.id)).toBe(false);
  });

  it("search/person reads `localId`, not `id`, and keeps all 17 digits", async () => {
    const res = await searchPerson(CK, newWriteSession(), "dana@example.com");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]?.localId).toBe(BUILDER_PERSON_ID);
  });

  it("person/download → PUT /person sends the id back UNQUOTED, at full precision", async () => {
    const session = newWriteSession();
    const got = await downloadPerson(CK, session, BUILDER_PERSON_ID);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Parsed IN as a string…
    expect(got.data.id).toBe(BUILDER_PERSON_ID);

    await putPerson(CK, session, { ...got.data, firstName: "Dana-Marie" });
    const sent = callsTo("/person").filter((c) => c.method === "PUT")[0];
    // …and OUT as a raw number, which is the shape the proven rail sends and
    // the only way to emit 17 digits without quoting them.
    expect(sent.body).toContain(`"id":${BUILDER_PERSON_ID}`);
    expect(sent.body).not.toContain(`"id":"${BUILDER_PERSON_ID}"`);
    expect(sent.body).toContain('"firstName":"Dana-Marie"');
  });
});

describe("request bodies", () => {
  it("autocreate carries the centre-local stamp with no offset", () => {
    const body = autocreateBody({
      locationId: 467486,
      date: "2026-10-17",
      time: "18:00",
      persons: 12,
      name: "Acme",
    });
    expect(JSON.parse(body)).toEqual({
      locationId: 467486,
      date: "2026-10-17T18:00:00",
      persons: 12,
      name: "Acme",
      confirm: false,
    });
    // No `Z`, no `+04:00` — an instant here is how an evening lands on the
    // wrong day once a UTC lambda gets hold of it.
    expect(body).not.toMatch(/Z"|[+-]\d\d:\d\d"/);
  });

  it("autosave omits personId entirely when there is no host", () => {
    const body = JSON.parse(
      autosaveBody({
        projectId: BUILDER_PROJECT_ID,
        name: "Acme",
        date: "2026-10-17",
        time: null,
        persons: 12,
        personId: null,
      }),
    ) as Record<string, unknown>;
    expect("personId" in body).toBe(false);
    // A time we do not have is midnight, never "now".
    expect(body.date).toBe("2026-10-17T00:00:00");
  });

  it("projectProduct matches the proven production body, field for field", () => {
    const body = JSON.parse(
      projectProductBody({
        projectId: BUILDER_PROJECT_ID,
        productId: BUILDER_PRODUCT_ID,
        quantity: 3,
        pricePerUnit: 19.99,
      }),
    ) as Record<string, unknown>;

    expect(body).toEqual({
      projectId: BUILDER_PROJECT_ID,
      productId: BUILDER_PRODUCT_ID,
      quantity: 3,
      pricePerUnit: 19.99,
      totalPrice: 59.97,
      isVisible: true,
      discountMetaId: null,
      name: null,
      dynamicGroups: null,
    });
    // Ids go out QUOTED here — byte-compatible with `updateProjectProduct`,
    // the only projectProduct write this codebase has proven in production.
    expect(typeof body.projectId).toBe("string");
  });

  it("linkSchedule sends confirm:false first, and the IDENTICAL body with confirm:true on a force", () => {
    const blocks = [
      {
        resourceId: OPEN_RESOURCE_ID,
        start: "2026-10-17T18:00:00",
        stop: "2026-10-17T18:12:00",
        persons: 12,
      },
    ];
    const first = linkScheduleBody({
      projectId: BUILDER_PROJECT_ID,
      projectProductId: "63000000009561510",
      blocks,
    });
    const forced = linkScheduleBody({
      projectId: BUILDER_PROJECT_ID,
      projectProductId: "63000000009561510",
      blocks,
      confirm: true,
    });
    expect(first).toContain('"confirm":false');
    // The whole override protocol: one byte-range differs, nothing else.
    expect(forced).toBe(first.replace('"confirm":false', '"confirm":true'));
  });
});

describe("the 403 soft refusal (R6)", () => {
  it("a full resource comes back as a VALUE, not a throw", async () => {
    seedExistingProject();
    const res = await linkSchedule(CK, newWriteSession(), {
      projectId: BUILDER_PROJECT_ID,
      projectProductId: "63000000009561510",
      blocks: [
        {
          resourceId: FULL_RESOURCE_ID,
          start: "2026-10-17T18:00:00",
          stop: "2026-10-17T18:12:00",
          persons: 12,
        },
      ],
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("prompt");
    if (res.kind !== "prompt") return;
    expect(res.status).toBe(403);
    // `IsQuestion:false` reads final and is NOT: confirm overrides it.
    expect(res.prompt.IsQuestion).toBe(false);
    expect(res.prompt.Message).toContain("higher than the capacity");
    expect(res.prompt.OperationId).toBe(LINK_SCHEDULE_REFUSAL.OperationId);
  });

  it("the wire prompt flattens the literal newline Office embeds", () => {
    const wire = toWirePrompt({
      IsQuestion: true,
      Kind: 4,
      Message: "Total persons (12) is higher than the capacity (0). \n Do you want to overbook?",
      OperationId: "abc",
    });
    expect(wire.message).toBe(
      "Total persons (12) is higher than the capacity (0). Do you want to overbook?",
    );
    expect(wire.operationId).toBe("abc");
  });

  it("confirm:true gets through the same refusal", async () => {
    seedExistingProject();
    const res = await linkSchedule(CK, newWriteSession(), {
      projectId: BUILDER_PROJECT_ID,
      projectProductId: "63000000009561510",
      blocks: [
        {
          resourceId: FULL_RESOURCE_ID,
          start: "2026-10-17T18:00:00",
          stop: "2026-10-17T18:12:00",
          persons: 12,
        },
      ],
      confirm: true,
    });
    expect(res.ok).toBe(true);
  });

  it("a plain HTTP failure is NOT dressed up as a refusal", async () => {
    // The project has not been created, so Office 404s. That is a failure the
    // builder must report as a failure — the `prompt` branch is reserved for
    // the envelope, and nothing else may borrow it.
    const res = await officeWrite(CK, `project/${BUILDER_PROJECT_ID}`, {
      method: "GET",
      sessionId: newWriteSession(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("http");
    expect(res.status).toBe(404);
  });
});

describe("weekday / weekend pricing", () => {
  it("asks per DATE and gets a different number for a Saturday", async () => {
    const session = newWriteSession();
    const tuesday = await productPrice(CK, session, {
      productId: BUILDER_PRODUCT_ID,
      date: "2026-10-13",
    });
    const saturday = await productPrice(CK, session, {
      productId: BUILDER_PRODUCT_ID,
      date: "2026-10-17",
    });

    expect(tuesday.ok && saturday.ok).toBe(true);
    if (!tuesday.ok || !saturday.ok) return;
    expect(tuesday.data.pricePerUnit).toBe(19.99);
    expect(saturday.data.pricePerUnit).toBe(24.99);

    // The date really is on the query string, which is what makes the two
    // answers possible at all.
    const priced = callsTo("/projectProduct/price");
    expect(priced.map((c) => c.search.get("date"))).toEqual(["2026-10-13", "2026-10-17"]);
    expect(priced[0].search.get("productId")).toBe(BUILDER_PRODUCT_ID);
  });
});

describe("sessions", () => {
  it("one operation's calls share ONE x-session-id, and it is not a read session", async () => {
    seedExistingProject();
    const session = newWriteSession();
    await autocreateProject(CK, session, {
      locationId: 467486,
      date: "2026-10-17",
      time: "18:00",
      persons: 12,
      name: "Acme",
    });
    await createProjectProduct(CK, session, {
      projectId: BUILDER_PROJECT_ID,
      productId: BUILDER_PRODUCT_ID,
      quantity: 1,
      pricePerUnit: 19.99,
    });

    const ids = new Set(
      officeWriteCalls.filter((c) => !c.path.endsWith("/auth/token")).map((c) => c.sessionId),
    );
    expect([...ids]).toEqual([session]);
    // Never the shared guest-facing read session.
    expect(session.startsWith("events-")).toBe(false);
  });

  it("two operations do not share a session", () => {
    expect(newWriteSession()).not.toBe(newWriteSession());
  });
});

describe("delete", () => {
  it("removes the row and the project really stops carrying it", async () => {
    seedExistingProject();
    const session = newWriteSession();
    const made = await createProjectProduct(CK, session, {
      projectId: BUILDER_PROJECT_ID,
      productId: BUILDER_PRODUCT_ID,
      quantity: 1,
      pricePerUnit: 19.99,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    await deleteProjectProduct(CK, session, String(made.data.id));
    const del = callsTo("/projectProduct").filter((c) => c.method === "DELETE")[0];
    expect(del.search.get("id")).toBe(String(made.data.id));

    const after = await projectBalance(CK, session, BUILDER_PROJECT_ID);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.total).toBe(0);
  });
});

describe("pure helpers", () => {
  it("officeStamp never builds a Date and pads a bare time to midnight", () => {
    expect(officeStamp("2026-10-17", "18:00")).toBe("2026-10-17T18:00:00");
    expect(officeStamp("2026-10-17", null)).toBe("2026-10-17T00:00:00");
    expect(officeStamp("2026-10-17T99:99:99", "9:5")).toBe("2026-10-17T00:00:00");
  });

  it("money survives the cents round trip without float drift", () => {
    expect(centsToDollars(1999)).toBe(19.99);
    expect(dollarsToCents(19.99)).toBe(1999);
    expect(dollarsToCents(centsToDollars(2499))).toBe(2499);
    // The classic: 19.99 * 100 is 1998.9999999999998 in IEEE 754.
    expect(dollarsToCents(0.29)).toBe(29);
  });
});
