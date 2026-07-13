import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Query-shape tests for the day-of settlement candidate queries. A combo
 * special puts race + bowling on ONE shared Square day-of order; lane-open
 * owns settling those (combo-specials-plan.md, locked decision #6), so the
 * race query MUST carry the same NOT EXISTS bowling-shares-this-order guard
 * the attraction query has. These tests capture the SQL text through a
 * mocked `sql` tag and assert the guard is present — the semantics run live
 * in the combo e2e.
 */

const queries: string[] = [];

vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join("$?"));
    return Promise.resolve([]);
  };
  return {
    isDbConfigured: () => true,
    sql: () => tag,
  };
});

import {
  getAttractionReservationsAwaitingDayofPay,
  getCheckedInOrdersToComplete,
  getRaceReservationsAwaitingDayofPay,
} from "./bowling-db";

function findSelect(kind: string): string {
  const hit = queries.find(
    (q) => q.trimStart().startsWith("SELECT") && q.includes(`product_kind = '${kind}'`),
  );
  expect(hit, `SELECT for product_kind = '${kind}' was issued`).toBeTruthy();
  return hit!;
}

beforeEach(() => {
  queries.length = 0;
});

describe("day-of settlement candidate queries — bowling-shared-order guard", () => {
  it("race query EXCLUDES orders shared with a bowling/KBF reservation (combo specials)", async () => {
    await getRaceReservationsAwaitingDayofPay();
    const q = findSelect("race");
    expect(q).toContain("NOT EXISTS");
    expect(q).toContain("b.square_dayof_order_id = r.square_dayof_order_id");
    expect(q).toContain("b.product_kind IN ('open', 'kbf')");
  });

  it("race query still requires the settle preconditions", async () => {
    await getRaceReservationsAwaitingDayofPay();
    const q = findSelect("race");
    expect(q).toContain("status = 'confirmed'");
    expect(q).toContain("dayof_order_sent_at IS NULL");
    expect(q).toContain("square_gift_card_id IS NOT NULL");
    expect(q).toContain("square_dayof_order_id IS NOT NULL");
  });

  it("attraction query keeps its guard (regression)", async () => {
    await getAttractionReservationsAwaitingDayofPay();
    const q = findSelect("attraction");
    expect(q).toContain("NOT EXISTS");
    expect(q).toContain("b.product_kind IN ('open', 'kbf')");
  });
});

describe("order-complete candidate query — combo bowling legs included", () => {
  // Combo bowling legs pay at lane-open like regular bowling, but were excluded
  // from the complete sweep waiting on an "own settle flow" that never existed —
  // 45 paid legs sat OPEN until the portal's 2026-07-08 manual sweep. The
  // exclusion must stay gone; unpaid legs are protected downstream by
  // completeOrder's state=OPEN + $0-due re-check.
  it("does NOT exclude combo_special_id rows", async () => {
    await getCheckedInOrdersToComplete();
    const q = queries.find(
      (s) => s.trimStart().startsWith("SELECT") && s.includes("dayof_order_completed_at IS NULL"),
    );
    expect(q, "getCheckedInOrdersToComplete SELECT was issued").toBeTruthy();
    expect(q!).not.toContain("combo_special_id");
  });

  it("keeps the lane-open + session-over gates", async () => {
    await getCheckedInOrdersToComplete();
    const q = queries.find(
      (s) => s.trimStart().startsWith("SELECT") && s.includes("dayof_order_completed_at IS NULL"),
    );
    expect(q!).toContain("dayof_order_sent_at IS NOT NULL OR checkin_method IS NOT NULL");
    expect(q!).toContain("product_kind IN ('open', 'kbf')");
    expect(q!).toContain("INTERVAL '3 hours'");
  });
});
