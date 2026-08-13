import { describe, expect, it } from "vitest";
import { foldBriefingLog } from "./briefing-log";
import type { BriefingEvent, BriefingEventAction } from "./events-db";
import { HELMET_PHASE_MS } from "./types";

const T0 = 1_786_487_400_000;
const FILM_MS = 270_000; // 4:30, the real Starter film length

let seq = 0;
function ev(
  action: BriefingEventAction,
  atMs: number,
  over: Partial<BriefingEvent> = {},
): BriefingEvent {
  seq += 1;
  return {
    id: String(seq),
    venue: "FT",
    businessDay: "2026-08-12",
    room: "red",
    track: "red",
    sessionId: "58509552",
    heatNumber: 24,
    raceType: "Starter",
    tier: "starter",
    action,
    atMs,
    videoUrl: null,
    videoMs: null,
    photoUrl: null,
    reason: null,
    ...over,
  };
}

describe("foldBriefingLog", () => {
  it("records the whole ordinary briefing, with no explicit end", () => {
    // Sent, film rolled a minute later, nobody pressed anything after.
    const events = [
      ev("sent", T0),
      ev("started", T0 + 60_000, { videoMs: FILM_MS, videoUrl: "https://blob/starter.mp4" }),
    ];
    // Long after the film and the helmet board finished.
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);

    expect(rec.sessionId).toBe("58509552");
    expect(rec.heatNumber).toBe(24);
    expect(rec.startedAtMs).toBe(T0 + 60_000);
    expect(rec.filmMs).toBe(FILM_MS);
    expect(rec.filmUrl).toBe("https://blob/starter.mp4");
    expect(rec.filmCompleted).toBe(true);
    // The room's occupancy ends at film end + the helmet phase the TV holds.
    expect(rec.endKind).toBe("film-complete");
    expect(rec.endedAtMs).toBe(T0 + 60_000 + FILM_MS + HELMET_PHASE_MS);
    // Time in the room runs from the SEND, not from the film.
    expect(rec.inRoomMs).toBe(60_000 + FILM_MS + HELMET_PHASE_MS);
  });

  it("leaves the record open while they are still in there", () => {
    const events = [ev("sent", T0), ev("started", T0 + 30_000, { videoMs: FILM_MS })];
    // Two minutes into a four-and-a-half minute film.
    const [rec] = foldBriefingLog(events, T0 + 150_000);

    expect(rec.endedAtMs).toBeNull();
    expect(rec.endKind).toBeNull();
    expect(rec.inRoomMs).toBeNull();
    expect(rec.filmCompleted).toBe(false);
  });

  it("counts a replay and measures the room from the LAST start", () => {
    const events = [
      ev("sent", T0),
      ev("started", T0 + 60_000, { videoMs: FILM_MS }),
      // Latecomers walked in; staff played it again.
      ev("restarted", T0 + 120_000, { videoMs: FILM_MS }),
    ];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);

    expect(rec.restarts).toBe(1);
    expect(rec.startedAtMs).toBe(T0 + 60_000);
    expect(rec.lastStartedAtMs).toBe(T0 + 120_000);
    expect(rec.endedAtMs).toBe(T0 + 120_000 + FILM_MS + HELMET_PHASE_MS);
    expect(rec.filmCompleted).toBe(true);
  });

  describe("an explicit end always wins", () => {
    it("staff cleared the room", () => {
      const events = [
        ev("sent", T0),
        ev("started", T0 + 60_000, { videoMs: FILM_MS }),
        ev("ended", T0 + 400_000, { reason: "cleared" }),
      ];
      const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
      expect(rec.endKind).toBe("cleared");
      expect(rec.endedAtMs).toBe(T0 + 400_000);
      expect(rec.inRoomMs).toBe(400_000);
    });

    it("the next group took the room MID-FILM — so the film did not complete", () => {
      const events = [
        ev("sent", T0),
        ev("started", T0 + 60_000, { videoMs: FILM_MS }),
        // 90 seconds into a 4:30 film.
        ev("ended", T0 + 150_000, { reason: "replaced" }),
      ];
      const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
      expect(rec.endKind).toBe("replaced");
      expect(rec.inRoomMs).toBe(150_000);
      expect(rec.filmCompleted).toBe(false);
    });

    it("an end after the film's own finish still reads as completed", () => {
      const events = [
        ev("sent", T0),
        ev("started", T0 + 60_000, { videoMs: FILM_MS }),
        ev("ended", T0 + 60_000 + FILM_MS + 5_000, { reason: "cleared" }),
      ];
      const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
      expect(rec.filmCompleted).toBe(true);
      expect(rec.endKind).toBe("cleared");
    });
  });

  describe("the case a claim would actually turn on", () => {
    it("a group that was sent and whose film NEVER started", () => {
      // Sent, undone twenty minutes later — no film, ever.
      const events = [ev("sent", T0), ev("ended", T0 + 1_200_000, { reason: "cleared" })];
      const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);

      expect(rec.startedAtMs).toBeNull();
      expect(rec.filmCompleted).toBe(false);
      expect(rec.filmMs).toBeNull();
      expect(rec.inRoomMs).toBe(1_200_000);
    });

    it("a film with no known length cannot be claimed complete, or derive an end", () => {
      // A manifest row predating duration capture: started, length unknown.
      const events = [ev("sent", T0), ev("started", T0 + 60_000, { videoMs: null })];
      const [rec] = foldBriefingLog(events, T0 + 60 * 60_000);

      expect(rec.startedAtMs).toBe(T0 + 60_000);
      expect(rec.filmMs).toBeNull();
      expect(rec.endedAtMs).toBeNull();
      expect(rec.filmCompleted).toBe(false);
    });
  });

  it("keeps one record per ROOM — a Mega group split across both is two occupancies", () => {
    const events = [
      ev("sent", T0, { room: "red" }),
      ev("sent", T0 + 5_000, { room: "blue" }),
      ev("started", T0 + 60_000, { room: "red", videoMs: FILM_MS }),
      ev("started", T0 + 70_000, { room: "blue", videoMs: FILM_MS }),
    ];
    const records = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.room).sort()).toEqual(["blue", "red"]);
  });

  it("folds correctly from rows handed over NEWEST first", () => {
    const events = [ev("started", T0 + 60_000, { videoMs: FILM_MS }), ev("sent", T0)].reverse();
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.sentAtMs).toBe(T0);
    expect(rec.startedAtMs).toBe(T0 + 60_000);
  });

  it("returns newest-first", () => {
    const events = [
      ev("sent", T0, { sessionId: "1" }),
      ev("sent", T0 + 600_000, { sessionId: "2" }),
      ev("sent", T0 + 300_000, { sessionId: "3" }),
    ];
    expect(foldBriefingLog(events, T0 + 30 * 60_000).map((r) => r.sessionId)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });

  it("survives a group whose send predates the log", () => {
    // Only a `started` row exists — the log went live mid-shift.
    const events = [ev("started", T0 + 60_000, { videoMs: FILM_MS })];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.sentAtMs).toBe(T0 + 60_000);
    expect(rec.inRoomMs).toBe(FILM_MS + HELMET_PHASE_MS);
  });

  it("has nothing to say about a day with no events", () => {
    expect(foldBriefingLog([], T0)).toEqual([]);
  });

  it("carries the room photo and when it was taken", () => {
    const events = [
      ev("sent", T0),
      ev("started", T0 + 60_000, { videoMs: FILM_MS }),
      ev("photo", T0 + 61_500, { photoUrl: "https://blob/red-heat-24.jpg" }),
    ];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.photoUrl).toBe("https://blob/red-heat-24.jpg");
    expect(rec.photoAtMs).toBe(T0 + 61_500);
    // The picture is evidence ALONGSIDE the film record, never instead of it.
    expect(rec.startedAtMs).toBe(T0 + 60_000);
    expect(rec.filmCompleted).toBe(true);
  });

  it("says so plainly when no photo was taken", () => {
    const events = [ev("sent", T0), ev("started", T0 + 60_000, { videoMs: FILM_MS })];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.photoUrl).toBeNull();
    expect(rec.photoAtMs).toBeNull();
  });

  it("keeps the FIRST picture when a room is re-sent the same session", () => {
    const events = [
      ev("sent", T0),
      ev("started", T0 + 60_000, { videoMs: FILM_MS }),
      ev("photo", T0 + 61_000, { photoUrl: "https://blob/first.jpg" }),
      ev("sent", T0 + 600_000),
      ev("started", T0 + 660_000, { videoMs: FILM_MS }),
      ev("photo", T0 + 661_000, { photoUrl: "https://blob/second.jpg" }),
    ];
    const [rec] = foldBriefingLog(events, T0 + 60 * 60_000);
    expect(rec.photoUrl).toBe("https://blob/first.jpg");
  });

  it("ignores a photo row with no url, rather than reporting an empty picture", () => {
    const events = [
      ev("sent", T0),
      ev("started", T0 + 60_000, { videoMs: FILM_MS }),
      ev("photo", T0 + 61_000),
      ev("photo", T0 + 62_000, { photoUrl: "https://blob/real.jpg" }),
    ];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.photoUrl).toBe("https://blob/real.jpg");
    expect(rec.photoAtMs).toBe(T0 + 62_000);
  });

  it("does not let a photo row stand in for a briefing that never started", () => {
    // A picture without a `started` row cannot claim the film ran.
    const events = [ev("sent", T0), ev("photo", T0 + 30_000, { photoUrl: "https://blob/x.jpg" })];
    const [rec] = foldBriefingLog(events, T0 + 30 * 60_000);
    expect(rec.photoUrl).toBe("https://blob/x.jpg");
    expect(rec.startedAtMs).toBeNull();
    expect(rec.filmCompleted).toBe(false);
  });
});
