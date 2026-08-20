import { describe, it, expect } from "vitest";
import { summariseScans, type ScanHistoryEntry } from "./scan-history";

/**
 * The summariser is what the panel header shows, and it is the half of this
 * feature that can be wrong without anyone noticing — a percentile off by one
 * index still looks plausible. So it is pinned here rather than trusted.
 */

function entry(over: Partial<ScanHistoryEntry> = {}): ScanHistoryEntry {
  return {
    atMs: 1_787_000_000_000,
    kind: "eticket",
    outcome: "checked-in",
    totalMs: 500,
    ...over,
  };
}

describe("summariseScans", () => {
  it("reports nothing rather than zero for an empty buffer", () => {
    const s = summariseScans([]);
    expect(s.n).toBe(0);
    // NOT 0 — a zero median would read as "instant" on a board that has simply
    // never seen a scan.
    expect(s.medianMs).toBeNull();
    expect(s.p95Ms).toBeNull();
    expect(s.slowestMs).toBeNull();
  });

  it("takes the median of an odd sample", () => {
    const s = summariseScans([100, 200, 900].map((totalMs) => entry({ totalMs })));
    expect(s.n).toBe(3);
    expect(s.medianMs).toBe(200);
    expect(s.slowestMs).toBe(900);
  });

  it("does not let one slow scan drag the middle", () => {
    // Nine fast scans and one 9.2s Pandora timeout: the median must stay in the
    // fast cluster, which is the entire reason the panel shows median not mean.
    const times = [180, 190, 200, 210, 220, 230, 240, 250, 260, 9200];
    const s = summariseScans(times.map((totalMs) => entry({ totalMs })));
    expect(s.medianMs).toBe(220);
    expect(s.slowestMs).toBe(9200);
    // p95 over 10 samples lands on the last element — the outlier IS the tail,
    // and hiding it would defeat the point.
    expect(s.p95Ms).toBe(9200);
  });

  it("EXCLUDES gear look-ups from every number", () => {
    // A dry run costs no racer any time; counting them would let someone make
    // the desk look fast by clicking Look up.
    const s = summariseScans([
      entry({ totalMs: 100 }),
      entry({ totalMs: 5000, dryRun: true }),
      entry({ totalMs: 300 }),
    ]);
    expect(s.n).toBe(2);
    expect(s.slowestMs).toBe(300);
    // NEAREST-RANK, NOT INTERPOLATED. On the two real samples [100, 300] this
    // is 100, not 200. Deliberate: every duration the panel prints is one a
    // real scan actually took, so nobody can be sent chasing a 200ms scan that
    // never happened.
    expect(s.medianMs).toBe(100);
  });

  it("counts outcomes and kinds separately", () => {
    const s = summariseScans([
      entry({ outcome: "checked-in", kind: "eticket" }),
      entry({ outcome: "checked-in", kind: "licence" }),
      entry({ outcome: "already-in", kind: "licence" }),
      entry({ outcome: "not-checking-in", kind: "paper" }),
      entry({ outcome: "checked-in", kind: "licence", dryRun: true }),
    ]);
    expect(s.byOutcome).toEqual({ "checked-in": 2, "already-in": 1, "not-checking-in": 1 });
    expect(s.byKind).toEqual({ eticket: 1, licence: 2, paper: 1 });
  });

  it("keeps `unreadable` out of the timings but counts it", () => {
    // A payload that never parsed is rejected in ~80ms without touching an
    // upstream. If those counted, the median would IMPROVE as a broken scanner
    // sprayed garbage — the reading would get better as the night got worse.
    const s = summariseScans([
      entry({ totalMs: 1800 }),
      entry({ totalMs: 1900 }),
      entry({ totalMs: 84, outcome: "unreadable", detail: "Could not parse barcode data" }),
      entry({ totalMs: 80, outcome: "unreadable" }),
      entry({ totalMs: 78, outcome: "unreadable" }),
    ]);
    expect(s.medianMs).toBe(1800);
    expect(s.slowestMs).toBe(1900);
    // Still visible as what they are.
    expect(s.byOutcome["unreadable"]).toBe(3);
    expect(s.byOutcome["checked-in"]).toBe(2);
    // `n` is every real attempt, unreadable included — the desk made 5 tries.
    expect(s.n).toBe(5);
  });

  it("ignores a row with no usable duration without dropping its counts", () => {
    const s = summariseScans([
      entry({ totalMs: 400 }),
      entry({ totalMs: Number.NaN }),
      entry({ totalMs: -5 }),
    ]);
    // All three are real scans...
    expect(s.byOutcome["checked-in"]).toBe(3);
    // ...but only one has a duration anyone can act on.
    expect(s.medianMs).toBe(400);
    expect(s.slowestMs).toBe(400);
  });
});
