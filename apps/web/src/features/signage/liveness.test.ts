import { describe, it, expect } from "vitest";
import {
  feedLiveness,
  fmtClockWithSeconds,
  livenessLine,
  staleAgeLabel,
  LIVENESS_STALE_MS,
  type Liveness,
} from "./liveness";

/** A board that heard from the server `agoMs` ago on both lanes. */
function heardAgo(nowMs: number, agoMs: number): Liveness {
  return feedLiveness({
    lastFullOkMs: nowMs - agoMs,
    lastPulseOkMs: nowMs - agoMs,
    nowMs,
  });
}

const NOW = 1_800_000_000_000;

describe("feedLiveness", () => {
  it("says nothing at all until the first poll has landed", () => {
    // A booting board must not accuse itself. The footer renders nothing for
    // this state rather than "never" — a wall in front of guests has no error
    // state, and the loader is already saying "starting up".
    const l = feedLiveness({ lastFullOkMs: null, lastPulseOkMs: null, nowMs: NOW });
    expect(l.state).toBe("warming");
    expect(l.lastOkMs).toBeNull();
    expect(l.ageMs).toBeNull();
  });

  it("is live the instant a poll lands", () => {
    const l = heardAgo(NOW, 0);
    expect(l.state).toBe("live");
    expect(l.ageMs).toBe(0);
    expect(l.lastOkMs).toBe(NOW);
  });

  it("stays live through a couple of dropped cycles", () => {
    // ~20s is one missed cycle on the 2s pulse with its 8s deadline. Painting a
    // board amber for that is the cry-wolf failure this threshold exists to
    // avoid.
    expect(heardAgo(NOW, 20_000).state).toBe("live");
  });

  it("turns stale only past the window, and the boundary is exclusive", () => {
    expect(heardAgo(NOW, LIVENESS_STALE_MS).state).toBe("live");
    expect(heardAgo(NOW, LIVENESS_STALE_MS + 1).state).toBe("stale");
  });

  it("takes the NEWER of the two lanes, whichever one that is", () => {
    // The lanes fail independently. Reading only the pulse would paint a board
    // amber while its full feed was arriving perfectly well.
    const pulseFresher = feedLiveness({
      lastFullOkMs: NOW - 10 * 60_000,
      lastPulseOkMs: NOW - 1_000,
      nowMs: NOW,
    });
    expect(pulseFresher.state).toBe("live");
    expect(pulseFresher.ageMs).toBe(1_000);

    const fullFresher = feedLiveness({
      lastFullOkMs: NOW - 1_000,
      lastPulseOkMs: NOW - 10 * 60_000,
      nowMs: NOW,
    });
    expect(fullFresher.state).toBe("live");
    expect(fullFresher.ageMs).toBe(1_000);
  });

  it("works on one lane when the other has never succeeded", () => {
    expect(feedLiveness({ lastFullOkMs: NOW - 2_000, lastPulseOkMs: null, nowMs: NOW }).state).toBe(
      "live",
    );
    expect(feedLiveness({ lastFullOkMs: null, lastPulseOkMs: NOW - 2_000, nowMs: NOW }).state).toBe(
      "live",
    );
    // Both lanes quiet for an hour is stale on either one alone, too.
    expect(
      feedLiveness({ lastFullOkMs: null, lastPulseOkMs: NOW - 3_600_000, nowMs: NOW }).state,
    ).toBe("stale");
  });

  it("goes stale as the quiet stretches, and reports the real age", () => {
    const l = heardAgo(NOW, 11 * 60_000);
    expect(l.state).toBe("stale");
    expect(l.ageMs).toBe(660_000);
    expect(l.lastOkMs).toBe(NOW - 660_000);
  });

  it("never reports a negative age when the device clock steps backward", () => {
    // An NTP correction on a player PC is a documented condition here. A stamp
    // from the "future" reads as just-heard-from, not as a negative age that
    // would print a nonsense label.
    const l = feedLiveness({
      lastFullOkMs: NOW + 30_000,
      lastPulseOkMs: NOW + 30_000,
      nowMs: NOW,
    });
    expect(l.ageMs).toBe(0);
    expect(l.state).toBe("live");
  });

  it("honours a caller-supplied window", () => {
    expect(heardAgo(NOW, 5_000).state).toBe("live");
    expect(
      feedLiveness({
        lastFullOkMs: NOW - 5_000,
        lastPulseOkMs: NOW - 5_000,
        nowMs: NOW,
        staleAfterMs: 1_000,
      }).state,
    ).toBe("stale");
  });
});

describe("staleAgeLabel", () => {
  it("reads in whole units a marshal can repeat down the radio", () => {
    expect(staleAgeLabel(0)).toBe("under a minute");
    expect(staleAgeLabel(59_999)).toBe("under a minute");
    expect(staleAgeLabel(60_000)).toBe("1 min");
    expect(staleAgeLabel(4 * 60_000)).toBe("4 min");
    expect(staleAgeLabel(59 * 60_000)).toBe("59 min");
    expect(staleAgeLabel(60 * 60_000)).toBe("1 hr");
    expect(staleAgeLabel(72 * 60_000)).toBe("1 hr 12 min");
    expect(staleAgeLabel(5 * 3_600_000)).toBe("5 hr");
  });
});

describe("livenessLine — the words actually on the wall", () => {
  /** Health as it stands `agoMs` after the last successful poll. */
  function line(agoMs: number | null, nowMs = Date.parse("2026-08-20T02:54:07Z")) {
    const stamp = agoMs === null ? null : nowMs - agoMs;
    return livenessLine(feedLiveness({ lastFullOkMs: stamp, lastPulseOkMs: stamp, nowMs }));
  }

  it("shows nothing at all on a board that has never polled", () => {
    expect(line(null)).toBeNull();
  });

  it("reads as a wall clock while the feed is landing", () => {
    // "Updated", not "Live" — this board's footer already prints the race's
    // finish time at the other end, and a bare second time would be ambiguous.
    expect(line(0)).toEqual({ text: "Updated 10:54:07 PM", stale: false });
    expect(line(2_000)).toEqual({ text: "Updated 10:54:05 PM", stale: false });
  });

  it("names the last time it heard anything once it goes quiet", () => {
    // 11 minutes of silence, on the night the owner reported the Red wall
    // frozen. The absolute time is the half staff can check against a phone.
    expect(line(11 * 60_000)).toEqual({
      text: "No update since 10:43:07 PM · 11 min",
      stale: true,
    });
  });

  it("keeps reading correctly after hours of silence", () => {
    // The overnight case: a board that wedged at close and sat there. It must
    // not roll over to a bare minute count or print a negative hour.
    expect(line(5 * 3_600_000 + 7 * 60_000)).toEqual({
      text: "No update since 5:47:07 PM · 5 hr 7 min",
      stale: true,
    });
  });

  it("does not go amber for an ordinary hiccup", () => {
    expect(line(20_000)?.stale).toBe(false);
    expect(line(LIVENESS_STALE_MS)?.stale).toBe(false);
    expect(line(LIVENESS_STALE_MS + 1)?.stale).toBe(true);
  });
});

describe("fmtClockWithSeconds", () => {
  it("prints venue time with seconds, not device time", () => {
    // 2026-08-20T02:54:07Z is 10:54:07 PM on 8/19 in ET (EDT, UTC-4) — the
    // instant the Red wall was checked and found healthy.
    expect(fmtClockWithSeconds(Date.parse("2026-08-20T02:54:07Z"))).toBe("10:54:07 PM");
  });

  it("crosses the noon and midnight boundaries the way a 12-hour clock does", () => {
    // 12, not 0 — the two cases a naive h % 12 gets wrong.
    expect(fmtClockWithSeconds(Date.parse("2026-08-20T04:00:00Z"))).toBe("12:00:00 AM");
    expect(fmtClockWithSeconds(Date.parse("2026-08-19T16:00:09Z"))).toBe("12:00:09 PM");
    expect(fmtClockWithSeconds(Date.parse("2026-08-19T16:59:59Z"))).toBe("12:59:59 PM");
    expect(fmtClockWithSeconds(Date.parse("2026-08-19T17:00:00Z"))).toBe("1:00:00 PM");
  });

  it("reads in EST once the venue is off summer time", () => {
    // January: ET is UTC-5, so the same UTC hour is an hour earlier on the wall.
    expect(fmtClockWithSeconds(Date.parse("2026-01-15T03:54:07Z"))).toBe("10:54:07 PM");
  });

  it("returns empty rather than throwing on a nonsense instant", () => {
    expect(fmtClockWithSeconds(Number.NaN)).toBe("");
    expect(fmtClockWithSeconds(Number.POSITIVE_INFINITY)).toBe("");
  });
});
