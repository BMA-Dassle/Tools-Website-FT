import { describe, it, expect } from "vitest";
import { toCrashReport } from "./crash-log.server";

/**
 * The crash endpoint is PUBLIC and unauthenticated, for the same reason the feed
 * beside it is: the reporter is a TV that has already crashed once, and a panel on
 * its way down cannot be asked to authenticate. That makes every field arriving there
 * untrusted text from the open internet, and this is the coercion standing between it
 * and Redis.
 *
 * Pure, so it is testable without a network — which matters more than usual here.
 * The live endpoint sits behind a bot filter that refuses curl outright (so does the
 * feed, while serving twenty screens perfectly), so there is no probing this one from
 * a terminal. The input handling has to be pinned where it can be.
 */
const NOW = "2026-09-01T22:00:00.000Z";

describe("toCrashReport", () => {
  it("keeps a well-formed report", () => {
    expect(
      toCrashReport(
        {
          screen: "HPFM:4",
          build: "abc12345",
          scene: "celebration",
          origin: "scene",
          message: "Cannot read properties of undefined",
          stack: "at SceneCelebration",
          digest: "1234567890",
        },
        NOW,
      ),
    ).toEqual({
      at: NOW,
      screen: "HPFM:4",
      build: "abc12345",
      scene: "celebration",
      origin: "scene",
      message: "Cannot read properties of undefined",
      stack: "at SceneCelebration",
      digest: "1234567890",
    });
  });

  it("stamps the SERVER's clock, never the panel's", () => {
    // A player with a wrong RTC is exactly the kind of board that crashes, and a
    // recorder sorted by a screen's own idea of the time would bury the report it
    // most needed to show.
    expect(toCrashReport({ message: "boom", at: "1999-01-01T00:00:00.000Z" }, NOW)?.at).toBe(NOW);
  });

  it("refuses a report with no usable message — it would tell us nothing", () => {
    expect(toCrashReport({ screen: "HPFM:4" }, NOW)).toBeNull();
    expect(toCrashReport({ message: "" }, NOW)).toBeNull();
    expect(toCrashReport({ message: 42 }, NOW)).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    for (const junk of [null, undefined, "message", 7]) {
      expect(toCrashReport(junk, NOW)).toBeNull();
    }
  });

  it("defaults an unknown origin to `route`, the LOUDER of the two", () => {
    // "route" means the panel rebooted. Guessing wrong in that direction surfaces a
    // report that deserved attention; guessing "scene" would quietly downgrade one.
    expect(toCrashReport({ message: "x" }, NOW)?.origin).toBe("route");
    expect(toCrashReport({ message: "x", origin: "nonsense" }, NOW)?.origin).toBe("route");
    expect(toCrashReport({ message: "x", origin: "scene" }, NOW)?.origin).toBe("scene");
  });

  it("CLAMPS every field, so one report cannot fill the log on its own", () => {
    const huge = "x".repeat(50_000);
    const r = toCrashReport(
      { message: huge, stack: huge, screen: huge, build: huge, scene: huge, digest: huge },
      NOW,
    )!;
    expect(r.message.length).toBe(500);
    expect(r.stack?.length).toBe(2_000);
    expect(r.screen?.length).toBe(40);
    expect(r.build?.length).toBe(40);
    expect(r.scene?.length).toBe(40);
    expect(r.digest?.length).toBe(60);
  });

  it("nulls the optional fields rather than inventing them", () => {
    const r = toCrashReport({ message: "boom" }, NOW)!;
    expect(r.screen).toBeNull();
    expect(r.build).toBeNull();
    expect(r.scene).toBeNull();
    expect(r.stack).toBeNull();
    expect(r.digest).toBeNull();
  });

  it("never lets a non-string field through as a string", () => {
    const r = toCrashReport({ message: "boom", screen: { evil: true }, stack: 12 }, NOW)!;
    expect(r.screen).toBeNull();
    expect(r.stack).toBeNull();
  });
});
