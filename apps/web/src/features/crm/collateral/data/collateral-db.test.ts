import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two things about the library's reads are worth pinning, and neither is
 * visible from the screen:
 *
 *   OFFSET pagination   the portal's prospects page capped at 500 rows and
 *                       under-reported for a year (brief R10). The cursor here
 *                       is keyset on `(created_at, id)` — a compound
 *                       comparison, not `created_at <` alone, which would drop
 *                       rows uploaded in the same second;
 *   a centre filter     that hides the "All centres" rows would leave Naples
 *                       reps unable to find the holiday menu, which is exactly
 *                       the file every centre shares.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
const env = vi.hoisted(() => ({ configured: true }));
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => env.configured }));

const {
  clampLimit,
  decodeCollateralCursor,
  encodeCollateralCursor,
  listCollateral,
  mapCollateralRow,
  bumpCollateralShares,
  createCollateral,
} = await import("./collateral-db");

beforeEach(() => {
  db.reset();
  env.configured = true;
});

function row(i: number) {
  return {
    id: String(i),
    title: `Flyer ${i}`,
    centre: "HPFM",
    type: "PDF",
    blob_url: `https://blob.test/${i}.pdf`,
    blob_pathname: null,
    content_type: "application/pdf",
    size_bytes: "317440",
    tags: ["pricing"],
    valid_from: null,
    valid_until: null,
    shares: 3,
    uploaded_by: "kelsea@headpinz.com",
    updated_by: null,
    archived_at: null,
    created_at: `2026-09-1${i}T12:00:00.000Z`,
    updated_at: `2026-09-1${i}T12:00:00.000Z`,
  };
}

describe("keyset cursor", () => {
  it("round-trips, and refuses anything it did not mint", () => {
    const cursor = encodeCollateralCursor({ createdAt: "2026-09-13T12:00:00.000Z", id: "42" });
    expect(decodeCollateralCursor(cursor)).toEqual({
      createdAt: "2026-09-13T12:00:00.000Z",
      id: "42",
    });
    expect(decodeCollateralCursor(null)).toBeNull();
    expect(decodeCollateralCursor("not-base64!!")).toBeNull();
    expect(decodeCollateralCursor(Buffer.from("x|y").toString("base64url"))).toBeNull();
  });

  it("caps the page at 200 rows however it is asked (R10)", () => {
    expect(clampLimit(null)).toBe(60);
    expect(clampLimit(1000)).toBe(200);
    expect(clampLimit(0)).toBe(60);
    expect(clampLimit(-5)).toBe(1);
  });
});

describe("listCollateral", () => {
  it("paginates by keyset on (created_at, id) — never OFFSET", async () => {
    db.respond = () => [row(1), row(2)];
    await listCollateral({
      cursor: encodeCollateralCursor({ createdAt: "2026-09-13T12:00:00.000Z", id: "42" }),
      limit: 1,
    });

    const [select] = db.matching(/FROM crm_collateral c/);
    expect(select.text).not.toMatch(/OFFSET/i);
    expect(select.text).toContain("(c.created_at, c.id) < ($6::timestamptz, $7::bigint)");
    expect(select.params[5]).toBe("2026-09-13T12:00:00.000Z");
    expect(select.params[6]).toBe("42");
    // limit + 1, so "is there another page" costs no second query.
    expect(select.params[7]).toBe(2);
  });

  it("hands back a next cursor only when there IS another page", async () => {
    db.respond = () => [row(1), row(2)];
    const two = await listCollateral({ limit: 1 });
    expect(two.items).toHaveLength(1);
    expect(two.nextCursor).not.toBeNull();

    db.reset();
    db.respond = () => [row(1)];
    const one = await listCollateral({ limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).toBeNull();
  });

  it("keeps the every-centre rows visible under a centre filter", async () => {
    db.respond = () => [];
    await listCollateral({ centre: "HPN" });

    const [select] = db.matching(/FROM crm_collateral c/);
    expect(select.text).toContain("c.centre = $2 OR c.centre IS NULL");
    expect(select.params[1]).toBe("HPN");
  });

  it("hides last season's files against the ET day it was given", async () => {
    db.respond = () => [];
    await listCollateral({ hideExpiredBefore: "2026-09-13" });

    const [select] = db.matching(/FROM crm_collateral c/);
    expect(select.text).toContain("c.valid_until IS NULL OR c.valid_until >= $5::date");
    expect(select.params[4]).toBe("2026-09-13");
  });

  it("hides archived rows unless asked", async () => {
    db.respond = () => [];
    await listCollateral({});
    expect(db.matching(/FROM crm_collateral c/)[0].params[0]).toBe(false);

    db.reset();
    db.respond = () => [];
    await listCollateral({ includeArchived: true });
    expect(db.matching(/FROM crm_collateral c/)[0].params[0]).toBe(true);
  });
});

describe("mapCollateralRow", () => {
  it("returns the id as a string and the byte count as a number", () => {
    const item = mapCollateralRow(row(1));
    expect(item.id).toBe("1");
    expect(item.sizeBytes).toBe(317440);
    expect(item.centre).toBe("HPFM");
    expect(item.tags).toEqual(["pricing"]);
  });

  it("falls back rather than trusting a type or centre the database holds", () => {
    const item = mapCollateralRow({ ...row(1), type: "EXE", centre: "HPXX" });
    expect(item.type).toBe("FILE");
    expect(item.centre).toBeNull();
  });
});

describe("writes", () => {
  it("stamps both uploaded_by and updated_by with the actor on create", async () => {
    db.respond = (stmt) => (/INSERT INTO crm_collateral/.test(stmt.text) ? [row(1)] : []);
    await createCollateral({
      title: "Holiday Party Menu 2026",
      centre: null,
      type: "PDF",
      blobUrl: "https://blob.test/menu.pdf",
      blobPathname: "crm/collateral/2026-09-13/menu.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_153_433,
      tags: ["holiday", "menu"],
      validFrom: null,
      validUntil: null,
      uploadedBy: "kelsea@headpinz.com",
    });

    const [insert] = db.matching(/INSERT INTO crm_collateral/);
    expect(insert.text).toContain("uploaded_by, updated_by");
    expect(insert.params[10]).toBe("kelsea@headpinz.com");
  });

  it("bumps the share counter in the database, not by reading and writing back", async () => {
    db.respond = () => [];
    await bumpCollateralShares("7");
    const [update] = db.matching(/UPDATE crm_collateral SET shares/);
    expect(update.text).toContain("shares = shares + 1");
  });
});
