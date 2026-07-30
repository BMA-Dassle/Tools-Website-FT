import { describe, it, expect } from "vitest";
import {
  GROUP_EVENTS,
  getRaceBlockWindowsForDate,
  raceWindowAppliesToTrack,
  eventRaceWindowEnd,
  type RaceBlockWindow,
} from "./group-events";

/**
 * Track-scoped race windows (raceWindowExtension).
 *
 * Christmas in July 2026-07-30: the 4:30–5:30 window sold out, so two extra RED
 * heats (5:36, 5:48) were opened to the event. Blue's heats in those same
 * minutes must stay publicly bookable — the bug this guards against is a
 * one-track extension quietly reserving BOTH tracks.
 */

const XMAS = "2026-07-30";

/** The overlap test both public pickers run, so the assertions below exercise
 *  the real predicate rather than a paraphrase of it. */
function heatReserved(
  windows: RaceBlockWindow[],
  startIso: string,
  stopIso: string,
  track: string | null,
): boolean {
  const hS = new Date(startIso).getTime();
  const hE = new Date(stopIso).getTime();
  return windows.some((w) => {
    if (!raceWindowAppliesToTrack(w, track)) return false;
    return hS < new Date(w.stopIso).getTime() && hE > new Date(w.startIso).getTime();
  });
}

describe("getRaceBlockWindowsForDate", () => {
  it("emits the base window plus a track-scoped extension window", () => {
    const w = getRaceBlockWindowsForDate(XMAS);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({
      startIso: `${XMAS}T16:30:00`,
      stopIso: `${XMAS}T17:30:00`,
    });
    // Base window carries no `tracks` at all — it applies to every track.
    expect(w[0].tracks).toBeUndefined();
    expect(w[1]).toMatchObject({
      startIso: `${XMAS}T17:30:00`,
      stopIso: `${XMAS}T18:00:00`,
      tracks: ["Red"],
    });
  });

  it("is empty on a date with no event-window event", () => {
    expect(getRaceBlockWindowsForDate("2026-07-31")).toEqual([]);
  });

  it("emits a single untracked window for an event with no extension", () => {
    const noExt = Object.values(GROUP_EVENTS).find(
      (e) => e.publicBlock === "event-window" && !e.raceWindowExtension,
    );
    if (!noExt) return; // xmas is currently the only event-window event
    expect(getRaceBlockWindowsForDate(noExt.eventDate)).toHaveLength(1);
  });
});

describe("public block — which heats are reserved", () => {
  const w = getRaceBlockWindowsForDate(XMAS);

  it("reserves BOTH tracks inside the base window", () => {
    for (const track of ["Red", "Blue"]) {
      expect(heatReserved(w, `${XMAS}T17:12:00`, `${XMAS}T17:24:00`, track)).toBe(true);
    }
  });

  it("reserves RED ONLY in the extension window (5:36 and 5:48)", () => {
    for (const start of ["17:36", "17:48"]) {
      const stop = start === "17:36" ? "17:48" : "18:00";
      expect(heatReserved(w, `${XMAS}T${start}:00`, `${XMAS}T${stop}:00`, "Red")).toBe(true);
      // The whole point of the change: Blue stays public.
      expect(heatReserved(w, `${XMAS}T${start}:00`, `${XMAS}T${stop}:00`, "Blue")).toBe(false);
    }
  });

  it("leaves the 6:00 PM heat public on both tracks", () => {
    for (const track of ["Red", "Blue"]) {
      expect(heatReserved(w, `${XMAS}T18:00:00`, `${XMAS}T18:12:00`, track)).toBe(false);
    }
  });

  it("never sweeps an unidentified track into a one-track reservation", () => {
    // Base window still applies (untracked); the Red-only extension must not.
    expect(heatReserved(w, `${XMAS}T17:12:00`, `${XMAS}T17:24:00`, null)).toBe(true);
    expect(heatReserved(w, `${XMAS}T17:36:00`, `${XMAS}T17:48:00`, null)).toBe(false);
  });
});

describe("eventRaceWindowEnd — what the event funnel offers", () => {
  const xmas = GROUP_EVENTS["xmas-in-july"];

  it("extends the window for a named track", () => {
    expect(eventRaceWindowEnd(xmas, "Red")).toBe("18:00");
  });

  it("leaves an unnamed track on the base window", () => {
    expect(eventRaceWindowEnd(xmas, "Blue")).toBe("17:30");
    expect(eventRaceWindowEnd(xmas, null)).toBe("17:30");
  });

  it("returns endTime unchanged for an event with no extension", () => {
    const hn = GROUP_EVENTS["healthnet-2026"];
    expect(eventRaceWindowEnd(hn, "Red")).toBe(hn.endTime);
  });
});
