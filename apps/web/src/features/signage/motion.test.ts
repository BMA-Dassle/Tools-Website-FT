import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { TV_MOTION_PERIODS_MS } from "./clock";

/**
 * The TV's motion contract, checked against the stylesheet itself.
 *
 * Two failures this guards, both of which have actually happened:
 *
 *   1. A STALE TIMING TABLE. tv.css and TV_MOTION_PERIODS_MS have to agree or the
 *      seek lands at the wrong phase and screens de-sync — the 2026-07-19 kiosk
 *      glow bug, where the CSS was retuned and the table was not.
 *   2. A LOOPING FLASH THAT IS NOT REGISTERED AT ALL. Unregistered means never
 *      seeked, so each element starts its cycle whenever it happened to mount and
 *      two of them on ONE board flash at different moments — the 2026-08-12
 *      "4th of July" check-in board. tv-ready-flash, tv-overdue-flash and
 *      tv-bday-glow were all in that state.
 *
 * Reading the real CSS rather than restating the numbers is the point: a test
 * that holds its own copy of the durations cannot detect either failure.
 */

const css = readFileSync(new URL("../../../app/tv/tv.css", import.meta.url), "utf8");

/** Every `animation: <name> <duration> …` shorthand declared in tv.css. */
const declarations = [...css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)(ms|s)([^;]*);/g)].map(
  ([, name, value, unit, rest]) => ({
    name,
    ms: Number(value) * (unit === "s" ? 1000 : 1),
    infinite: rest.includes("infinite"),
    // A there-and-back animation's seekable cycle is twice its declared length.
    alternate: rest.includes("alternate"),
  }),
);

const looping = declarations.filter((d) => d.infinite);

/**
 * The attention effects — the ones a person reads as "that is flashing at me".
 * They share ONE beat so a board reads as one instrument. 2800ms is allowed
 * because half of it is 1400, so a slow swell still crests on a beat.
 */
const TV_BEAT_MS = 1400;
const BEAT_FAMILY = [
  "tv-blink",
  "tv-ready-flash",
  "tv-overdue-flash",
  "tv-bday-glow",
  "tv-breathe",
  "tv-chev",
];

describe("TV motion", () => {
  it("finds the stylesheet's looping animations", () => {
    // Guards the parse itself — a regex that silently matched nothing would make
    // every assertion below vacuously pass.
    expect(looping.length).toBeGreaterThanOrEqual(9);
    expect(looping.map((d) => d.name)).toContain("tv-blink");
  });

  it("registers every looping animation in the timing table", () => {
    const unregistered = looping.filter((d) => !(d.name in TV_MOTION_PERIODS_MS));
    expect(unregistered.map((d) => d.name)).toEqual([]);
  });

  it("agrees with the stylesheet on every period", () => {
    for (const d of looping) {
      expect(TV_MOTION_PERIODS_MS[d.name], `${d.name} period`).toBe(d.ms * (d.alternate ? 2 : 1));
    }
  });

  it("keeps no entry for an animation the stylesheet no longer declares", () => {
    const names = new Set(looping.map((d) => d.name));
    expect(Object.keys(TV_MOTION_PERIODS_MS).filter((k) => !names.has(k))).toEqual([]);
  });

  it("runs every attention flash on the beat", () => {
    for (const name of BEAT_FAMILY) {
      const period = TV_MOTION_PERIODS_MS[name];
      expect(period, `${name} is missing from the timing table`).toBeGreaterThan(0);
      // 1.4s or an exact multiple: anything else beats against its neighbours.
      expect(period % TV_BEAT_MS, `${name} (${period}ms) is off the ${TV_BEAT_MS}ms beat`).toBe(0);
    }
  });

  it("turns the same-period flashes around at the same instants", () => {
    // Matching periods are necessary but not sufficient: at the SAME period, an
    // effect that turns around somewhere other than 0%/50% swings against its
    // neighbours even though both cycles are 1.4s long. Every member of the beat
    // family is therefore ONE symmetric excursion — it starts and ends on the
    // same frame and turns once, in the middle — so they all change direction
    // together. (WHICH end is the loud one is the polarity rule documented in
    // tv.css; a hex colour and a box-shadow radius have no common unit, so that
    // half is read by eye rather than measured here.)
    const atBeat = BEAT_FAMILY.filter((n) => TV_MOTION_PERIODS_MS[n] === TV_BEAT_MS);
    expect(atBeat.length).toBeGreaterThanOrEqual(4);

    for (const name of atBeat) {
      const stops = keyframeStops(name);
      expect(stops["0"], `${name} has no 0% stop`).toBeTruthy();
      expect(stops["100"], `${name} has no 100% stop`).toBeTruthy();
      expect(stops["50"], `${name} has no 50% stop`).toBeTruthy();
      // Ends where it began: no net drift across a cycle.
      expect(stops["100"], `${name} must end on the frame it started`).toBe(stops["0"]);
      // ...and actually goes somewhere in between.
      expect(stops["50"], `${name} does not move`).not.toBe(stops["0"]);
    }
  });
});

/** Every stop of a @keyframes block, as `{ [percent]: declarations }`. */
function keyframeStops(name: string): Record<string, string> {
  const block = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  expect(block, `no @keyframes for ${name}`).toBeTruthy();

  const stops: Record<string, string> = {};
  for (const [, selector, body] of block!.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const declarations = body.replace(/\s+/g, " ").trim();
    for (const [, percent] of selector.matchAll(/([\d.]+)%/g)) stops[percent] = declarations;
  }
  return stops;
}
