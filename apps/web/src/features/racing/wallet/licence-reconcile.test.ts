/**
 * The reaper deletes real guests' credentials to stop a monthly bill, so the
 * rule that matters most is what it REFUSES to touch. Every test below is about
 * a way it could wrongly delete a pass someone is still holding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const passkit = vi.fn();
const getBillablePasses = vi.fn();
const recordPassStatus = vi.fn();
const markPassReaped = vi.fn();

class FakePassKitError extends Error {
  constructor(readonly status: number) {
    super(`PassKit ${status}`);
  }
  get isDuplicate() {
    return this.status === 409;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

vi.mock("~/lib/api/passkit", () => ({
  passkit: (...a: unknown[]) => passkit(...a),
  isPassKitConfigured: () => true,
  PassKitError: FakePassKitError,
}));
vi.mock("~/config/passkit", () => ({ PASSKIT_LICENCE: { programId: "PROG", tierId: "licence" } }));
vi.mock("~/features/racing/data/racer-wallet-db", () => ({
  getBillablePasses: (...a: unknown[]) => getBillablePasses(...a),
  recordPassStatus: (...a: unknown[]) => recordPassStatus(...a),
  markPassReaped: (...a: unknown[]) => markPassReaped(...a),
}));

const { reconcileLicencePasses, applyPassEvent } = await import("./licence-reconcile");

const DAY = 24 * 60 * 60 * 1000;
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  personId: "409523",
  memberId: "MEMBER1",
  passStatus: null,
  installedAt: null,
  createdAt: new Date(Date.now() - 30 * DAY), // well past the grace window
  ...over,
});

/** Only the DELETE calls — the sweep also GETs every member. */
const deletes = () => passkit.mock.calls.filter((c) => c[0] === "DELETE");

beforeEach(() => {
  vi.clearAllMocks();
  recordPassStatus.mockResolvedValue(undefined);
  markPassReaped.mockResolvedValue(undefined);
});

function respondWith(status: string | Error) {
  passkit.mockImplementation(async (method: string) => {
    if (method === "GET") {
      if (status instanceof Error) throw status;
      return { passMetaData: { status } };
    }
    return {};
  });
}

describe("reconcileLicencePasses — what it refuses to delete", () => {
  it("NEVER deletes an installed pass", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    respondWith("PASS_INSTALLED");

    const stats = await reconcileLicencePasses();

    expect(stats.installed).toBe(1);
    expect(stats.reaped).toBe(0);
    expect(deletes()).toHaveLength(0);
    expect(markPassReaped).not.toHaveBeenCalled();
  });

  it("NEVER deletes when PassKit fails to answer", async () => {
    // A vendor blip is not evidence a guest removed their pass. Treating an
    // unreadable record as "gone" would empty wallets during an outage.
    getBillablePasses.mockResolvedValue([row()]);
    respondWith(new Error("connection reset"));

    const stats = await reconcileLicencePasses();

    expect(stats.failed).toBe(1);
    expect(deletes()).toHaveLength(0);
  });

  it("NEVER deletes on a status it does not recognise, and reports it", async () => {
    // A new PassKit value landing here must not be read as "not installed" —
    // and silently ignoring it is how a reaper stops working unnoticed.
    getBillablePasses.mockResolvedValue([row()]);
    respondWith("PASS_SOMETHING_NEW");

    const stats = await reconcileLicencePasses();

    expect(deletes()).toHaveLength(0);
    expect(stats.unknown).toContain("PASS_SOMETHING_NEW");
  });

  it("NEVER deletes a never-installed pass inside the grace window", async () => {
    getBillablePasses.mockResolvedValue([row({ createdAt: new Date(Date.now() - 2 * DAY) })]);
    respondWith("PASS_ISSUED");

    const stats = await reconcileLicencePasses();

    expect(stats.awaitingInstall).toBe(1);
    expect(deletes()).toHaveLength(0);
  });

  it("touches nothing at all in dryRun, but still reports the count", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    respondWith("PASS_ISSUED");

    const stats = await reconcileLicencePasses({ dryRun: true });

    expect(stats.reaped).toBe(1);
    expect(deletes()).toHaveLength(0);
    expect(markPassReaped).not.toHaveBeenCalled();
  });
});

describe("reconcileLicencePasses — what it does delete", () => {
  it("reaps a never-installed pass past the grace window", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    respondWith("PASS_ISSUED");

    const stats = await reconcileLicencePasses();

    expect(stats.reaped).toBe(1);
    // The id goes in the BODY — DELETE /members/member/{id} is a 404.
    expect(deletes()[0]).toEqual(["DELETE", "/members/member", { id: "MEMBER1" }]);
    expect(markPassReaped).toHaveBeenCalledWith("409523");
  });

  it("reconciles a record already gone upstream without trying to delete it", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    passkit.mockImplementation(async (method: string) => {
      if (method === "GET") throw new FakePassKitError(404);
      return {};
    });

    await reconcileLicencePasses();

    expect(deletes()).toHaveLength(0);
    // Our side still has to forget it, or every push targets a dead record.
    expect(markPassReaped).toHaveBeenCalledWith("409523");
  });

  it("records the status it saw, so a decision is never made on a guess", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    respondWith("PASS_INSTALLED");

    await reconcileLicencePasses();

    expect(recordPassStatus).toHaveBeenCalledWith("409523", "PASS_INSTALLED");
  });
});

describe("applyPassEvent — the webhook half", () => {
  it("reaps immediately on a removal: the guest already decided", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    passkit.mockResolvedValue({});

    const out = await applyPassEvent("409523", "PASS_DELETED");

    expect(out.reaped).toBe(true);
    expect(deletes()[0]).toEqual(["DELETE", "/members/member", { id: "MEMBER1" }]);
  });

  it("records an install without deleting anything", async () => {
    getBillablePasses.mockResolvedValue([row()]);
    passkit.mockResolvedValue({});

    const out = await applyPassEvent("409523", "PASS_INSTALLED");

    expect(out.recorded).toBe(true);
    expect(out.reaped).toBe(false);
    expect(deletes()).toHaveLength(0);
  });

  it("ignores a non-numeric personId without touching anything", async () => {
    const out = await applyPassEvent("../etc/passwd", "PASS_DELETED");
    expect(out).toEqual({ recorded: false, reaped: false });
    expect(recordPassStatus).not.toHaveBeenCalled();
  });
});
