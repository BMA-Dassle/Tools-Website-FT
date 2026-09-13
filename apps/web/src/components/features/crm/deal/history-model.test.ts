import { describe, expect, it } from "vitest";
import type { CrmActivity } from "~/features/crm/core/types";
import type { ContractHistoryEntry } from "~/features/daily-events/types";
import { HISTORY_ACTIVITY_KINDS, mergeHistory } from "./history-model";

/**
 * The History tab's merge. Pure, so this holds it without rendering React
 * (R12) — and the ordering assertion is the point: the tab's whole job is
 * "what happened to this deal, newest first".
 */

const entry = (patch: Partial<ContractHistoryEntry> = {}): ContractHistoryEntry =>
  ({
    kind: "audit",
    at: "2026-09-10T14:00:00.000Z",
    label: "Contract sent (email + text)",
    detail: null,
    actor: "system",
    ...patch,
  }) as ContractHistoryEntry;

const activity = (patch: Partial<CrmActivity> = {}): CrmActivity =>
  ({
    id: "1",
    leadId: "9",
    contactId: null,
    repId: null,
    actorEmail: "kelsea@headpinz.com",
    kind: "status",
    direction: null,
    occurredAt: "2026-09-11T14:00:00.000Z",
    durationSeconds: null,
    outcome: null,
    subject: null,
    body: "Quote → Contract",
    externalKind: null,
    externalRef: null,
    meta: null,
    ...patch,
  }) as CrmActivity;

describe("mergeHistory", () => {
  it("merges both sources and orders newest first", () => {
    const rows = mergeHistory(
      [
        entry({ at: "2026-09-10T14:00:00.000Z", label: "Contract sent" }),
        entry({ at: "2026-09-12T09:00:00.000Z", label: "Contract signed" }),
      ],
      [activity({ id: "a1", occurredAt: "2026-09-11T14:00:00.000Z", body: "Quote → Contract" })],
    );
    expect(rows.map((r) => r.text)).toEqual([
      "Contract signed",
      "Quote → Contract",
      "Contract sent",
    ]);
  });

  it("a version entry keeps its own kind, so it gets the version icon", () => {
    const rows = mergeHistory([entry({ kind: "version", label: "Contract version 2" })], []);
    expect(rows[0].kind).toBe("version");
    expect(mergeHistory([entry({ kind: "audit" })], [])[0].kind).toBe("contract");
  });

  it("shows money and state activities, and leaves conversation to the Overview timeline", () => {
    const rows = mergeHistory(
      [],
      [
        activity({ id: "1", kind: "payment", body: "Balance charged" }),
        activity({ id: "2", kind: "assign", body: "Assigned to Kelsea" }),
        activity({ id: "3", kind: "bmi", body: "State → Confirmation" }),
        activity({ id: "4", kind: "call", body: "Rang the host" }),
        activity({ id: "5", kind: "sms", body: "Texted the host" }),
        activity({ id: "6", kind: "note", body: "Team mom paying" }),
      ],
    );
    expect(rows.map((r) => r.text)).toEqual([
      "Balance charged",
      "Assigned to Kelsea",
      "State → Confirmation",
    ]);
    for (const k of ["call", "sms", "email", "note", "reachout"]) {
      expect(HISTORY_ACTIVITY_KINDS.has(k)).toBe(false);
    }
  });

  it("an activity with no body falls back to its subject, then to its kind", () => {
    expect(mergeHistory([], [activity({ body: null, subject: "7Hx2Qk" })])[0].text).toBe("7Hx2Qk");
    expect(mergeHistory([], [activity({ body: null, subject: null })])[0].text).toBe("status");
  });

  it("an undated row sorts LAST instead of scrambling the list through NaN", () => {
    const rows = mergeHistory(
      [
        entry({ at: "", label: "Undated" }),
        entry({ at: "2026-09-10T14:00:00.000Z", label: "Older" }),
        entry({ at: "2026-09-12T09:00:00.000Z", label: "Newer" }),
      ],
      [],
    );
    expect(rows.map((r) => r.text)).toEqual(["Newer", "Older", "Undated"]);
  });

  it("keys are unique across the two sources, so React never collapses two rows", () => {
    const rows = mergeHistory(
      [entry({ label: "Contract sent" }), entry({ at: "2026-09-11T10:00:00.000Z" })],
      [activity({ id: "a1" }), activity({ id: "a2" })],
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("carries the signed-PDF link and the collapsed view count through", () => {
    const rows = mergeHistory(
      [entry({ label: "Guest opened the contract page", count: 4, pdfUrl: "https://x/y.pdf" })],
      [],
    );
    expect(rows[0].count).toBe(4);
    expect(rows[0].pdfUrl).toBe("https://x/y.pdf");
  });
});
