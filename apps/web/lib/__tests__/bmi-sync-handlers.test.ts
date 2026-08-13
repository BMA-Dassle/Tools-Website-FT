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
const office = {
  fetchOfficePerson: vi.fn<(id: string) => Promise<Record<string, unknown> | null>>(),
};
vi.mock("@/lib/bmi-office-actions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchOfficePerson: (...a: unknown[]) =>
    (office.fetchOfficePerson as (...a: unknown[]) => unknown)(...a),
}));
const memberships = { addMembership: vi.fn() };
vi.mock("@/lib/pandora-memberships", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
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
  reservationRef: null,
  payload: {},
  attempts: 0,
  nextAttemptAt: new Date().toISOString(),
  giveUpAt: null,
  status: "pending",
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resolvedAt: null,
  // null = the cron picked this row up, which is what every fixture here
  // predating the push rail describes.
  pushTransport: null,
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

  /**
   * The mint enqueues this repair BECAUSE it had no birthdate, so parking on
   * "nothing to repair with" made the row a guaranteed dead end (live: Leland
   * Frazier …163540 sat parked 3h). Office is asked first.
   */
  it("with no birthdate in the payload it takes the DOB from Office and repairs", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ birthDate: "2012-04-06T00:00:00" });
    person.patchBmiPersonBirthdate.mockResolvedValueOnce({ ok: true, status: 200 });
    const r = await h(row({ payload: { personId: "63000000008163538" } }));
    expect(r.ok).toBe(true);
    expect(person.patchBmiPersonBirthdate).toHaveBeenCalledWith(
      "63000000008163538",
      "2012-04-06",
      expect.anything(),
    );
  });

  it("no DOB in Office either → terminal, with a message a HUMAN can act on", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ birthDate: null });
    const r = await h(row({ payload: { personId: "63000000008163540" } }));
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
    // Names the consequence, the fix, and the usual cause — not just "can't".
    expect(r.detail).toMatch(/500/);
    expect(r.detail).toMatch(/add a birth date/i);
    expect(r.detail).toMatch(/duplicate/i);
    expect(person.patchBmiPersonBirthdate).not.toHaveBeenCalled();
  });
});

describe("add-membership", () => {
  const h = SYNC_HANDLERS["add-membership"];

  it("grants and reports the membership id", async () => {
    memberships.addMembership.mockResolvedValueOnce("777");
    const r = await h(row({ kind: "add-membership", payload: { personId: "1" } }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("777");
  });

  /**
   * The load-bearing test. Owner 2026-08-12: "use default registration for
   * everyone, not license — license is taken care of with the BMI product."
   * addMembership's OWN default is the licence (11260957), so a handler that
   * simply omitted the kind would hand a paid entitlement to everyone who
   * checks in. It must pass Customer Registration explicitly.
   */
  it("defaults to Customer Registration (479317), NOT License Fee (11260957)", async () => {
    memberships.addMembership.mockResolvedValueOnce("778");
    await h(row({ kind: "add-membership", payload: { personId: "1" } }));
    const arg = memberships.addMembership.mock.calls[0][0] as { membershipKindId?: string };
    expect(arg.membershipKindId).toBe("479317");
    expect(arg.membershipKindId).not.toBe("11260957");
  });

  it("still honours an explicit kind when a caller names one", async () => {
    memberships.addMembership.mockResolvedValueOnce("779");
    await h(
      row({ kind: "add-membership", payload: { personId: "1", membershipKindId: "12213012" } }),
    );
    const arg = memberships.addMembership.mock.calls[0][0] as { membershipKindId?: string };
    expect(arg.membershipKindId).toBe("12213012");
  });

  it("a missing membership-kind id is CONFIGURATION → terminal", async () => {
    memberships.addMembership.mockRejectedValueOnce(
      new Error("addMembership: membership-kind id not set (RACE_LICENSE_MEMBERSHIP_KIND_ID)"),
    );
    const r = await h(row({ kind: "add-membership", payload: { personId: "1" } }));
    expect(r.retry).toBe(false);
  });

  /**
   * The 2026-08-12 Naples incident, as a test. Membership kinds are CLIENT-KEY
   * SCOPED: "Customer Registration" is 479317 at headpinzftmyers and 84079 at
   * headpinznaples. Eight Naples grants were queued with Fort Myers' id, and
   * Pandora refused all eight ("No membership found with that ID") six times
   * each. A per-center id is the fix; a same-id-everywhere handler is the bug.
   */
  it("sends NAPLES its own registration kind (84079), not Fort Myers' 479317", async () => {
    memberships.addMembership.mockResolvedValueOnce("780");
    await h(
      row({
        kind: "add-membership",
        locationId: "PPTR5G2N0QXF7",
        payload: { personId: "63000000000906317" },
      }),
    );
    const arg = memberships.addMembership.mock.calls[0][0] as { membershipKindId?: string };
    expect(arg.membershipKindId).toBe("84079");
    expect(arg.membershipKindId).not.toBe("479317");
  });

  it("both Fort Myers centers share the headpinzftmyers kind", async () => {
    memberships.addMembership.mockResolvedValueOnce("781");
    await h(
      row({ kind: "add-membership", locationId: "TXBSQN0FEKQ11", payload: { personId: "1" } }),
    );
    const arg = memberships.addMembership.mock.calls[0][0] as { membershipKindId?: string };
    expect(arg.membershipKindId).toBe("479317");
  });

  /** An unmapped center must NOT silently borrow Fort Myers' id — that is the
   *  exact silent-default that produced the stuck rows. Park it instead. */
  it("an UNKNOWN center parks instead of guessing a kind", async () => {
    const r = await h(
      row({ kind: "add-membership", locationId: "ZZNOTACENTER", payload: { personId: "1" } }),
    );
    expect(r.retry).toBe(false);
    expect(r.detail).toContain("per-BMI-client-key");
    expect(memberships.addMembership).not.toHaveBeenCalled();
  });

  /** Pandora refusing the kind is configuration too — every retry refuses
   *  identically, so burning 40 attempts only hides the real message. */
  it("'No membership found with that ID' is TERMINAL, and names the kind sent", async () => {
    memberships.addMembership.mockRejectedValueOnce(
      new Error("Pandora addMembership failed: No membership found with that ID."),
    );
    const r = await h(
      row({
        kind: "add-membership",
        locationId: "PPTR5G2N0QXF7",
        payload: { personId: "1" },
      }),
    );
    expect(r.retry).toBe(false);
    expect(r.detail).toContain("84079");
    expect(r.detail).toContain("PPTR5G2N0QXF7");
  });

  it("anything else is retryable", async () => {
    memberships.addMembership.mockRejectedValueOnce(new Error("timeout"));
    const r = await h(row({ kind: "add-membership", payload: { personId: "1" } }));
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
      "add-membership",
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
