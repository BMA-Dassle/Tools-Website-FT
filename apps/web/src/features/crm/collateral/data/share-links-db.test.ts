import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guest path is ONE select and ONE update, and both are asserted at the
 * SQL boundary because the failure modes are invisible from above:
 *
 *   open_count += 1 always        a mail client pre-fetch and a double tap
 *                                 turn "12 opens" into a number nobody trusts,
 *                                 so the UPDATE must be conditional on the
 *                                 viewer-minute key, not the application;
 *   opened_at overwritten         "first opened" is the useful fact; moving it
 *                                 on every open loses it forever;
 *   expiry read in JS only        a revoked link must be `expired_at`-stamped
 *                                 in the row, so every reader agrees;
 *   two queries on the guest path the flyer link is opened on a phone on a
 *                                 kerb, once, and every extra round trip is a
 *                                 chance to fail.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
const env = vi.hoisted(() => ({ configured: true }));
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => env.configured }));

const {
  expireDueShareLinks,
  getShareLinkForOpen,
  insertShareLink,
  mapShareLinkRow,
  recordShareOpen,
  revokeShareLink,
} = await import("./share-links-db");

beforeEach(() => {
  db.reset();
  env.configured = true;
});

const NOW = new Date("2026-09-13T18:00:00.000Z");

describe("getShareLinkForOpen", () => {
  it("fetches the link AND its file in one statement, after the schema is ready", async () => {
    db.respond = () => [];
    await getShareLinkForOpen("tok");

    // `ensureShareLinksSchema` memoises, so the DDL runs once for the module —
    // this first call is where it happens, and it happens BEFORE the read.
    expect(db.matching(/CREATE TABLE IF NOT EXISTS crm_share_links/)).toHaveLength(1);

    const selects = db.matching(/FROM crm_share_links s/);
    expect(selects).toHaveLength(1);
    expect(selects[0].text).toContain("JOIN crm_collateral c");
    expect(selects[0].text).toContain("c.blob_url");
    expect(selects[0].text).toContain("c.archived_at");
    expect(selects[0].params).toEqual(["tok"]);
  });
});

describe("recordShareOpen", () => {
  it("counts an open only when the viewer-minute key changed", async () => {
    db.respond = () => [{ open_count: 3 }];
    const count = await recordShareOpen("tok", "key-abc");

    expect(count).toBe(3);
    const [update] = db.matching(/UPDATE crm_share_links SET/);
    expect(update.text).toContain("last_open_key IS DISTINCT FROM $2");
    expect(update.params).toEqual(["tok", "key-abc"]);
  });

  it("never moves opened_at once it is set, and always moves last_opened_at", async () => {
    db.respond = () => [{ open_count: 1 }];
    await recordShareOpen("tok", "key-abc");

    const [update] = db.matching(/UPDATE crm_share_links SET/);
    expect(update.text).toContain("opened_at = COALESCE(opened_at, NOW())");
    expect(update.text).toContain("last_opened_at = NOW()");
  });
});

describe("expireDueShareLinks / revokeShareLink", () => {
  it("stamps only rows that are due and not already stamped", async () => {
    db.respond = () => [{ token: "a" }, { token: "b" }];
    const n = await expireDueShareLinks(NOW);

    expect(n).toBe(2);
    const [update] = db.matching(/UPDATE crm_share_links SET expired_at/);
    expect(update.text).toContain("expired_at IS NULL");
    expect(update.text).toContain("expires_at < $1");
    expect(update.params).toEqual([NOW.toISOString()]);
  });

  it("revokes without deleting, so the open history survives", async () => {
    db.respond = () => [{ token: "tok" }];
    expect(await revokeShareLink("tok")).toBe(true);

    const [update] = db.matching(/UPDATE crm_share_links SET expired_at/);
    expect(update.text).toContain("COALESCE(expired_at, NOW())");
    expect(db.matching(/DELETE FROM crm_share_links/)).toHaveLength(0);
  });

  it("reports false for a token that was never minted", async () => {
    db.respond = () => [];
    expect(await revokeShareLink("nope")).toBe(false);
  });
});

describe("insertShareLink", () => {
  it("binds the creator and the expiry", async () => {
    db.respond = (stmt) =>
      /INSERT INTO crm_share_links/.test(stmt.text)
        ? [{ token: "tok", collateral_id: "7", open_count: 0, created_at: NOW.toISOString() }]
        : [];

    await insertShareLink({
      token: "tok",
      collateralId: "7",
      leadId: "1042",
      contactId: null,
      repId: "3",
      channel: "link",
      expiresAt: new Date("2026-10-13T18:00:00.000Z"),
      createdBy: "kelsea@headpinz.com",
    });

    const [insert] = db.matching(/INSERT INTO crm_share_links/);
    expect(insert.params).toEqual([
      "tok",
      "7",
      "1042",
      null,
      "3",
      "link",
      "2026-10-13T18:00:00.000Z",
      "kelsea@headpinz.com",
    ]);
  });
});

describe("mapShareLinkRow", () => {
  it("returns every id as a string and drops a channel we do not recognise", () => {
    const link = mapShareLinkRow(
      {
        token: "tok",
        collateral_id: "7",
        lead_id: "1042",
        contact_id: null,
        rep_id: "3",
        channel: "carrier-pigeon",
        opened_at: null,
        last_opened_at: null,
        open_count: "4",
        expires_at: null,
        expired_at: null,
        created_by: "kelsea@headpinz.com",
        created_at: NOW.toISOString(),
      },
      "https://headpinz.com/api/crm/share/tok",
    );

    expect(link.collateralId).toBe("7");
    expect(link.leadId).toBe("1042");
    expect(link.contactId).toBeNull();
    expect(link.openCount).toBe(4);
    expect(link.channel).toBeNull();
    expect(link.url).toBe("https://headpinz.com/api/crm/share/tok");
  });
});

describe("without DATABASE_URL", () => {
  it("reads answer empty instead of throwing, so a preview still renders", async () => {
    env.configured = false;
    expect(await getShareLinkForOpen("tok")).toBeNull();
    expect(await recordShareOpen("tok", "k")).toBe(0);
    expect(await expireDueShareLinks(NOW)).toBe(0);
    expect(db.statements).toHaveLength(0);
  });
});
