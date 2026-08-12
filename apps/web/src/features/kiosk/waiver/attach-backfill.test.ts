import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/redis", () => ({
  default: { del: vi.fn(async () => 1) },
}));
vi.mock("~/features/daily-events/service", () => ({
  clientKeyForLocation: (loc: number) => (loc === 0 ? null : "headpinzftmyers"),
}));
const joins = { setJoinAttachStatus: vi.fn(async () => {}) };
vi.mock("~/features/kiosk/data/kiosk-waiver-joins-db", () => ({
  setJoinAttachStatus: (...a: unknown[]) =>
    (joins.setJoinAttachStatus as (...a: unknown[]) => Promise<void>)(...a),
}));
const attach = {
  registerProjectPersonServer: vi.fn(async () => ({ ok: true, status: 200, body: "{}" })),
};
vi.mock("./bmi-attach", () => ({
  registerProjectPersonServer: (...a: unknown[]) =>
    (attach.registerProjectPersonServer as (...a: unknown[]) => unknown)(...a),
}));
const orderIds = { resolveAttachOrderId: vi.fn(async () => ({ orderId: "63000000008065143" })) };
vi.mock("./attach-order-id", () => ({
  resolveAttachOrderId: (...a: unknown[]) =>
    (orderIds.resolveAttachOrderId as (...a: unknown[]) => unknown)(...a),
}));
const office = {
  fetchProjectRawIds: vi.fn(async () => ({ projectPersons: [] }) as Record<string, unknown> | null),
  fetchOfficePerson: vi.fn(async () => ({ id: "16331333" }) as Record<string, unknown> | null),
};
vi.mock("@/lib/bmi-office-actions", () => ({
  fetchProjectRawIds: (...a: unknown[]) =>
    (office.fetchProjectRawIds as (...a: unknown[]) => unknown)(...a),
  fetchOfficePerson: (...a: unknown[]) =>
    (office.fetchOfficePerson as (...a: unknown[]) => unknown)(...a),
}));
vi.mock("./cache", () => ({
  rosterCacheKey: (pid: string) => `kiosk:waiver:roster:${pid}`,
}));

import { reattachJoinRows, projectPersonIds } from "./attach-backfill";
import type { KioskWaiverJoinRow } from "~/features/kiosk/data/kiosk-waiver-joins-db";

const joinRow = (over: Partial<KioskWaiverJoinRow> = {}): KioskWaiverJoinRow => ({
  id: 1,
  projectId: "63000000008065144",
  locationId: 5,
  personId: "16331333",
  displayName: "Justin Vazquez",
  firstName: "Justin",
  lastName: "Vazquez",
  kioskId: null,
  bmiAttachStatus: "failed",
  bmiAttachError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("projectPersonIds", () => {
  it("keeps ids as strings and drops null/undefined", () => {
    const set = projectPersonIds({
      projectPersons: [{ personId: "63000000008105288" }, { personId: null }, {}],
    });
    expect(set.has("63000000008105288")).toBe(true);
    expect(set.size).toBe(1);
  });
  it("tolerates a missing/non-array projectPersons", () => {
    expect(projectPersonIds({}).size).toBe(0);
    expect(projectPersonIds({ projectPersons: "nope" }).size).toBe(0);
  });
});

describe("reattachJoinRows safety rules", () => {
  it("RECONCILE FIRST: a person BMI already has is corrected in Neon and never POSTed", async () => {
    office.fetchProjectRawIds.mockResolvedValueOnce({
      projectPersons: [{ personId: "16331333" }],
    });
    const { outcomes } = await reattachJoinRows([joinRow()], { dryRun: false });
    expect(outcomes[0].outcome).toBe("already-on-bmi");
    expect(joins.setJoinAttachStatus).toHaveBeenCalledWith(
      "63000000008065144",
      "16331333",
      "attached",
    );
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
  });

  it("UNREADABLE ≠ EMPTY: an unreadable project skips the row — a transient Office failure can never become a duplicate", async () => {
    office.fetchProjectRawIds.mockResolvedValueOnce(null);
    const { outcomes } = await reattachJoinRows([joinRow()], { dryRun: false });
    expect(outcomes[0].outcome).toBe("skipped-project-unreadable");
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
    expect(joins.setJoinAttachStatus).not.toHaveBeenCalled();
  });

  it("BARRIER A (cron): a person not yet visible on the Office cloud is left for a later tick", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce(null);
    const { outcomes } = await reattachJoinRows([joinRow()], {
      dryRun: false,
      requirePersonVisible: true,
    });
    expect(outcomes[0].outcome).toBe("waiting-person-sync");
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
  });

  it("happy path: visible person, resolvable order → attach lands and Neon is corrected", async () => {
    const { outcomes } = await reattachJoinRows([joinRow()], {
      dryRun: false,
      requirePersonVisible: true,
    });
    expect(outcomes[0].outcome).toBe("attached");
    expect(attach.registerProjectPersonServer).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "63000000008065143", personId: "16331333" }),
    );
    expect(joins.setJoinAttachStatus).toHaveBeenCalledWith(
      "63000000008065144",
      "16331333",
      "attached",
    );
  });

  it("a declared refusal records 'failed' with the body detail", async () => {
    attach.registerProjectPersonServer.mockResolvedValueOnce({
      ok: false,
      status: 200,
      body: '{"success":false,"errorMessage":"nope"}',
    });
    const { outcomes } = await reattachJoinRows([joinRow()], { dryRun: false });
    expect(outcomes[0].outcome).toBe("failed");
    expect(outcomes[0].detail).toContain("success");
    expect(joins.setJoinAttachStatus).toHaveBeenCalledWith(
      "63000000008065144",
      "16331333",
      "failed",
      expect.stringContaining("200"),
    );
  });

  it("dryRun reports would-reattach and writes nothing", async () => {
    const { outcomes } = await reattachJoinRows([joinRow()], { dryRun: true });
    expect(outcomes[0].outcome).toBe("would-reattach");
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
    expect(joins.setJoinAttachStatus).not.toHaveBeenCalled();
  });

  it("no clientKey for the location = skipped, untouched", async () => {
    const { outcomes } = await reattachJoinRows([joinRow({ locationId: 0 })], { dryRun: false });
    expect(outcomes[0].outcome).toBe("skipped-no-clientkey");
  });

  it("the per-project roster read is memoized across a party", async () => {
    office.fetchProjectRawIds.mockResolvedValue({ projectPersons: [] });
    await reattachJoinRows(
      [joinRow({ personId: "1" }), joinRow({ personId: "2" }), joinRow({ personId: "3" })],
      { dryRun: true },
    );
    expect(office.fetchProjectRawIds).toHaveBeenCalledTimes(1);
  });
});
