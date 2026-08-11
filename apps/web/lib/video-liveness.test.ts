import { describe, it, expect, afterEach, vi } from "vitest";
import {
  footageWindow,
  isWrongWindow,
  sweepWrongWindow,
  sweepSilentScans,
  sweepZeroScanHeats,
  radioMessages,
  alertEmailHtml,
  livenessEnabled,
  livenessRadioEnabled,
  type HeatWindowInfo,
} from "@/lib/video-liveness";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ms = (iso: string) => new Date(iso).getTime();

// Blue h44 on 8/9 (Garry Cooley's heat): actually ran 23:56:55Z → 00:07:31Z.
const h44: HeatWindowInfo = {
  sessionId: "58015732",
  label: "Blue h44",
  aStartMs: ms("2026-08-09T23:56:55.623Z"),
  aEndMs: ms("2026-08-10T00:07:31.848Z"),
};
const windows = new Map([[h44.sessionId, h44]]);

describe("isWrongWindow (fixtures = real 8/9–8/10 records)", () => {
  it("flags the h48/49 footage that was texted to Garry Cooley (9ZMENGUQY9)", () => {
    // Docked 01:09:32Z 8/10, 887s → footage ≈ 00:54–01:09 ET+4, an hour after h44.
    const win = footageWindow("2026-08-10T01:09:32.000Z", 887)!;
    expect(isWrongWindow(win, h44.aStartMs!, h44.aEndMs!)).toBe(true);
  });

  it("passes his REAL video (JFFHRWMM6B — cam 79's clip sitting on the wrong slot)", () => {
    const win = footageWindow("2026-08-10T00:11:00.000Z", 1020)!; // footage 23:54–00:11Z
    expect(isWrongWindow(win, h44.aStartMs!, h44.aEndMs!)).toBe(false);
  });

  it("edge-clip regression: footage merely touching the staging slack is WRONG (the red-h16→h17 class)", () => {
    const h17 = {
      aStartMs: ms("2026-08-09T18:26:55.371Z"),
      aEndMs: ms("2026-08-09T18:37:00.873Z"),
    };
    const win = footageWindow("2026-08-09T18:22:28.000Z", 907)!; // ends 2.6s into h17's pad
    expect(isWrongWindow(win, h17.aStartMs, h17.aEndMs)).toBe(true);
  });

  it("containment: a long recording spanning the whole heat is NOT wrong", () => {
    const win = footageWindow("2026-08-10T00:30:00.000Z", 3000)!; // 23:40–00:30Z ⊇ h44 padded
    expect(isWrongWindow(win, h44.aStartMs!, h44.aEndMs!)).toBe(false);
  });
});

describe("sweepWrongWindow", () => {
  it("skips videos with no duration and heats with no actuals; flags delivered wrongs", () => {
    const hits = sweepWrongWindow(
      [
        { videoCode: "NODUR", sessionId: "58015732", capturedAt: "2026-08-10T01:09:32.000Z" },
        {
          videoCode: "NOWIN",
          sessionId: "unknown-sid",
          capturedAt: "2026-08-10T01:09:32.000Z",
          duration: 800,
        },
        {
          videoCode: "9ZMENGUQY9",
          sessionId: "58015732",
          firstName: "Garry",
          lastName: "Cooley",
          cameraNumber: 79,
          capturedAt: "2026-08-10T01:09:32.000Z",
          duration: 887,
          notifySmsOk: true,
          notifySmsDeliveryStatus: "delivered",
        },
      ],
      windows,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].videoCode).toBe("9ZMENGUQY9");
    expect(hits[0].racer).toBe("Garry Cooley");
    expect(hits[0].delivered).toBe(true);
  });
});

describe("sweepSilentScans", () => {
  const scan = {
    sys: "58",
    sid: "58015732",
    pid: "1",
    fn: "Emma",
    ln: "Gunn",
    at: "2026-08-09T23:46:00.000Z",
  };
  const afterGrace = h44.aEndMs! + 13 * 60_000;

  it("flags a scanned camera with no upload once the heat ended past the grace (the cam-58 class)", () => {
    const silent = sweepSilentScans([scan], new Map(), windows, afterGrace);
    expect(silent).toHaveLength(1);
    expect(silent[0].camera).toBe("58");
    expect(silent[0].label).toBe("Blue h44");
  });

  it("stays quiet inside the grace window and for unfinished heats", () => {
    expect(sweepSilentScans([scan], new Map(), windows, h44.aEndMs! + 60_000)).toHaveLength(0);
    const openHeat = new Map([["58015732", { ...h44, aEndMs: undefined }]]);
    expect(sweepSilentScans([scan], new Map(), openHeat, afterGrace)).toHaveLength(0);
  });

  it("an upload from the camera after the scan clears it", () => {
    const uploads = new Map([["58", [ms("2026-08-10T00:11:00.000Z")]]]);
    expect(sweepSilentScans([scan], uploads, windows, afterGrace)).toHaveLength(0);
  });

  it("an upload from BEFORE the scan does not clear it", () => {
    const uploads = new Map([["58", [ms("2026-08-09T20:00:00.000Z")]]]);
    expect(sweepSilentScans([scan], uploads, windows, afterGrace)).toHaveLength(1);
  });
});

describe("sweepZeroScanHeats", () => {
  const justLaunched = new Map([
    [
      "57142836",
      {
        sessionId: "57142836",
        label: "Red h16",
        aStartMs: Date.parse("2026-08-09T18:09:57.407Z"),
      } as HeatWindowInfo,
    ],
  ]);
  const now = Date.parse("2026-08-09T18:12:00.000Z");

  it("flags the red-h16 shape: launched, 12 on the roster, zero scans", () => {
    const hits = sweepZeroScanHeats(
      justLaunched,
      new Map([["57142836", 12]]),
      new Map([["57142836", 0]]),
      now,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("Red h16");
  });

  it("never pages on cold roster caches, tiny rosters, scanned heats, or stale launches", () => {
    expect(
      sweepZeroScanHeats(justLaunched, new Map(), new Map([["57142836", 0]]), now),
    ).toHaveLength(0);
    expect(
      sweepZeroScanHeats(justLaunched, new Map([["57142836", 1]]), new Map([["57142836", 0]]), now),
    ).toHaveLength(0);
    expect(
      sweepZeroScanHeats(
        justLaunched,
        new Map([["57142836", 12]]),
        new Map([["57142836", 9]]),
        now,
      ),
    ).toHaveLength(0);
    const hourLater = now + 60 * 60_000;
    expect(
      sweepZeroScanHeats(
        justLaunched,
        new Map([["57142836", 12]]),
        new Map([["57142836", 0]]),
        hourLater,
      ),
    ).toHaveLength(0);
  });

  it("an UNKNOWN scan count (failed SCARD) never collapses to zero — staff holding the scanner must not be paged", () => {
    expect(
      sweepZeroScanHeats(justLaunched, new Map([["57142836", 12]]), new Map(), now),
    ).toHaveLength(0);
  });
});

describe("dispatch builders", () => {
  const silent = (camera: string) => ({
    sessionId: "56481508",
    personId: "1",
    label: "Blue h29",
    camera,
    racer: "R",
    assignedAtMs: 0,
  });

  it("radio: zero-scan always speaks; silent cameras only at the ≥3 floor; wrong-window NEVER radios", () => {
    expect(
      radioMessages({ newZeroScan: [], newSilent: [silent("58"), silent("91")] }),
    ).toHaveLength(0);
    const msgs = radioMessages({
      newZeroScan: [{ sessionId: "s", label: "Red h16", aStartMs: 0, rosterCount: 12 }],
      newSilent: [silent("58"), silent("91"), silent("84")],
    });
    expect(msgs.some((m) => m.includes("Red h16 launched with no cameras scanned"))).toBe(true);
    expect(msgs.some((m) => m.includes("3 cameras from Blue h29"))).toBe(true);
    expect(msgs.some((m) => m.toLowerCase().includes("wrong"))).toBe(false);
  });

  it("email builder returns null on a clean tick — no empty emails", () => {
    expect(
      alertEmailHtml({ newWrong: [], newZeroScan: [], newSilent: [], adminUrl: "u" }),
    ).toBeNull();
  });
});

describe("kill switches (house rule: default ON)", () => {
  it("VIDEO_LIVENESS_ALERTS / VIDEO_LIVENESS_RADIO", () => {
    expect(livenessEnabled()).toBe(true);
    expect(livenessRadioEnabled()).toBe(true);
    vi.stubEnv("VIDEO_LIVENESS_ALERTS", "false");
    vi.stubEnv("VIDEO_LIVENESS_RADIO", "false");
    expect(livenessEnabled()).toBe(false);
    expect(livenessRadioEnabled()).toBe(false);
  });
});
