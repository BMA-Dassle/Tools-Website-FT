import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE DELIVERY RECEIPT, at the SQL boundary.
 *
 * `/api/sms-webhook/vox` (the DR webhook) calls `patchDeliveryStatus` for every
 * callback it receives, CRM text or not. Two things had no coverage at all and
 * both are visible to a rep:
 *
 *   1. the status mapping — `undelivered` / `failed` flip `send_status` to
 *      'failed', so a bubble a rep believes was sent starts saying it was not;
 *   2. the no-match case — most of this webhook's volume is automated traffic
 *      whose ids are not in `crm_sms_messages` at all, and that must be one
 *      indexed UPDATE matching nothing, never an error.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ft/db")>()),
  sql: () => db.q,
  isDbConfigured: () => true,
}));

const { patchDeliveryStatus } = await import("./messages-db");

beforeEach(() => db.reset());

/** The UPDATE, ignoring the schema statements that run before it. */
function patchStatement() {
  return db.matching(/UPDATE crm_sms_messages\s+SET delivery_status/).at(-1);
}

describe("patchDeliveryStatus", () => {
  it("scopes to the vox id AND the provider, and returns the row it matched", async () => {
    db.respond = (stmt) =>
      /SET delivery_status/.test(stmt.text) ? [{ id: "901" }] : ([] as unknown[]);

    const id = await patchDeliveryStatus({
      providerMessageId: "vx_1",
      status: "delivered",
      provider: "vox",
    });

    expect(id).toBe("901");
    const stmt = patchStatement();
    expect(stmt?.params[0]).toBe("vx_1");
    expect(stmt?.params[1]).toBe("delivered");
    expect(stmt?.params[3]).toBe("vox");
  });

  it("'undelivered' and 'failed' turn the row into a FAILED send; anything else leaves a sent row alone", async () => {
    db.respond = (stmt) => (/SET delivery_status/.test(stmt.text) ? [{ id: "901" }] : []);
    await patchDeliveryStatus({ providerMessageId: "vx_1", status: "undelivered" });
    const sql = patchStatement()?.text ?? "";

    // The mapping is IN the statement, so assert the statement.
    expect(sql).toContain("WHEN $2 IN ('undelivered','failed') THEN 'failed'");
    // A row already 'sent' is not demoted by a later 'delivered' callback, and
    // a still-'pending' row is promoted to 'sent'.
    expect(sql).toContain("WHEN send_status = 'pending' THEN 'sent'");
    expect(sql).toContain("ELSE send_status END");
  });

  it("a carrier error is kept, but never clears one we already recorded", async () => {
    db.respond = (stmt) => (/SET delivery_status/.test(stmt.text) ? [{ id: "901" }] : []);
    await patchDeliveryStatus({
      providerMessageId: "vx_1",
      status: "failed",
      error: "Vox failed (21610: unsubscribed recipient)",
    });
    const stmt = patchStatement();
    expect(stmt?.text).toContain("delivery_error = COALESCE($3, delivery_error)");
    expect(stmt?.params[2]).toBe("Vox failed (21610: unsubscribed recipient)");
  });

  it("A NON-CRM VOX ID MATCHES NOTHING AND IS NOT AN ERROR — most callbacks are e-tickets", async () => {
    db.respond = () => [];
    const id = await patchDeliveryStatus({
      providerMessageId: "vx_an_eticket",
      status: "delivered",
      provider: "vox",
    });
    expect(id).toBeNull();
    expect(patchStatement()).toBeDefined();
  });
});
