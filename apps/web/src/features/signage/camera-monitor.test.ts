import { describe, expect, it } from "vitest";
import { resolveScreenConfig, rolePreset } from "./defaults";
import { isSceneImplemented, sceneHasData } from "./scenes/registry";
import { buildRotation } from "./director/schedule";
import type { ScreenConfig } from "./types";

describe("camera monitor — config resolution", () => {
  it("resolves a full camera config, keeping device, label and track", () => {
    const cfg: ScreenConfig = {
      playlist: [{ scene: "camera", slots: 1 }],
      cameraMonitor: { deviceId: "ae9373a3-f070", label: "Blue Briefing Room", track: "blue" },
    };
    const r = resolveScreenConfig(cfg, "FT");
    expect(r.cameraMonitor).toEqual({
      deviceId: "ae9373a3-f070",
      label: "Blue Briefing Room",
      track: "blue",
    });
  });

  it("is null when there is no camera picked yet — the board shows its setup notice", () => {
    const r = resolveScreenConfig({ playlist: [{ scene: "camera", slots: 1 }] }, "FT");
    expect(r.cameraMonitor).toBeNull();
  });

  it("drops a blank device id rather than asking the proxy for nothing", () => {
    const r = resolveScreenConfig({ cameraMonitor: { deviceId: "" } }, "FT");
    expect(r.cameraMonitor).toBeNull();
  });

  it("keeps the camera but nulls a bogus track — a typo means no clocks, not a crash", () => {
    const r = resolveScreenConfig(
      { cameraMonitor: { deviceId: "cam-1", track: "purple" as unknown as "blue" } },
      "FT",
    );
    expect(r.cameraMonitor).toEqual({ deviceId: "cam-1", label: null, track: null });
  });

  it("nulls an empty label to the designed default", () => {
    const r = resolveScreenConfig({ cameraMonitor: { deviceId: "cam-1", label: "" } }, "FT");
    expect(r.cameraMonitor?.label).toBeNull();
  });
});

describe("camera monitor — wiring", () => {
  it("the camera-monitor role is a single-scene camera board", () => {
    const preset = rolePreset("camera-monitor");
    expect(preset.config.playlist).toEqual([{ scene: "camera", slots: 1 }]);
  });

  it("the camera scene is implemented, so the scheduler may select it", () => {
    expect(isSceneImplemented("camera")).toBe(true);
  });

  it("a camera board never rotates away to ads — it always has something to show", () => {
    expect(sceneHasData("camera", null)).toBe(true);
    const segments = buildRotation(
      [{ scene: "camera", slots: 1, requiresData: false }],
      () => true,
      isSceneImplemented,
    );
    expect(segments).toEqual([{ scene: "camera", startSlot: 0, slots: 1 }]);
  });
});
