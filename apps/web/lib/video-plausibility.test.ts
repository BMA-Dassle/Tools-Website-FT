import { describe, it, expect, afterEach, vi } from "vitest";
import {
  estimateCaptureWindow,
  plausibilityVerdict,
  plausibilityEnabled,
  plausiblePreSlackS,
  plausiblePostSlackS,
  plausibleMaxHeatS,
} from "@/lib/video-plausibility";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ms = (iso: string) => new Date(iso).getTime();

describe("estimateCaptureWindow", () => {
  it("derives [created_at − duration, created_at]", () => {
    const w = estimateCaptureWindow("2026-08-09T21:24:22.000Z", 864);
    expect(w).not.toBeNull();
    expect(w!.endMs).toBe(ms("2026-08-09T21:24:22.000Z"));
    expect(w!.startMs).toBe(ms("2026-08-09T21:24:22.000Z") - 864_000);
  });

  it("returns null when duration or created_at is missing/invalid — verdict must stay unknown", () => {
    expect(estimateCaptureWindow(undefined, 864)).toBeNull();
    expect(estimateCaptureWindow("2026-08-09T21:24:22.000Z", undefined)).toBeNull();
    expect(estimateCaptureWindow("2026-08-09T21:24:22.000Z", 0)).toBeNull();
    expect(estimateCaptureWindow("2026-08-09T21:24:22.000Z", -5)).toBeNull();
    expect(estimateCaptureWindow("not-a-date", 864)).toBeNull();
  });
});

describe("rung 1 — actuals known (fixtures = real 8/9 W57384 incident records)", () => {
  // Blue heat 29 actually ran 21:08:48.909Z → 21:22:33.366Z.
  const h29 = { aStartMs: ms("2026-08-09T21:08:48.909Z"), aEndMs: ms("2026-08-09T21:22:33.366Z") };
  // Red heat 17 actually ran 18:26:55.371Z → 18:37:00.873Z.
  const h17 = { aStartMs: ms("2026-08-09T18:26:55.371Z"), aEndMs: ms("2026-08-09T18:37:00.873Z") };
  const scanIrrelevant = ms("2026-08-09T21:01:33.507Z");

  it("passes Hannah Dickinson's true heat-29 video (footage 21:09:58→21:24:22)", () => {
    const capture = estimateCaptureWindow("2026-08-09T21:24:22.000Z", 864);
    const r = plausibilityVerdict(capture, h29, scanIrrelevant);
    expect(r.verdict).toBe("plausible");
    expect(r.ladder).toBe("actuals");
  });

  it("rejects the heat-31 footage that was texted to Adrianna McAdams' h29 slot (footage 21:35:31→21:48:48)", () => {
    const capture = estimateCaptureWindow("2026-08-09T21:48:48.000Z", 797);
    const r = plausibilityVerdict(capture, h29, scanIrrelevant);
    expect(r.verdict).toBe("implausible");
  });

  it("REGRESSION — edge-clip: red-h16 footage vs the h17 scan must fail even though it overlaps h17's staging slack by seconds (Ruben Morales case; bare any-overlap passed this)", () => {
    // Heat-16 footage: 18:07:21 → 18:22:28. h17's padded window opens
    // 18:22:25.371 — a 2.6s overlap that mis-delivered 8 VIP videos.
    const capture = estimateCaptureWindow("2026-08-09T18:22:28.000Z", 907);
    const r = plausibilityVerdict(capture, h17, scanIrrelevant);
    expect(r.verdict).toBe("implausible");
  });

  it("containment clause keeps a long multi-heat recording deliverable (49-min video spanning all of blue h55)", () => {
    // Footage 02:09:17 → 02:58:55 fully contains h55 (02:16:36→02:26:46);
    // its midpoint is OUTSIDE the padded window — midpoint alone would
    // wrongly hold a video that definitely includes the racer's race.
    const h55 = {
      aStartMs: ms("2026-08-10T02:16:36.839Z"),
      aEndMs: ms("2026-08-10T02:26:46.928Z"),
    };
    const capture = estimateCaptureWindow("2026-08-10T02:58:55.000Z", 2978);
    const r = plausibilityVerdict(capture, h55, scanIrrelevant);
    expect(r.verdict).toBe("plausible");
  });
});

describe("rung 2 — actualStart only (actualEnd never stamped)", () => {
  const startOnly = { aStartMs: ms("2026-08-09T21:08:48.000Z") };
  const scanIrrelevant = ms("2026-08-09T21:01:00.000Z");

  it("accepts footage inside aStart + MAX_HEAT", () => {
    const capture = estimateCaptureWindow("2026-08-09T21:24:22.000Z", 864);
    const r = plausibilityVerdict(capture, startOnly, scanIrrelevant);
    expect(r.verdict).toBe("plausible");
    expect(r.ladder).toBe("start-only");
  });

  it("rejects footage from ~an hour later", () => {
    const capture = estimateCaptureWindow("2026-08-09T22:20:00.000Z", 800);
    const r = plausibilityVerdict(capture, startOnly, scanIrrelevant);
    expect(r.verdict).toBe("implausible");
  });
});

describe("rung 3 — scan anchor (no actuals at all)", () => {
  const scanMs = ms("2026-08-09T21:01:33.507Z");

  it("accepts footage shortly after the scan", () => {
    const capture = estimateCaptureWindow("2026-08-09T21:24:22.000Z", 864);
    const r = plausibilityVerdict(capture, null, scanMs);
    expect(r.verdict).toBe("plausible");
    expect(r.ladder).toBe("scan-anchor");
  });

  it("rejects footage captured well over MAX_HEAT after the scan", () => {
    const capture = estimateCaptureWindow("2026-08-09T23:10:00.000Z", 800);
    const r = plausibilityVerdict(capture, null, scanMs);
    expect(r.verdict).toBe("implausible");
  });

  it("refuses to guess on a garbage anchor — unknown, never implausible", () => {
    const capture = estimateCaptureWindow("2026-08-09T21:24:22.000Z", 864);
    const r = plausibilityVerdict(capture, null, NaN);
    expect(r.verdict).toBe("unknown");
  });
});

describe("unknown / kill switch / tunables", () => {
  it("no capture window → unknown (no-duration) — matching behaves exactly as pre-gate", () => {
    const r = plausibilityVerdict(null, { aStartMs: 1, aEndMs: 2 }, 1);
    expect(r.verdict).toBe("unknown");
    expect(r.ladder).toBe("no-duration");
  });

  it("VIDEO_MATCH_PLAUSIBLE=false kills the gate (house rule: kill switch only, default ON)", () => {
    expect(plausibilityEnabled()).toBe(true);
    vi.stubEnv("VIDEO_MATCH_PLAUSIBLE", "false");
    expect(plausibilityEnabled()).toBe(false);
  });

  it("slack tunables read env with sane fallbacks", () => {
    expect(plausiblePreSlackS()).toBe(270);
    expect(plausiblePostSlackS()).toBe(210);
    expect(plausibleMaxHeatS()).toBe(1500);
    vi.stubEnv("VIDEO_PLAUSIBLE_PRE_S", "300");
    vi.stubEnv("VIDEO_PLAUSIBLE_POST_S", "garbage");
    vi.stubEnv("VIDEO_PLAUSIBLE_MAX_HEAT_S", "-9");
    expect(plausiblePreSlackS()).toBe(300);
    expect(plausiblePostSlackS()).toBe(210);
    expect(plausibleMaxHeatS()).toBe(1500);
  });

  it("slack widening works end-to-end: a barely-implausible video becomes plausible with a wider POST", () => {
    const h = { aStartMs: ms("2026-08-09T21:00:00.000Z"), aEndMs: ms("2026-08-09T21:12:00.000Z") };
    // Footage midpoint 4 min after aEnd — outside the default 210s POST.
    const capture = estimateCaptureWindow("2026-08-09T21:20:00.000Z", 480);
    expect(plausibilityVerdict(capture, h, 0).verdict).toBe("implausible");
    vi.stubEnv("VIDEO_PLAUSIBLE_POST_S", "300");
    expect(plausibilityVerdict(capture, h, 0).verdict).toBe("plausible");
  });
});
