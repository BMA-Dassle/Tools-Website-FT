import { describe, expect, it } from "vitest";
import { installMsw } from "../server";
import { SEVEN_SHIFTS_BASE, sevenShiftsHandlers } from "./sevenshifts";

/** 7shifts transport: the two traps (deleted rows, open shifts) are in the fixture. */

installMsw(...sevenShiftsHandlers);

describe("msw: 7shifts", () => {
  it("GET /shifts — offsets, a published_deleted row and an open shift", async () => {
    const url = `${SEVEN_SHIFTS_BASE}/shifts?location_id=332160&start[gte]=2026-09-12 00:00:00&start[lte]=2026-09-13 04:59:59&limit=500&include_draft=true`;
    const res = (await (await fetch(url)).json()) as {
      data: {
        id: number;
        user_id: number | null;
        start: string;
        deleted: boolean;
        publish_status: string;
      }[];
      meta: { cursor: { next: string | null } };
    };
    expect(res.data).toHaveLength(3);
    expect(res.data[0].start).toBe("2026-09-12T10:00:00-04:00");
    const live = res.data.filter(
      (s) => !(s.deleted === true || s.publish_status.endsWith("_deleted")),
    );
    expect(live.map((s) => s.id)).toEqual([8801234501, 8801234503]);
    expect(live[1].user_id).toBeNull();
    expect(res.meta.cursor.next).toBeNull();
  });

  it("GET /users — id is the join key for crm_reps.seven_shifts_user_id", async () => {
    const res = (await (
      await fetch(`${SEVEN_SHIFTS_BASE}/users?status=active&limit=200`)
    ).json()) as {
      data: { id: number; email: string }[];
    };
    expect(res.data.find((u) => u.email === "kelsea@headpinz.com")?.id).toBe(6543210);
  });
});
