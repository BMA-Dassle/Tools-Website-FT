import { describe, expect, it } from "vitest";
import {
  GREETING_FALLBACK_MS,
  GREETING_TIMING_DEFAULTS,
  GREETING_WINDOW_MS,
  LINGER_AFTER_MS,
  firstOnsetAfter,
  greetingStartMs,
  greetingWindowClosed,
  lingerDue,
  normaliseGreetingTiming,
} from "./return-greeting";

const POST = 1_000_000;

describe("greetingStartMs", () => {
  it("never speaks before the post press exists", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: null,
        arrivedAtMs: null,
        motionHealthy: true,
      }),
    ).toBeNull();
    // Even a stray arrival stamp without a post is silence — the post is what
    // calls the group back in.
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: null,
        arrivedAtMs: POST,
        motionHealthy: true,
      }),
    ).toBeNull();
  });

  it("fixed-timer mode is post + 45s, camera ignored", () => {
    expect(
      greetingStartMs({
        byMotion: false,
        postPlayedAtMs: POST,
        arrivedAtMs: POST + 5_000,
        motionHealthy: true,
      }),
    ).toBe(POST + GREETING_FALLBACK_MS);
  });

  it("motion mode greets at the stamped arrival", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: POST + 31_000,
        motionHealthy: true,
      }),
    ).toBe(POST + 31_000);
  });

  it("motion mode KEEPS WAITING while the camera is healthy and nobody is in", () => {
    // Null means "not yet", not "use the timer" — a greeting to an empty room
    // is the bug this replaces. The 2-minute window is what bounds the wait.
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: null,
        motionHealthy: true,
      }),
    ).toBeNull();
  });

  it("motion mode falls back to the timer when the NVR cannot answer", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: null,
        motionHealthy: false,
      }),
    ).toBe(POST + GREETING_FALLBACK_MS);
  });

  it("an arrival stamp cannot pull the greeting before the post press", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: POST - 10_000,
        motionHealthy: true,
      }),
    ).toBe(POST);
  });
});

describe("greetingWindowClosed", () => {
  it("holds through the window and shuts after it", () => {
    expect(greetingWindowClosed(POST, POST + GREETING_WINDOW_MS)).toBe(false);
    expect(greetingWindowClosed(POST, POST + GREETING_WINDOW_MS + 1)).toBe(true);
  });
});

describe("firstOnsetAfter", () => {
  it("skips a period already running at the press — that is not an arrival", () => {
    const periods = [
      { startMs: POST - 30_000, durationMs: 60_000 }, // previous group / staff
      { startMs: POST + 28_000, durationMs: 40_000 }, // the group walking in
      { startMs: POST + 90_000, durationMs: 5_000 },
    ];
    expect(firstOnsetAfter(periods, POST)).toBe(POST + 28_000);
  });

  it("answers null when nothing has started since the press", () => {
    expect(firstOnsetAfter([{ startMs: POST - 5_000, durationMs: 2_000 }], POST)).toBeNull();
    expect(firstOnsetAfter([], POST)).toBeNull();
  });

  it("takes the earliest onset regardless of input order", () => {
    const periods = [
      { startMs: POST + 60_000, durationMs: 3_000 },
      { startMs: POST + 20_000, durationMs: 3_000 },
    ];
    expect(firstOnsetAfter(periods, POST)).toBe(POST + 20_000);
  });

  it("ignores an unreadable start", () => {
    expect(firstOnsetAfter([{ startMs: NaN, durationMs: 3_000 }], POST)).toBeNull();
  });
});

describe("lingerDue", () => {
  const ARRIVED = POST + 30_000;
  it("fires only once the group has been in for the full linger span AND is still moving", () => {
    expect(
      lingerDue({ arrivedAtMs: ARRIVED, stillMoving: true, nowMs: ARRIVED + LINGER_AFTER_MS }),
    ).toBe(true);
    expect(
      lingerDue({ arrivedAtMs: ARRIVED, stillMoving: true, nowMs: ARRIVED + LINGER_AFTER_MS - 1 }),
    ).toBe(false);
  });
  it("a room that went quiet is not lingering — they left", () => {
    expect(
      lingerDue({ arrivedAtMs: ARRIVED, stillMoving: false, nowMs: ARRIVED + LINGER_AFTER_MS }),
    ).toBe(false);
  });
  it("no arrival, no linger — there is nobody to nag", () => {
    expect(lingerDue({ arrivedAtMs: null, stillMoving: true, nowMs: POST + 600_000 })).toBe(false);
  });

  it("defaults to two minutes (owner 2026-08-23), and honours a staff-set span", () => {
    expect(LINGER_AFTER_MS).toBe(120_000);
    // A shorter staff setting fires earlier than the default would.
    expect(
      lingerDue({
        arrivedAtMs: ARRIVED,
        stillMoving: true,
        nowMs: ARRIVED + 60_000,
        lingerAfterMs: 60_000,
      }),
    ).toBe(true);
    // A longer one holds past the default.
    expect(
      lingerDue({
        arrivedAtMs: ARRIVED,
        stillMoving: true,
        nowMs: ARRIVED + 120_000,
        lingerAfterMs: 300_000,
      }),
    ).toBe(false);
  });
});

describe("greetingStartMs — staff-set fallback delay", () => {
  it("uses the configured delay in fixed-timer mode", () => {
    expect(
      greetingStartMs({
        byMotion: false,
        postPlayedAtMs: POST,
        arrivedAtMs: null,
        motionHealthy: true,
        fallbackMs: 90_000,
      }),
    ).toBe(POST + 90_000);
  });

  it("uses it for the dead-camera fallback too", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: null,
        motionHealthy: false,
        fallbackMs: 30_000,
      }),
    ).toBe(POST + 30_000);
  });

  it("a real arrival still wins over the configured delay", () => {
    expect(
      greetingStartMs({
        byMotion: true,
        postPlayedAtMs: POST,
        arrivedAtMs: POST + 12_000,
        motionHealthy: true,
        fallbackMs: 90_000,
      }),
    ).toBe(POST + 12_000);
  });
});

describe("normaliseGreetingTiming", () => {
  it("passes through every value the sheet can send", () => {
    expect(
      normaliseGreetingTiming({ fallbackMs: 90_000, maxPlays: 1, lingerAfterMs: 300_000 }),
    ).toEqual({ fallbackMs: 90_000, maxPlays: 1, lingerAfterMs: 300_000 });
  });

  it("replaces anything off the choice list with that field's default", () => {
    // 0 plays would be a silent greeting nobody asked for; a 1ms delay would
    // greet an empty room. Neither is on the list, so neither survives.
    expect(normaliseGreetingTiming({ fallbackMs: 1, maxPlays: 0, lingerAfterMs: -5 })).toEqual(
      GREETING_TIMING_DEFAULTS,
    );
  });

  it("is field-by-field — one bad value cannot discard the good ones beside it", () => {
    expect(
      normaliseGreetingTiming({ fallbackMs: 60_000, maxPlays: 99, lingerAfterMs: 60_000 }),
    ).toEqual({
      fallbackMs: 60_000,
      maxPlays: GREETING_TIMING_DEFAULTS.maxPlays,
      lingerAfterMs: 60_000,
    });
  });

  it("survives junk, missing fields and non-objects alike", () => {
    expect(normaliseGreetingTiming(null)).toEqual(GREETING_TIMING_DEFAULTS);
    expect(normaliseGreetingTiming("45000")).toEqual(GREETING_TIMING_DEFAULTS);
    expect(normaliseGreetingTiming({})).toEqual(GREETING_TIMING_DEFAULTS);
    // Numeric strings are what a JSON round-trip or a form post can produce,
    // and they are legitimate as long as the VALUE is on the list.
    expect(normaliseGreetingTiming({ fallbackMs: "30000" }).fallbackMs).toBe(30_000);
  });

  it("defaults are 45s / 3 plays / 2 minutes", () => {
    expect(GREETING_TIMING_DEFAULTS).toEqual({
      fallbackMs: GREETING_FALLBACK_MS,
      maxPlays: 3,
      lingerAfterMs: 120_000,
    });
  });
});
