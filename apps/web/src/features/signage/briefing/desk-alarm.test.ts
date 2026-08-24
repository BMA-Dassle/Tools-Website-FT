import { describe, expect, it } from "vitest";
import {
  ALARM_LEAD_MS,
  SEND_ALARM_MIN_CALLED_MS,
  alarmKey,
  alarmMessage,
  callAlarmCue,
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
});
