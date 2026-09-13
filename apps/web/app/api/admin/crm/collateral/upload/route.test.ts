import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE ROUTE THAT HAND-ROLLS THE ADMIN CHAIN, driven at the handler level.
 *
 * It cannot use `withCrmRoute` (that wrapper reads `req.json()` first, which
 * consumes a multipart stream), so it repeats credential → session → director
 * → service → audit by hand. A hand-rolled chain nothing tests is a chain that
 * drifts, and every case below is a way it could drift silently:
 *
 *   bad credential → 404       byte-identical to `gateNotFound()`, so a caller
 *                              cannot tell which layer refused and `crmFetch`
 *                              reads it as "re-mint and reload";
 *   no session → 401           the credential alone must not be enough: it is
 *                              a shared token, and `actor_email` has to exist;
 *   a rep → 403                reps share, directors curate — the screen hides
 *                              the Upload button, this is what makes that true;
 *   no Blob token → 503        AND `req.formData()` never called, so a
 *                              deployment without a store never buffers 25 MB
 *                              to refuse it;
 *   oversize / .html → 413/415 the same table the sheet checks against;
 *   insert fails → blob deleted  R2's ordering cannot be met literally
 *                              (`blob_url` is NOT NULL), so the compensating
 *                              delete is what stops an orphaned public object.
 */

const bag = vi.hoisted(() => ({
  session: null as unknown,
  created: [] as unknown[],
  createThrows: false,
  deleted: [] as string[],
  audits: [] as unknown[],
  formDataCalls: 0,
}));

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(bag.session),
  hasAdminAccess: (s: { roles?: string[] } | null | undefined) => !!s?.roles?.includes("access"),
}));

vi.mock("~/features/crm/reps", () => ({ findRepByLoginEmail: async () => null }));

vi.mock("~/features/crm/core/data/audit-db", () => ({
  writeAudit: async (entry: unknown) => {
    bag.audits.push(entry);
  },
}));

vi.mock("~/features/crm/collateral", async () => {
  const blob = await vi.importActual<typeof import("~/features/crm/collateral/service/blob")>(
    "~/features/crm/collateral/service/blob",
  );
  const library = await vi.importActual<typeof import("~/features/crm/collateral/service/library")>(
    "~/features/crm/collateral/service/library",
  );
  return {
    ...blob,
    ...library,
    uploadCollateralFile: (file: File | null) =>
      blob.uploadCollateralFile(file, {
        put: (async (path: string) => ({
          url: `https://blob.test/${path}`,
          pathname: path,
          contentType: "application/pdf",
        })) as never,
        now: () => new Date("2026-09-13T18:00:00.000Z"),
      }),
    deleteCollateralFile: async (url: string) => {
      bag.deleted.push(url);
      return true;
    },
    createCollateral: async (input: unknown) => {
      if (bag.createThrows) throw new Error("neon is having a moment");
      bag.created.push(input);
      return { id: "12", title: (input as { title: string }).title };
    },
  };
});

const { POST } = await import("./route");

const STATIC = "static-admin-token-for-tests";
const URL_UPLOAD = "http://localhost:3000/api/admin/crm/collateral/upload";

function session(roles: string[], email = "eric@headpinz.com") {
  return { user: { email, name: "Eric" }, roles, sub: "oid", expires: "2026-09-14T00:00:00.000Z" };
}

/**
 * A REAL `File` — the route checks `raw instanceof File` before it trusts the
 * form field, so a duck-typed stand-in would be read as "no file" and every
 * case below would pass for the wrong reason. Only `size` is faked, so a
 * 40 MB refusal does not need 40 MB.
 */
function pdf(name = "Pricing.pdf", size = 317_440): File {
  const file = new File([new Uint8Array(8)], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/**
 * A request whose `formData()` is counted, so "the token is checked before the
 * body is read" is an assertion and not a comment.
 */
function upload(
  fields: Record<string, unknown>,
  headers: Record<string, string> = { "x-admin-token": STATIC },
): NextRequest {
  const req = new NextRequest(URL_UPLOAD, { method: "POST", headers });
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) form.set(k, v as string);
  }
  Object.defineProperty(req, "formData", {
    value: async () => {
      bag.formDataCalls += 1;
      return form;
    },
  });
  return req;
}

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_TESTTOKEN";
  delete process.env.ADMIN_API_SIGNING_SECRET;
  delete process.env.ADMIN_PROXY_KEY;
  bag.session = session(["access", "sales-director"]);
  bag.created = [];
  bag.deleted = [];
  bag.audits = [];
  bag.createThrows = false;
  bag.formDataCalls = 0;
});

afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  vi.restoreAllMocks();
});

describe("the credential", () => {
  it("answers the gate's own 404 body when there is none", async () => {
    const res = await POST(upload({ file: pdf() }, {}));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.text()).toBe('{"error":"Not found"}');
    expect(bag.formDataCalls).toBe(0);
  });

  it("answers the same 404 for a wrong one", async () => {
    const res = await POST(upload({ file: pdf() }, { "x-admin-token": "nope" }));
    expect(res.status).toBe(404);
  });
});

describe("the session", () => {
  it("401s when the credential is valid but nobody is signed in", async () => {
    bag.session = null;
    const res = await POST(upload({ file: pdf() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "session" });
    expect(bag.formDataCalls).toBe(0);
  });

  it("403s a signed-in user with no sales role at all", async () => {
    bag.session = session(["access"]);
    const res = await POST(upload({ file: pdf() }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "session" });
  });

  it("403s a REP: reps share, directors curate", async () => {
    bag.session = session(["access", "sales"], "kelsea@headpinz.com");
    const res = await POST(upload({ file: pdf() }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "director_only" });
    expect(bag.created).toHaveLength(0);
  });
});

describe("without a Blob token", () => {
  it("503s blob_not_configured BEFORE reading the body", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const res = await POST(upload({ file: pdf() }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "blob_not_configured" });
    expect(bag.formDataCalls).toBe(0);
    expect(bag.created).toHaveLength(0);
  });
});

describe("the file", () => {
  it("413s an oversize file", async () => {
    const res = await POST(upload({ file: pdf("huge.pdf", 40 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "file_too_big" });
  });

  it("415s a kind we will not serve to a guest", async () => {
    const res = await POST(upload({ file: pdf("page.html", 900) }));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "unsupported_file_type" });
  });

  it("400s when there is no file in the form", async () => {
    const res = await POST(upload({ title: "Nothing" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_file" });
  });
});

describe("a good upload", () => {
  it("stores the file, writes the row with the SIGNED-IN actor, and audits it", async () => {
    const res = await POST(
      upload({
        file: pdf(),
        title: "Group Pricing HPFM 2026",
        centre: "HPFM",
        tags: "pricing, holiday",
        validUntil: "2026-12-31",
        validFrom: "not-a-date",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, item: { id: "12" } });
    expect(bag.created[0]).toMatchObject({
      title: "Group Pricing HPFM 2026",
      centre: "HPFM",
      type: "PDF",
      tags: ["pricing", "holiday"],
      validUntil: "2026-12-31",
      // A malformed date is dropped rather than stored or 400d.
      validFrom: null,
      uploadedBy: "eric@headpinz.com",
      sizeBytes: 317_440,
    });
    expect(bag.audits[0]).toMatchObject({
      entity: "collateral",
      action: "upload",
      actorEmail: "eric@headpinz.com",
    });
    expect(bag.deleted).toEqual([]);
  });

  it("ignores a centre the form made up", async () => {
    await POST(upload({ file: pdf(), centre: "HPXX" }));
    expect(bag.created[0]).toMatchObject({ centre: null });
  });
});

describe("when Neon fails after the bytes are stored", () => {
  it("deletes the object rather than leaving a public orphan, and says 500 once", async () => {
    bag.createThrows = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(upload({ file: pdf() }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "unexpected" });
    expect(bag.deleted).toEqual(["https://blob.test/crm/collateral/2026-09-13/pricing.pdf"]);
    expect(logged).toHaveBeenCalled();
  });

  it("does not try to delete anything when the refusal came before the put", async () => {
    const res = await POST(upload({ file: pdf("page.html", 900) }));
    expect(res.status).toBe(415);
    expect(bag.deleted).toEqual([]);
  });
});
