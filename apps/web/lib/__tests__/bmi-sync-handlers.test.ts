import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  backoffSeconds,
  GIVE_UP_MINUTES,
  MAX_ATTEMPTS,
  type SyncQueueRow,
} from "../bmi-sync-queue";

const person = { patchBmiPersonBirthdate: vi.fn() };
vi.mock("@/lib/bmi-person-update", () => ({
  patchBmiPersonBirthdate: (...a: unknown[]) =>
    (person.patchBmiPersonBirthdate as (...a: unknown[]) => unknown)(...a),
}));
const memberships = { addMembership: vi.fn() };
vi.mock("@/lib/pandora-memberships", () => ({
  addMembership: (...a: unknown[]) =>
    (memberships.addMembership as (...a: unknown[]) => unknown)(...a),
}));
const attach = { registerProjectPersonServer: vi.fn() };
vi.mock("~/features/kiosk/waiver/bmi-attach", () => ({
  registerProjectPersonServer: (...a: unknown[]) =>
    (attach.registerProjectPersonServer as (...a: unknown[]) => unknown)(...a),
}));

const waiver = { signWaiverDigital: vi.fn() };
vi.mock("@/lib/waiver-digital", () => ({
  signWaiverDigital: (...a: unknown[]) =>
    (waiver.signWaiverDigital as (...a: unknown[]) => unknown)(...a),
}));

import { SYNC_HANDLERS } from "../bmi-sync-handlers";

const row = (over: Partial<SyncQueueRow> = {}): SyncQueueRow => ({
  id: 1,
  kind: "repair-person-details",
  idempotencyKey: "k1",
  barrier: "person-local",
  barrierRef: "63000000008158427",
  locationId: "LAB52GY480CJF",
  payload: {},
  attempts: 0,
  nextAttemptAt: new Date().toISOString(),
  giveUpAt: null,
  status: "pending",
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resolvedAt: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("backoff + patience budget", () => {
  it("starts near the measured ~19-32s cloud→local person lag and escalates", () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(4)).toBe(120);
  });
  it("caps so a parked-bound row cannot drift into hours between tries", () => {
    expect(backoffSeconds(100)).toBe(600);
  });
  it("a waiver is chased far longer than a person repair", () => {
    expect(GIVE_UP_MINUTES["push-waiver-signature"]).toBeGreaterThan(
      GIVE_UP_MINUTES["repair-person-details"],
    );
  });
  it("MAX_ATTEMPTS is bounded (no 19,114-retry repeats)", () => {
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(50);
  });
});

describe("repair-person-details", () => {
  const h = SYNC_HANDLERS["repair-person-details"];

  it("repairs with the payload's birthdate and forwards contact fields", async () => {
    person.patchBmiPersonBirthdate.mockResolvedValueOnce({ ok: true, status: 200 });
    const r = await h(
      row({
        payload: {
          personId: "63000000008158427",
          birthdate: "1990-01-01",
          email: "a@b.c",
          phone: "2395551234",
          firstName: "Ann",
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(person.patchBmiPersonBirthdate).toHaveBeenCalledWith(
      "63000000008158427",
      "1990-01-01",
      expect.objectContaining({ email: "a@b.c", phone: "2395551234", firstName: "Ann" }),
    );
  });

  it("falls back to barrierRef when payload has no personId", async () => {
    person.patchBmiPersonBirthdate.mockResolvedValueOnce({ ok: true, status: 200 });
    await h(row({ payload: { birthdate: "1990-01-01" } }));
    expect(person.patchBmiPersonBirthdate).toHaveBeenCalledWith(
      "63000000008158427",
      "1990-01-01",
      expect.anything(),
    );
  });

  it("a malformed birthdate is TERMINAL — retrying can never fix it", async () => {
    person.patchBmiPersonBirthdate.mockResolvedValueOnce({
      ok: false,
      status: null,
      error: "birthdate must be YYYY-MM-DD",
    });
    const r = await h(row({ payload: { birthdate: "01/01/1990" } }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
  });

  it("a vendor hiccup is retryable", async () => {
    person.patchBmiPersonBirthdate.mockResolvedValueOnce({ ok: false, status: 503, error: "busy" });
    const r = await h(row({ payload: { birthdate: "1990-01-01" } }));
    expect(r.retry).toBe(true);
  });

  it("no birthdate at all is terminal, not an endless retry", async () => {
    const r = await h(row({ payload: {} }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
    expect(person.patchBmiPersonBirthdate).not.toHaveBeenCalled();
  });
});

describe("add-default-membership", () => {
  const h = SYNC_HANDLERS["add-default-membership"];

  it("grants and reports the membership id", async () => {
    memberships.addMembership.mockResolvedValueOnce("777");
    const r = await h(row({ kind: "add-default-membership", payload: { personId: "1" } }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("777");
  });

  it("a missing membership-kind id is CONFIGURATION → terminal", async () => {
    memberships.addMembership.mockRejectedValueOnce(
      new Error("addMembership: membership-kind id not set (RACE_LICENSE_MEMBERSHIP_KIND_ID)"),
    );
    const r = await h(row({ kind: "add-default-membership", payload: { personId: "1" } }));
    expect(r.retry).toBe(false);
  });

  it("anything else is retryable", async () => {
    memberships.addMembership.mockRejectedValueOnce(new Error("timeout"));
    const r = await h(row({ kind: "add-default-membership", payload: { personId: "1" } }));
    expect(r.retry).toBe(true);
  });
});

describe("attach-project-person", () => {
  const h = SYNC_HANDLERS["attach-project-person"];
  const p = {
    personId: "63000000008163503",
    orderId: "63000000008158422",
    clientKey: "headpinzftmyers",
    firstName: "Ann",
    lastName: "Lee",
  };

  it("attaches on success", async () => {
    attach.registerProjectPersonServer.mockResolvedValueOnce({ ok: true, status: 200, body: "{}" });
    const r = await h(row({ kind: "attach-project-person", barrier: "person-cloud", payload: p }));
    expect(r.ok).toBe(true);
    expect(attach.registerProjectPersonServer).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: p.orderId, personId: p.personId }),
    );
  });

  it("a declared refusal stays RETRYABLE (the reservation may still be settling)", async () => {
    attach.registerProjectPersonServer.mockResolvedValueOnce({
      ok: false,
      status: 200,
      body: '{"success":false,"errorMessage":"Cannot find the reservation"}',
    });
    const r = await h(row({ kind: "attach-project-person", payload: p }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(true);
  });

  it("missing orderId/clientKey is terminal — no blind POST", async () => {
    const noOrder = await h(
      row({ kind: "attach-project-person", payload: { personId: "1", clientKey: "x" } }),
    );
    expect(noOrder.retry).toBe(false);
    const noCk = await h(
      row({ kind: "attach-project-person", payload: { personId: "1", orderId: "2" } }),
    );
    expect(noCk.retry).toBe(false);
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
  });

  it("a throw is retryable, never a silent success", async () => {
    attach.registerProjectPersonServer.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await h(row({ kind: "attach-project-person", payload: p }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(true);
  });
});

describe("push-waiver-signature", () => {
  const h = SYNC_HANDLERS["push-waiver-signature"];
  const p = { personId: "63000000008163503", name: "Ann Lee", locationKey: "fasttrax" };

  it("pushes the record and reports the waiverID", async () => {
    waiver.signWaiverDigital.mockResolvedValueOnce({ ok: true, waiverID: "W-1" });
    const r = await h(row({ kind: "push-waiver-signature", payload: p }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("W-1");
  });

  it("rehydrates the drawn signature PNG from base64 and always sets skipIfValid", async () => {
    waiver.signWaiverDigital.mockResolvedValueOnce({ ok: true, waiverID: "W-2" });
    const b64 = Buffer.from("not-really-a-png").toString("base64");
    await h(row({ kind: "push-waiver-signature", payload: { ...p, signaturePngB64: b64 } }));
    const arg = waiver.signWaiverDigital.mock.calls[0][0] as {
      pngBuffer?: Buffer;
      skipIfValid?: boolean;
    };
    expect(Buffer.isBuffer(arg.pngBuffer)).toBe(true);
    expect(arg.pngBuffer?.toString()).toBe("not-really-a-png");
    // Never shorten an existing longer expiry by re-pushing.
    expect(arg.skipIfValid).toBe(true);
  });

  it("an already-valid waiver counts as DONE, not a failure", async () => {
    waiver.signWaiverDigital.mockResolvedValueOnce({ ok: true, waiverID: "", skipped: true });
    const r = await h(row({ kind: "push-waiver-signature", payload: p }));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/skipped/i);
  });

  it("a throw (signWaiverDigital's success:false guard) is retryable", async () => {
    waiver.signWaiverDigital.mockRejectedValueOnce(new Error("BMI said success:false"));
    const r = await h(row({ kind: "push-waiver-signature", payload: p }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(true);
  });

  it("missing name is terminal — the vendor call requires it", async () => {
    const r = await h(row({ kind: "push-waiver-signature", payload: { personId: "1" } }));
    expect(r.retry).toBe(false);
    expect(waiver.signWaiverDigital).not.toHaveBeenCalled();
  });
});

describe("handler contract", () => {
  it("every SyncKind has a handler", () => {
    for (const k of [
      "repair-person-details",
      "push-waiver-signature",
      "add-default-membership",
      "attach-project-person",
    ] as const) {
      expect(typeof SYNC_HANDLERS[k]).toBe("function");
    }
  });

  it("no handler throws on an empty payload — they return a verdict", async () => {
    for (const [kind, h] of Object.entries(SYNC_HANDLERS)) {
      const r = await h(row({ kind: kind as SyncQueueRow["kind"], payload: {}, barrierRef: null }));
      expect(r.ok, `${kind} should not claim success on an empty payload`).toBe(false);
      expect(typeof r.detail).toBe("string");
    }
  });
});
