import { describe, expect, it } from "vitest";
import {
  liveSuspicion,
  PLAYING_TICK_STALE_MS,
  zonesDisagree,
  type QsysLiveSnapshot,
  type QsysZoneSnapshot,
} from "./qsys-truth";

const NOW = 1_800_000_000_000;

const idle = (zone: string): QsysZoneSnapshot => ({ zone, playing: false, file: "" });
const playing = (zone: string, file = "Dual Track Pre-Message.mp3"): QsysZoneSnapshot => ({
  zone,
  playing: true,
  file,
  timing: { remaining: 69.6 },
});

const live = (
  zones: QsysZoneSnapshot[],
  ageMs: number | null,
  connected = true,
): QsysLiveSnapshot => ({
  connected,
  zones,
  stateUpdatedAtMs: ageMs == null ? null : NOW - ageMs,
});

describe("liveSuspicion", () => {
  it("trusts a playing zone whose frames are still arriving", () => {
    expect(liveSuspicion(live([idle("red"), idle("blue"), playing("mega")], 300), NOW)).toBeNull();
  });

  it("trusts an idle picture however old — the feed is silent while idle", () => {
    expect(
      liveSuspicion(live([idle("red"), idle("blue"), idle("mega")], 6 * 3600_000), NOW),
    ).toBeNull();
  });

  it("names a playing zone whose last frame is seconds old — the 2026-09-10 freeze", () => {
    // stateUpdatedAt 19:34:32Z, read at 20:20Z: mega "playing" with the clock
    // stuck at 0:06 while the Core sat idle.
    const reason = liveSuspicion(
      live([idle("red"), idle("blue"), playing("mega")], 46 * 60_000),
      NOW,
    );
    expect(reason).toMatch(/^mega reports playing/);
    expect(reason).toContain("Dual Track Pre-Message.mp3");
  });

  it("holds the line exactly at the tick threshold", () => {
    expect(liveSuspicion(live([playing("red")], PLAYING_TICK_STALE_MS), NOW)).toBeNull();
    expect(liveSuspicion(live([playing("red")], PLAYING_TICK_STALE_MS + 1), NOW)).not.toBeNull();
  });

  it("distrusts a playing zone when the cache carries no timestamp at all", () => {
    expect(liveSuspicion(live([playing("blue")], null), NOW)).toMatch(/no state timestamp/);
  });

  it("distrusts everything when Pandora says its Core link is down, even an idle picture", () => {
    expect(liveSuspicion(live([idle("red"), idle("blue"), idle("mega")], 100, false), NOW)).toMatch(
      /link to the Core is down/,
    );
  });
});

describe("zonesDisagree", () => {
  it("is quiet when both pictures agree on what is playing", () => {
    const a = [idle("red"), playing("blue", "Blue Track Post.mp3"), idle("mega")];
    const b = [
      idle("red"),
      { ...playing("blue", "Blue Track Post.mp3"), timing: { remaining: 12 } },
      idle("mega"),
    ];
    expect(zonesDisagree(a, b)).toBeNull();
  });

  it("names the zone the cache has playing while the Core has idle", () => {
    const cached = [idle("red"), idle("blue"), playing("mega")];
    const direct = [idle("red"), idle("blue"), idle("mega")];
    expect(zonesDisagree(cached, direct)).toBe(
      'mega: cache says playing "Dual Track Pre-Message.mp3", Core says idle',
    );
  });

  it("names a zone the Core has playing that the cache missed", () => {
    const cached = [idle("red"), idle("blue"), idle("mega")];
    const direct = [playing("red", "Red Track Pre-Message.mp3"), idle("blue"), idle("mega")];
    expect(zonesDisagree(cached, direct)).toBe(
      'red: cache says idle, Core says playing "Red Track Pre-Message.mp3"',
    );
  });

  it("notices a different file on a zone both agree is playing", () => {
    const cached = [playing("red", "Stay Seated.mp3")];
    const direct = [playing("red", "Red Track Post.mp3")];
    expect(zonesDisagree(cached, direct)).toBe(
      'red: cache says "Stay Seated.mp3", Core says "Red Track Post.mp3"',
    );
  });

  it("ignores zones only one side knows about", () => {
    expect(zonesDisagree([playing("mega")], [idle("red")])).toBeNull();
  });
});
