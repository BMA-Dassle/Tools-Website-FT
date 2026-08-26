import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALARM_KINDS,
  ALARM_LEAD_MS,
  SEND_ALARM_MIN_CALLED_MS,
  alarmKey,
  alarmMessage,
  callAlarmCue,
  isAlarmKind,
  pullAlarmCue,
  sendAlarmCue,
} from "./desk-alarm";

/**
 * The two things that must hold or the alarm becomes noise staff mute: it fires
 * EXACTLY three times per event (bounded, not nagging), and the send alarm
 * stays silent for a group that was only just called.
 */

const NOW = 1_700_000_000_000;
const S = 1_000;

describe("callAlarmCue", () => {
  const next = { sessionId: "9001", heatNumber: 56, callWindowEndsMs: NOW + 30 * S };

  it("gives one slot per ten seconds across the last thirty", () => {
    expect(callAlarmCue({ nowMs: NOW, next })?.slot).toBe(3);
    expect(callAlarmCue({ nowMs: NOW + 10 * S, next })?.slot).toBe(2);
    expect(callAlarmCue({ nowMs: NOW + 20 * S, next })?.slot).toBe(1);
  });

  it("is silent before the run-up and after the deadline", () => {
    expect(callAlarmCue({ nowMs: NOW - 1, next })).toBeNull();
    expect(callAlarmCue({ nowMs: NOW + 30 * S, next })).toBeNull();
    expect(callAlarmCue({ nowMs: NOW + 60 * S, next })).toBeNull();
  });

  it("is silent with nothing to call", () => {
    expect(callAlarmCue({ nowMs: NOW, next: null })).toBeNull();
  });

  it("plays exactly three times across the run-up, ticking every second", () => {
    const played = new Set<string>();
    for (let t = 0; t <= ALARM_LEAD_MS + 5 * S; t += S) {
      const cue = callAlarmCue({ nowMs: NOW + t, next });
      if (cue) played.add(alarmKey(cue));
    }
    expect(played.size).toBe(3);
  });

  it("keys by session, so the next heat's alarm is not swallowed", () => {
    const a = callAlarmCue({ nowMs: NOW, next })!;
    const b = callAlarmCue({
      nowMs: NOW,
      next: { ...next, sessionId: "9002", heatNumber: 57 },
    })!;
    expect(alarmKey(a)).not.toBe(alarmKey(b));
  });
});

describe("sendAlarmCue", () => {
  const called = { sessionId: "9001", heatNumber: 56 };

  it("fires once the session has been called long enough", () => {
    const cue = sendAlarmCue({
      called,
      calledForMs: SEND_ALARM_MIN_CALLED_MS,
      windowClosesInMs: 25 * S,
    });
    expect(cue).toEqual({ kind: "send", slot: 3, sessionId: "9001", heatNumber: 56 });
  });

  it("stays silent for a group that was only just called", () => {
    expect(sendAlarmCue({ called, calledForMs: 90 * S, windowClosesInMs: 25 * S })).toBeNull();
    expect(
      sendAlarmCue({ called, calledForMs: SEND_ALARM_MIN_CALLED_MS - 1, windowClosesInMs: 5 * S }),
    ).toBeNull();
  });

  it("treats an unknown called-age as no permission to shout", () => {
    expect(sendAlarmCue({ called, calledForMs: null, windowClosesInMs: 5 * S })).toBeNull();
  });

  it("is silent when the window is not closing at all", () => {
    expect(sendAlarmCue({ called, calledForMs: 10 * 60 * S, windowClosesInMs: null })).toBeNull();
  });

  it("is silent with nobody called", () => {
    expect(
      sendAlarmCue({ called: null, calledForMs: 10 * 60 * S, windowClosesInMs: 5 * S }),
    ).toBeNull();
  });

  it("also plays exactly three times as its window runs out", () => {
    const played = new Set<string>();
    for (let left = ALARM_LEAD_MS + 5 * S; left > -5 * S; left -= S) {
      const cue = sendAlarmCue({
        called,
        calledForMs: 10 * 60 * S,
        windowClosesInMs: left,
      });
      if (cue) played.add(alarmKey(cue));
    }
    expect(played.size).toBe(3);
  });
});

/**
 * THE 2026-08-25 BUG, PINNED.
 *
 * `pull-now` used to be emitted as `{ kind: "send", slot: 1 }` — the send
 * alarm's final beat. Because it is a STATE that stands until the group is sent,
 * it fired early and took `send:{session}:1` in both the caller's play-once set
 * and the server's hour-long Redis claim, so the real 10-seconds-out beat was
 * later refused as a duplicate. Measured live: session 59039734 claimed
 * `send:…:1` 586 seconds BEFORE `send:…:2`.
 */
describe("pullAlarmCue", () => {
  const called = { sessionId: "9001", heatNumber: 56 };

  it("fires once the verdict has flipped", () => {
    expect(pullAlarmCue({ called, pullNow: true })).toEqual({
      kind: "pull",
      slot: 1,
      sessionId: "9001",
      heatNumber: 56,
    });
  });

  it("is silent with nobody called, and while the verdict has not flipped", () => {
    expect(pullAlarmCue({ called: null, pullNow: true })).toBeNull();
    expect(pullAlarmCue({ called, pullNow: false })).toBeNull();
  });

  it("does NOT share a key with the send countdown's final beat", () => {
    const lastBeat = sendAlarmCue({
      called,
      calledForMs: 10 * 60 * S,
      windowClosesInMs: 5 * S,
    })!;
    expect(lastBeat.slot).toBe(1);

    // THE OLD SHAPE, KEPT AS EVIDENCE. `{ kind: "send", slot: 1 }` is exactly
    // what the pull-now branch returned, and it is byte-for-byte the final
    // beat's key — so whichever fired first took the other's claim for an hour.
    const asItWas = {
      kind: "send",
      slot: 1,
      sessionId: called.sessionId,
      heatNumber: called.heatNumber,
    } as const;
    expect(alarmKey(asItWas)).toBe(alarmKey(lastBeat));

    // And the shape that replaced it.
    expect(alarmKey(pullAlarmCue({ called, pullNow: true })!)).not.toBe(alarmKey(lastBeat));
  });

  it("leaves all three send beats intact across a session that pulled first", () => {
    const played = new Set<string>();
    // The flip stands for minutes, reported on every tick throughout.
    for (let i = 0; i < 60; i++) played.add(alarmKey(pullAlarmCue({ called, pullNow: true })!));
    // Then the window slips into its grace minute and the real countdown runs.
    for (let left = ALARM_LEAD_MS + 5 * S; left > -5 * S; left -= S) {
      const cue = sendAlarmCue({ called, calledForMs: 10 * 60 * S, windowClosesInMs: left });
      if (cue) played.add(alarmKey(cue));
    }
    // One pull + three send beats. It was 3 while the pull squatted on slot 1.
    expect(played.size).toBe(4);
  });

  it("plays exactly once however long the verdict stands", () => {
    const played = new Set<string>();
    for (let i = 0; i < 600; i++) played.add(alarmKey(pullAlarmCue({ called, pullNow: true })!));
    expect(played.size).toBe(1);
  });
});

describe("alarmMessage", () => {
  it("names the session and the seconds left", () => {
    expect(alarmMessage({ kind: "call", slot: 3, sessionId: "9001", heatNumber: 56 })).toEqual({
      title: "Call Session 56",
      body: "30s left to call it on time.",
    });
    expect(alarmMessage({ kind: "send", slot: 1, sessionId: "9001", heatNumber: 56 }).title).toBe(
      "Send Session 56 to briefing",
    );
  });

  it("still reads with no heat number", () => {
    expect(alarmMessage({ kind: "call", slot: 2, sessionId: "9001", heatNumber: null }).title).toBe(
      "Call The next session",
    );
  });

  /** A pull is a verdict, not a clock. While it rode the send alarm's last slot
   *  it inherited "10s left — after that the film will not fit", which was a
   *  deadline it had invented and put on a lock screen. */
  it("names no countdown for a pull, because there is none", () => {
    const msg = alarmMessage({ kind: "pull", slot: 1, sessionId: "9001", heatNumber: 56 });
    expect(msg).toEqual({
      title: "Pull Session 56 to briefing",
      body: "Check-in window is up with racers still missing.",
    });
    expect(msg.body).not.toMatch(/\ds left/);
    expect(alarmMessage({ kind: "pull", slot: 1, sessionId: "9001", heatNumber: null }).title).toBe(
      "Pull this group to briefing",
    );
  });
});

/**
 * THE WIRE GUARD, AND THE DRIFT THAT MADE IT NECESSARY.
 *
 * `pull` was added to desk-alarm.ts and to the test button on 2026-08-24 and
 * never to the push-fire shape check, which was a hand-written
 * `=== "call" || === "send"`. So the board could emit a cue the endpoint would
 * answer 400 to — the one alert staff most needed on a phone.
 */
describe("isAlarmKind", () => {
  const called = { sessionId: "9001", heatNumber: 56 };

  it("accepts every kind the cue factories can actually emit", () => {
    const cues = [
      callAlarmCue({
        nowMs: NOW,
        next: { sessionId: "9001", heatNumber: 56, callWindowEndsMs: NOW + 30 * S },
      })!,
      sendAlarmCue({ called, calledForMs: 10 * 60 * S, windowClosesInMs: 5 * S })!,
      pullAlarmCue({ called, pullNow: true })!,
    ];
    expect(cues.map((c) => c.kind).sort()).toEqual([...ALARM_KINDS].sort());
    for (const cue of cues) expect(isAlarmKind(cue.kind)).toBe(true);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "brief", "SEND", null, undefined, 1, {}]) {
      expect(isAlarmKind(bad)).toBe(false);
    }
  });

  it("is what the push-fire endpoint validates with, not a retyped list", () => {
    const route = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "..",
        "app",
        "api",
        "admin",
        "briefing",
        "route.ts",
      ),
      "utf8",
    );
    expect(route).toContain("isAlarmKind(cue?.kind)");
    // The hand-rolled comparison that let `pull` through the cracks.
    expect(route).not.toMatch(/cue\?\.kind === "/);
  });
});
