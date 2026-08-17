import { describe, expect, it } from "vitest";
import { reconcileReel, type ExistingClip, type RankedPick } from "./reconcile";

const pick = (videoCode: string, rank: number): RankedPick => ({ videoCode, rank });
const built = (videoCode: string, retiredAtMs: number | null = null): ExistingClip => ({
  videoCode,
  blobUrl: `https://blob.example/pov-reel/${videoCode}.mp4`,
  retiredAtMs,
});
const pending = (videoCode: string): ExistingClip => ({
  videoCode,
  blobUrl: null,
  retiredAtMs: null,
});

describe("reconcileReel", () => {
  it("cuts everything on the first run, when the manifest is empty", () => {
    const plan = reconcileReel([pick("A", 1), pick("B", 2)], []);
    expect(plan.cut).toEqual([
      { videoCode: "A", rank: 1 },
      { videoCode: "B", rank: 2 },
    ]);
    expect(plan.keep).toEqual([]);
    expect(plan.retire).toEqual([]);
    expect(plan.del).toEqual([]);
  });

  it("KEEPS a clip that survived into today's reel — never re-cuts it", () => {
    // The whole reason this module exists: re-cutting all ten nightly would burn
    // ~94MB of uploads and ten VT3 impressions to reproduce yesterday's reel.
    const plan = reconcileReel([pick("A", 1), pick("B", 2)], [built("A"), built("B")]);
    expect(plan.keep).toEqual([
      { videoCode: "A", rank: 1 },
      { videoCode: "B", rank: 2 },
    ]);
    expect(plan.cut).toEqual([]);
  });

  it("keeps a survivor even when its rank moved", () => {
    // Rank is a property of today's ranking, not of the footage — which is why
    // the table is keyed on video_code and not on (week, rank).
    const plan = reconcileReel([pick("B", 1), pick("A", 2)], [built("A"), built("B")]);
    expect(plan.cut).toEqual([]);
    expect(plan.keep).toEqual([
      { videoCode: "B", rank: 1 },
      { videoCode: "A", rank: 2 },
    ]);
  });

  it("RETIRES a dropped clip but does NOT delete it on the same run", () => {
    // A wall may be mid-loop on that blob and del() is immediate.
    const plan = reconcileReel([pick("A", 1)], [built("A"), built("B")]);
    expect(plan.retire).toEqual(["B"]);
    expect(plan.del).toEqual([]);
  });

  it("deletes a clip that was already retired on a previous run", () => {
    const plan = reconcileReel([pick("A", 1)], [built("A"), built("B", 1_760_000_000_000)]);
    expect(plan.del).toEqual(["B"]);
    expect(plan.retire).toEqual([]);
  });

  it("runs the full two-run retirement across consecutive runs", () => {
    let manifest: ExistingClip[] = [built("A"), built("B")];

    // Run 1 — B drops out. Retired, blob still alive.
    const run1 = reconcileReel([pick("A", 1)], manifest);
    expect(run1.retire).toEqual(["B"]);
    expect(run1.del).toEqual([]);
    manifest = [built("A"), built("B", 1_760_000_000_000)];

    // Run 2 — B still out. Now it goes.
    const run2 = reconcileReel([pick("A", 1)], manifest);
    expect(run2.del).toEqual(["B"]);
    expect(run2.retire).toEqual([]);
  });

  it("un-retires a clip that climbs back into the reel before deletion", () => {
    // The grace run is also a reprieve: a clip that returns must not be deleted,
    // and must not be re-cut either, because its blob was never removed.
    const plan = reconcileReel(
      [pick("A", 1), pick("B", 2)],
      [built("A"), built("B", 1_760_000_000_000)],
    );
    expect(plan.keep).toContainEqual({ videoCode: "B", rank: 2 });
    expect(plan.del).toEqual([]);
    expect(plan.cut).toEqual([]);
  });

  it("re-dispatches a job that was asked for and never reported back", () => {
    // The clipper answers 202 and reports out of band, so a run that died
    // mid-job leaves a row with no blob. Nothing else in the system retries it.
    const plan = reconcileReel([pick("A", 1)], [pending("A")]);
    expect(plan.redispatch).toEqual([{ videoCode: "A", rank: 1 }]);
    expect(plan.keep).toEqual([]);
    expect(plan.cut).toEqual([]);
  });

  it("retires a never-built row that has also dropped out, rather than leaking it", () => {
    const plan = reconcileReel([], [pending("A")]);
    expect(plan.retire).toEqual(["A"]);
    expect(plan.redispatch).toEqual([]);
  });

  it("an empty ranking retires the whole reel rather than deleting it outright", () => {
    const plan = reconcileReel([], [built("A"), built("B")]);
    expect(plan.retire).toEqual(["A", "B"]);
    expect(plan.del).toEqual([]);
  });

  it("is idempotent — replaying the same run changes nothing", () => {
    const manifest = [built("A"), built("B")];
    const first = reconcileReel([pick("A", 1), pick("B", 2)], manifest);
    const second = reconcileReel([pick("A", 1), pick("B", 2)], manifest);
    expect(second).toEqual(first);
    expect(first.cut).toEqual([]);
    expect(first.retire).toEqual([]);
    expect(first.del).toEqual([]);
  });
});
