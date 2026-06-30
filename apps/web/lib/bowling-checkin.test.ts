import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Record every tagged-template SQL call so we can assert the UPDATE shape.
interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];

vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  };
  return { isDbConfigured: () => true, sql: () => tag };
});

import { updateBowlingCheckinMethod, markBowlingCheckedIn } from "./bowling-db";

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

/** The reservation UPDATE is the call that mentions checkin_method/checked_in_at
 *  (the rest are ensureBowlingSchema's ALTER/CREATE statements). */
const findUpdate = () =>
  calls.find(
    (c) => /UPDATE bowling_reservations\s+SET/i.test(c.text) && c.text.includes("checked_in_at"),
  );

describe("updateBowlingCheckinMethod", () => {
  it("sets checkin_method and stamps checked_in_at (COALESCE, first time only)", async () => {
    await updateBowlingCheckinMethod(123, "desk");
    const upd = findUpdate();
    expect(upd).toBeDefined();
    expect(upd!.text).toContain("checkin_method");
    expect(upd!.text).toContain("checked_in_at");
    expect(upd!.text).toContain("COALESCE(checked_in_at, NOW())");
    // params: method, method (CASE guard), id
    expect(upd!.values).toContain("desk");
    expect(upd!.values).toContain(123);
  });

  it("leaves checked_in_at intact when clearing the method (null)", async () => {
    await updateBowlingCheckinMethod(123, null);
    const upd = findUpdate();
    expect(upd!.text).toContain("ELSE checked_in_at");
    expect(upd!.values).toContain(null);
  });
});

describe("markBowlingCheckedIn", () => {
  it("stamps checked_in_at idempotently via COALESCE", async () => {
    await markBowlingCheckedIn(456);
    const upd = calls.find((c) =>
      c.text.includes("checked_in_at = COALESCE(checked_in_at, NOW())"),
    );
    expect(upd).toBeDefined();
    expect(upd!.values).toContain(456);
  });
});
