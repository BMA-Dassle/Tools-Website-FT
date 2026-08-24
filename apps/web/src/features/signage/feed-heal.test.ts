import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dropLastAttempt,
  healLogKey,
  pruneAttempts,
  readAttempts,
  recordAttempt,
  shouldHeal,
  FEED_HEAL_AFTER_MS,
  FEED_HEAL_MAX_ATTEMPTS,
  FEED_HEAL_WINDOW_MS,
} from "./feed-heal";
import { LIVENESS_STALE_MS } from "./liveness";

const NOW = 1_800_000_000_000;

/** A Storage stand-in — the policy takes the store so no DOM is needed. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    /** Test-only peek. */
    _raw: (k: string) => map.get(k) ?? null,
  };
}

describe("shouldHeal", () => {
  it("does nothing while the feed is healthy", () => {
    expect(shouldHeal({ ageMs: null, attempts: [], nowMs: NOW })).toBe(false);
    expect(shouldHeal({ ageMs: 2_000, attempts: [], nowMs: NOW })).toBe(false);
  });

  it("arms the moment the wall admits it is stale, and not a tick before", () => {
    // ONE THRESHOLD NOW, not two. These were held apart while a reload was
    // priced as expensive; it is not — arming only asks, and the gate still
    // refuses to navigate without proof. So the board starts fixing itself at
    // the moment it starts telling the room it is broken.
    expect(FEED_HEAL_AFTER_MS).toBe(LIVENESS_STALE_MS);
    expect(shouldHeal({ ageMs: FEED_HEAL_AFTER_MS, attempts: [], nowMs: NOW })).toBe(false);
    expect(shouldHeal({ ageMs: FEED_HEAL_AFTER_MS + 1, attempts: [], nowMs: NOW })).toBe(true);
  });

  it("still ignores anything short of that — a dropped beat is not a reload", () => {
    // The pulse lane is 2s with an 8s deadline, so 90s is ~45 consecutive
    // misses. A hiccup must never reach this.
    expect(shouldHeal({ ageMs: 20_000, attempts: [], nowMs: NOW })).toBe(false);
    expect(shouldHeal({ ageMs: 89_000, attempts: [], nowMs: NOW })).toBe(false);
  });

  it("stops after the cap, so a board whose feed stays broken cannot thrash", () => {
    // THE LOOP THIS EXISTS TO PREVENT: /api/kiosk/version answers (so the gate
    // opens) while the feed lane itself is broken — a bad deploy, a 500, a
    // screen id that no longer resolves. Staleness survives the reload, and
    // without this the board reloads every five minutes forever, in front of
    // guests, on every screen at once.
    const dead = 10 * 60_000;
    const recent = Array.from({ length: FEED_HEAL_MAX_ATTEMPTS }, (_, i) => NOW - (i + 1) * 60_000);
    expect(shouldHeal({ ageMs: dead, attempts: recent, nowMs: NOW })).toBe(false);
    expect(shouldHeal({ ageMs: dead, attempts: recent.slice(1), nowMs: NOW })).toBe(true);
  });

  it("forgives attempts once they age out of the window", () => {
    // Two unrelated bad moments hours apart must not add up to a screen that
    // has permanently lost the ability to heal itself.
    const old = Array.from(
      { length: FEED_HEAL_MAX_ATTEMPTS },
      (_, i) => NOW - FEED_HEAL_WINDOW_MS - (i + 1) * 60_000,
    );
    expect(shouldHeal({ ageMs: 10 * 60_000, attempts: old, nowMs: NOW })).toBe(true);
  });

  it("ignores stamps from the future rather than trusting them", () => {
    // A device clock that stepped backward would otherwise bank a full budget of
    // attempts it never made — or, worse, spend one it did.
    const future = [NOW + 60_000, NOW + 120_000, NOW + 180_000];
    expect(shouldHeal({ ageMs: 10 * 60_000, attempts: future, nowMs: NOW })).toBe(true);
  });

  it("honours caller-supplied policy", () => {
    expect(shouldHeal({ ageMs: 30_000, attempts: [], nowMs: NOW, healAfterMs: 10_000 })).toBe(true);
    expect(
      shouldHeal({
        ageMs: 30_000,
        attempts: [NOW - 1_000],
        nowMs: NOW,
        healAfterMs: 10_000,
        maxAttempts: 1,
      }),
    ).toBe(false);
  });
});

describe("pruneAttempts", () => {
  it("keeps only what is inside the window, oldest first", () => {
    const kept = pruneAttempts([NOW - 1_000, NOW - FEED_HEAL_WINDOW_MS - 1, NOW - 5_000], NOW);
    expect(kept).toEqual([NOW - 5_000, NOW - 1_000]);
  });

  it("drops nonsense instead of propagating it", () => {
    expect(pruneAttempts([Number.NaN, Number.POSITIVE_INFINITY, NOW - 1_000], NOW)).toEqual([
      NOW - 1_000,
    ]);
  });
});

describe("the attempt log", () => {
  it("is scoped per screen, so one sick panel cannot spend another's budget", () => {
    expect(healLogKey("FT:10")).toBe("tv_feed_heal:FT:10");
    expect(healLogKey("FT:9")).not.toBe(healLogKey("FT:10"));
  });

  it("round-trips an attempt", () => {
    const s = store();
    expect(recordAttempt(s, "FT:10", NOW)).toEqual([NOW]);
    expect(readAttempts(s, "FT:10")).toEqual([NOW]);
  });

  it("accumulates and prunes as it writes", () => {
    const s = store();
    recordAttempt(s, "FT:10", NOW - FEED_HEAL_WINDOW_MS - 1);
    recordAttempt(s, "FT:10", NOW - 60_000);
    expect(recordAttempt(s, "FT:10", NOW)).toEqual([NOW - 60_000, NOW]);
  });

  it("treats an unreadable log as empty rather than throwing on a wall", () => {
    // A corrupt entry must not be able to stop a board healing — and must never
    // throw inside a render on a screen nobody is standing at.
    expect(readAttempts(store({ "tv_feed_heal:FT:10": "not json" }), "FT:10")).toEqual([]);
    expect(readAttempts(store({ "tv_feed_heal:FT:10": '{"a":1}' }), "FT:10")).toEqual([]);
    expect(readAttempts(store({ "tv_feed_heal:FT:10": '[1,"x",null,2]' }), "FT:10")).toEqual([
      1, 2,
    ]);
    expect(readAttempts(store(), "FT:10")).toEqual([]);
  });

  it("still heals when storage refuses the write", () => {
    // Blocked or full storage means the attempt goes uncounted, not skipped.
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(() => recordAttempt(s, "FT:10", NOW)).not.toThrow();
    expect(recordAttempt(s, "FT:10", NOW)).toEqual([NOW]);
  });
});

describe("dropLastAttempt — an arm that never navigated costs nothing", () => {
  /**
   * WHY THIS HAD TO EXIST BEFORE THE THRESHOLD COULD COME DOWN TO 90s. The cap
   * stops a board RELOADING in front of guests; it was never meant to ration
   * wanting to. But the attempt is written at arm time, so a feed that came back
   * while the gate was still probing burned one of three for a blink nobody saw.
   * At five minutes that was rare. At 90s, on a venue that drops screens for a
   * minute at a time all evening, it would have spent the whole budget on blips
   * and left nothing for the wedge that mattered.
   */
  it("hands back only the newest attempt, leaving real ones counted", () => {
    const s = store({ [healLogKey("FT:10")]: JSON.stringify([NOW - 600_000, NOW]) });
    expect(dropLastAttempt(s, "FT:10")).toEqual([NOW - 600_000]);
    expect(readAttempts(s, "FT:10")).toEqual([NOW - 600_000]);
  });

  it("drops the NEWEST whatever order the log was written in", () => {
    // Never trust the stored order — a refund that removed the oldest would
    // quietly extend the rolling window instead of shortening the count.
    const s = store({ [healLogKey("FT:10")]: JSON.stringify([NOW, NOW - 600_000]) });
    expect(dropLastAttempt(s, "FT:10")).toEqual([NOW - 600_000]);
  });

  it("restores a capped board to being able to heal again", () => {
    // The point, end to end: three blips must not disarm the safety valve.
    const attempts = Array.from(
      { length: FEED_HEAL_MAX_ATTEMPTS },
      (_, i) => NOW - (i + 1) * 1_000,
    );
    const s = store({ [healLogKey("FT:10")]: JSON.stringify(attempts) });
    expect(shouldHeal({ ageMs: 120_000, attempts: readAttempts(s, "FT:10"), nowMs: NOW })).toBe(
      false,
    );
    dropLastAttempt(s, "FT:10");
    expect(shouldHeal({ ageMs: 120_000, attempts: readAttempts(s, "FT:10"), nowMs: NOW })).toBe(
      true,
    );
  });

  it("is harmless on an empty or unreadable log", () => {
    expect(dropLastAttempt(store(), "FT:10")).toEqual([]);
    expect(dropLastAttempt(store({ [healLogKey("FT:10")]: "{not json" }), "FT:10")).toEqual([]);
  });

  it("never throws when storage refuses the write", () => {
    const s = {
      getItem: () => JSON.stringify([NOW]),
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(() => dropLastAttempt(s, "FT:10")).not.toThrow();
  });
});

/** Resolved from this file, never the cwd — a pin that scans the wrong tree is a
 *  pin that passes where it was not asked. Same discipline as reload-gate.test. */
const TV_SHELL = join(dirname(fileURLToPath(import.meta.url)), "components", "TvShell.tsx");

describe("the self-heal gate is wired the one way that cannot deadlock", () => {
  it("is armed independently of safeToReload", () => {
    /**
     * THE DEADLOCK THIS PINS OUT, and the reason it is not obvious enough to
     * leave to a comment: every OTHER reload path on a wall deliberately waits
     * for a calm beat, so conjoining this one with `safeToReload` looks like
     * tidying two near-identical lines into a consistent pair. It is not.
     *
     * The scene decision is computed FROM THE FEED. A feed that wedges while a
     * celebration or a VIP takeover is on screen pins `decision.isInterrupt`
     * true for as long as it stays wedged — so the board would hold its own
     * recovery back precisely for as long as it needed it, and the calm beat it
     * is waiting for can never arrive.
     */
    const src = readFileSync(TV_SHELL, "utf8");
    // `healArmed` alone as the first argument — a second argument is allowed
    // (it selects the wedge escape, see reload-gate.ts), a conjunction is not.
    expect(src).toMatch(/useGatedReload\(\s*healArmed\s*[,)]/);
    expect(src).not.toMatch(/healArmed\s*&&\s*safeToReload/);
    expect(src).not.toMatch(/safeToReload\s*&&\s*healArmed/);
  });

  it("refunds the attempt on recovery, and ONLY on recovery", () => {
    /**
     * The refund is sound precisely because of where it sits: in the branch
     * that runs when the feed came back. If the gate had navigated, this page
     * would not be alive to run it. Calling it anywhere else — on a timer, or
     * beside recordAttempt — would uncap the board silently.
     */
    const src = readFileSync(TV_SHELL, "utf8");
    expect(src).toContain("dropLastAttempt(window.localStorage, screenId)");
    const calls = src.match(/dropLastAttempt\(/g) ?? [];
    expect(calls, "one refund site only").toHaveLength(1);
    // It must live above the `return` that ends the recovered branch, i.e.
    // before the code that decides whether to arm.
    expect(src.indexOf("dropLastAttempt(window.localStorage")).toBeLessThan(
      src.indexOf("recordAttempt(window.localStorage"),
    );
  });

  it("hands the wedge escape to THIS gate and to no other", () => {
    /**
     * The escape can navigate without our own origin having answered, so it is
     * safe only where the attempts are capped — which is this path, and only
     * this path (3 per rolling hour, per screen). The deploy and nightly-recycle
     * reloads above have no cap, so they keep the absolute rule: never navigate
     * until our origin answers.
     */
    const src = readFileSync(TV_SHELL, "utf8");
    expect(src).toMatch(/useGatedReload\(\s*healArmed\s*,\s*true\s*\)/);
    expect(src).toMatch(/useGatedReload\(updatePending && safeToReload\)/);
  });

  it("is actually reading the shell it claims to be", () => {
    // A pin that silently scans nothing is worse than no pin.
    const src = readFileSync(TV_SHELL, "utf8");
    expect(src).toContain("export function TvShell");
    // The OTHER gate must still be the guarded one — this pin would otherwise
    // pass just as happily on a shell that had dropped safeToReload entirely.
    expect(src).toContain("useGatedReload(updatePending && safeToReload)");
  });
});
