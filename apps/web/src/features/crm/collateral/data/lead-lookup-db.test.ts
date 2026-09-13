import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The share → lead lookup, asserted at the SQL boundary, because the way this
 * statement failed is invisible from above.
 *
 * It shipped as `WHERE ($2::boolean AND l.id = $1::bigint) OR l.public_id = $1`
 * — ONE parameter used both as a bigint and as text. Postgres fixes a
 * parameter's type from the cast, then refuses `text = bigint` when it plans
 * the second branch, so EVERY share carrying a lead (`POST /share
 * {action:"create", lead}` and `GET /share?lead=`) threw before a link was
 * minted: no `crm_share_links` row, no share counter, no timeline row, and a
 * 500 `unexpected` for the rep. A recording stub cannot catch that — it never
 * plans anything — so what is pinned here is the SHAPE that made it possible:
 * `$1` is never cast to bigint, and the numeric branch has a parameter of its
 * own that is NULL for a public id.
 *
 * The live proof is a `_crm-*.mts` probe running the real statement against
 * Neon with both input forms (R14: a wrapper, never a deliverable), with the
 * old statement as the negative control — it must still fail.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
const env = vi.hoisted(() => ({ configured: true }));
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => env.configured }));

const { findShareLead } = await import("./lead-lookup-db");

beforeEach(() => {
  db.reset();
  env.configured = true;
  db.respond = () => [];
});

describe("findShareLead", () => {
  it("never binds one parameter as both bigint and text", async () => {
    await findShareLead("L-1042");
    const [select] = db.matching(/FROM crm_leads l/);
    expect(select.text).toContain("l.public_id = $1");
    expect(select.text).not.toMatch(/\$1::bigint/);
    expect(select.text).toContain("$2::bigint");
  });

  it("passes a public id as text only — the numeric branch is NULL", async () => {
    await findShareLead("L-1042");
    expect(db.matching(/FROM crm_leads l/)[0].params).toEqual(["L-1042", null]);
  });

  it("passes a numeric id in BOTH parameters, so the id branch can match", async () => {
    await findShareLead("4211");
    expect(db.matching(/FROM crm_leads l/)[0].params).toEqual(["4211", "4211"]);
  });

  it("maps the row to the ref the sheet prints", async () => {
    db.respond = () => [{ id: "4211", public_id: "L-1042" }];
    await expect(findShareLead("L-1042")).resolves.toEqual({
      id: "4211",
      publicId: "L-1042",
      label: "L-1042",
    });
  });

  it("answers null for a lead that is not there, without inventing one", async () => {
    await expect(findShareLead("L-9999")).resolves.toBeNull();
  });

  it("never queries at all for junk, an empty input, or no database", async () => {
    await expect(findShareLead("  ")).resolves.toBeNull();
    await expect(findShareLead("'; DROP TABLE crm_leads --")).resolves.toBeNull();
    env.configured = false;
    await expect(findShareLead("L-1042")).resolves.toBeNull();
    expect(db.matching(/FROM crm_leads l/)).toHaveLength(0);
  });
});
