import { describe, expect, it } from "vitest";
import { GF_STATUS_META } from "../../core/types";
import {
  ATTENTION_SQL,
  CLOSED_FOR_ATTENTION,
  attentionReasons,
  attentionTone,
  pastUnpaidDayof,
  type AttentionInput,
} from "./attention";

/**
 * `attentionReasons` against the prototype's own eight branches
 * (crm-events.js:192-201), at a FIXED clock — the runner is UTC in CI and
 * "days out" is an ET calendar count, so a test that reads the wall clock
 * would pass in Florida and fail in London.
 */
const NOW = new Date("2026-09-13T16:30:00.000Z"); // 12:30 ET, Sun 13 Sep 2026

const base: AttentionInput = {
  status: "contract_sent",
  eventDate: "2026-11-20",
  sentAt: "2026-09-12T13:00:00.000Z",
  balanceCents: 0,
  createdAt: "2026-09-01T13:00:00.000Z",
  dayofOrderId: null,
  settledOrderId: null,
};

const row = (patch: Partial<AttentionInput>): AttentionInput => ({ ...base, ...patch });

describe("attentionReasons — the prototype's eight branches, verbatim copy", () => {
  it("pending_approval counts the days since the row was parked", () => {
    const reasons = attentionReasons(
      row({ status: "pending_approval", createdAt: "2026-09-03T13:00:00.000Z" }),
      NOW,
    );
    expect(reasons).toEqual([{ t: "awaiting approval 10 d", k: "warn" }]);
  });

  it("a contract out more than two days is 'unsigned N d'", () => {
    const reasons = attentionReasons(
      row({ sentAt: "2026-09-08T13:00:00.000Z", eventDate: "2026-11-20" }),
      NOW,
    );
    expect(reasons).toEqual([{ t: "unsigned 5 d", k: "warn" }]);
  });

  it("sent yesterday, event far away — nothing to do", () => {
    expect(attentionReasons(row({ sentAt: "2026-09-12T13:00:00.000Z" }), NOW)).toEqual([]);
  });

  it("unsigned with the event a week out is CRIT, and both reasons can stack", () => {
    const reasons = attentionReasons(
      row({ sentAt: "2026-09-01T13:00:00.000Z", eventDate: "2026-09-18" }),
      NOW,
    );
    expect(reasons).toEqual([
      { t: "unsigned 12 d", k: "warn" },
      { t: "event in 5 d, unsigned", k: "crit" },
    ]);
    expect(attentionTone(reasons)).toBe("crit");
  });

  it("resign_required and balance_link_sent each speak for themselves", () => {
    expect(attentionReasons(row({ status: "resign_required" }), NOW)).toEqual([
      { t: "needs re-sign", k: "crit" },
    ]);
    expect(attentionReasons(row({ status: "balance_link_sent" }), NOW)).toEqual([
      { t: "payment link outstanding", k: "warn" },
    ]);
  });

  it("deposit_paid inside three days with a balance still owing is crit", () => {
    expect(
      attentionReasons(
        row({ status: "deposit_paid", eventDate: "2026-09-15", balanceCents: 100_375 }),
        NOW,
      ),
    ).toEqual([{ t: "balance not yet charged", k: "crit" }]);
    // Balance already settled — nothing to chase.
    expect(
      attentionReasons(
        row({ status: "deposit_paid", eventDate: "2026-09-15", balanceCents: 0 }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("an unsettled day-of order on a past event beats 'event passed, not closed'", () => {
    const r = row({
      status: "balance_charged",
      eventDate: "2026-09-08",
      dayofOrderId: "sq-1",
      settledOrderId: null,
    });
    expect(pastUnpaidDayof(r, NOW)).toBe(true);
    expect(attentionReasons(r, NOW)).toEqual([{ t: "day-of order still open", k: "crit" }]);
  });

  it("a past event that is still OWED money says so, and names the amount", () => {
    const reasons = attentionReasons(
      row({ status: "deposit_paid", eventDate: "2026-09-08", balanceCents: 144_700 }),
      NOW,
    );
    // The deposit_paid branch fires too (past is within "3 days out"), which is
    // correct — what matters is that the past-event reason survives and states
    // the figure, so a planner sees the money without opening the row.
    expect(reasons).toContainEqual({ t: "event passed, $1,447 still owed", k: "crit" });
  });

  it("a past event that is SETTLED is quiet — EVERY reason, not just the last one", () => {
    // The owner's 2026-09-13 list: 14 past events flagged, 12 at a zero balance
    // whose status simply never moved to completed after the event ran. Their
    // reasons COMPOUNDED — one row read "unsigned 107 d · event in -105 d,
    // unsigned · event passed, not closed" — so silencing only the last branch
    // would have left two alarms on a job that finished in June.
    for (const status of ["deposit_paid", "contract_sent", "pending"] as const) {
      expect(
        attentionReasons(
          row({
            status,
            eventDate: "2026-06-12",
            balanceCents: 0,
            // Sent long enough ago to trip the "unsigned N d" branch as well.
            sentAt: "2026-02-25T12:00:00.000Z",
          }),
          NOW,
        ),
        status,
      ).toEqual([]);
    }
  });

  it("a settled past event with an OPEN day-of order still surfaces", () => {
    // The day-of branch is independent of the balance, so closing this hole
    // must not close that one.
    const reasons = attentionReasons(
      row({
        status: "deposit_paid",
        eventDate: "2026-09-08",
        balanceCents: 0,
        dayofOrderId: "ord_1",
        settledOrderId: null,
      }),
      NOW,
    );
    expect(reasons).toEqual([{ t: "day-of order still open", k: "crit" }]);
  });

  it("a completed past event is quiet — and a settled day-of order is too", () => {
    for (const status of CLOSED_FOR_ATTENTION) {
      expect(attentionReasons(row({ status, eventDate: "2026-09-08" }), NOW), status).toEqual([]);
    }
    expect(
      attentionReasons(
        row({
          status: "completed",
          eventDate: "2026-09-08",
          dayofOrderId: "sq-1",
          settledOrderId: "sq-2",
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("attentionTone: crit beats warn, and nothing is null", () => {
    expect(attentionTone([])).toBeNull();
    expect(attentionTone([{ t: "x", k: "warn" }])).toBe("warn");
    expect(
      attentionTone([
        { t: "x", k: "warn" },
        { t: "y", k: "crit" },
      ]),
    ).toBe("crit");
  });
});

describe("ATTENTION_SQL mirrors the TypeScript branch for branch", () => {
  it("names every predicate the function implements, and only $1 / $2", () => {
    for (const fragment of [
      "status = 'pending_approval'",
      "contract_sent_at < $2::timestamptz",
      "event_date <= ($1::date + 7)",
      "status = 'resign_required'",
      "status = 'balance_link_sent'",
      "balance_cents > 0",
      "square_settled_order_id IS NULL",
      "status NOT IN ('completed','cancelled','denied')",
    ]) {
      expect(ATTENTION_SQL).toContain(fragment);
    }
    // Only the two bound parameters the caller promises to supply.
    expect([...new Set([...ATTENTION_SQL.matchAll(/\$\d+/g)].map((m) => m[0]))].sort()).toEqual([
      "$1",
      "$2",
    ]);
  });

  it("the three closed statuses agree with the TypeScript list", () => {
    for (const status of CLOSED_FOR_ATTENTION) {
      expect(ATTENTION_SQL).toContain(`'${status}'`);
    }
  });
});

describe("the label table (crm-events.js:9-21)", () => {
  it("balance_charged is 'Balance funded', never 'Fully Paid'", () => {
    expect(GF_STATUS_META.balance_charged.label).toBe("Balance funded");
    expect(GF_STATUS_META.balance_charged.kind).toBe("won");
    expect(GF_STATUS_META.pending_approval.label).toBe("Needs approval");
    expect(GF_STATUS_META.resign_required.label).toBe("Re-sign required");
  });
});
