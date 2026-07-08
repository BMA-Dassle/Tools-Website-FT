import { afterEach, describe, expect, it } from "vitest";
import { listAdminActions, recordAdminAction } from "./audit";

const savedUrl = process.env.DATABASE_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});

describe("audit — unconfigured/degraded behavior", () => {
  it("recordAdminAction never throws without DATABASE_URL (best-effort)", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      recordAdminAction({
        reservationId: 1,
        action: "resend",
        outcome: "success",
        detail: { channel: "both" },
      }),
    ).resolves.toBeUndefined();
  });

  it("listAdminActions returns [] without DATABASE_URL or with no ids", async () => {
    delete process.env.DATABASE_URL;
    expect(await listAdminActions([1, 2])).toEqual([]);
    process.env.DATABASE_URL = "postgres://invalid";
    expect(await listAdminActions([])).toEqual([]);
  });
});
