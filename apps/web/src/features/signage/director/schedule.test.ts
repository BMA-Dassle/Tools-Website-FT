import { describe, it, expect } from "vitest";
import { billboardStage, BILLBOARD_CYCLE_MS } from "~/features/kiosk/attract/billboard";
import { resolveScreenConfig } from "../defaults";
import type { SignageEvent, VipEntry } from "../types";
import {
  SLOT_MS,
  CROWN_WINDOW_MS,
  BIRTHDAY_SHOW_MS,
  buildRotation,
  rotationAt,
  totalSlots,
  crownActiveAt,
  celebrationAt,
  recentScans,
  vipTakeoverAt,
  isBowlingStep,
  minutesUntil,
  resolveActiveScene,
} from "./schedule";

const always = () => true;
const never = () => false;

function vipAt(iso: string, id = "v1"): VipEntry {
  return {
    id,
    title: "Sarah",
    comboName: "Ultimate VIP Experience",
    playerCount: 6,
    schedule: [
      {
        label: "Starter Race",
        iso: "2026-08-11T22:00:00.000Z",
        lane: null,
        location: null,
        durationMin: 20,
      },
      { label: "VIP Bowling", iso, lane: "11", location: "HeadPinz Fort Myers", durationMin: 90 },
    ],
  };
}

function evt(over: Partial<SignageEvent> = {}): SignageEvent {
  return {
    id: "e1",
    kind: "booking-completed",
    center: "fort-myers",
    atMs: 1_000_000,
    ...over,
  };
}

describe("slot quantization", () => {
  it("locks the rotation slot to the kiosk bank's billboard cycle", () => {
    // If these ever diverge, a TV can no longer join the bank on a boundary.
    expect(SLOT_MS).toBe(BILLBOARD_CYCLE_MS);
  });
});

describe("buildRotation", () => {
  const cfg = resolveScreenConfig(
    {
      playlist: [
        { scene: "event-welcome", slots: 2, requiresData: true },
        { scene: "ads", slots: 1 },
      ],
    },
    "HPFM",
  );

  it("keeps data-gated scenes when their data is present", () => {
    const segs = buildRotation(cfg.playlist, always);
    expect(segs.map((s) => s.scene)).toEqual(["event-welcome", "ads"]);
    expect(totalSlots(segs)).toBe(3);
  });

  it("closes over a data-gated scene with nothing to show", () => {
    // The failure this prevents: an empty welcome board rendering as a blank
    // panel on a lobby wall for 80 seconds.
    const segs = buildRotation(cfg.playlist, never);
    expect(segs.map((s) => s.scene)).toEqual(["ads"]);
    expect(totalSlots(segs)).toBe(1);
  });

  it("always yields something, even from an empty playlist", () => {
    const empty = resolveScreenConfig({ playlist: [] }, "HPFM");
    const segs = buildRotation(empty.playlist, never);
    expect(segs).toHaveLength(1);
    expect(segs[0].scene).toBe("ads");
  });
});

describe("rotationAt", () => {
  const segs = buildRotation(
    resolveScreenConfig(
      {
        playlist: [
          { scene: "event-welcome", slots: 2 },
          { scene: "ads", slots: 1 },
        ],
      },
      "HPFM",
    ).playlist,
    always,
  );

  it("walks the cycle in order and wraps", () => {
    const sceneAtSlot = (slot: number) => rotationAt(slot * SLOT_MS, segs).segment.scene;
    expect(sceneAtSlot(0)).toBe("event-welcome");
    expect(sceneAtSlot(1)).toBe("event-welcome");
    expect(sceneAtSlot(2)).toBe("ads");
    expect(sceneAtSlot(3)).toBe("event-welcome"); // wrapped
  });

  it("reports the segment start, not the slot start, so enters don't retrigger", () => {
    // Mid-way through the 2-slot welcome segment the animation must not restart.
    const a = rotationAt(0.5 * SLOT_MS, segs);
    const b = rotationAt(1.5 * SLOT_MS, segs);
    expect(a.startedAtMs).toBe(b.startedAtMs);
    expect(a.durationMs).toBe(2 * SLOT_MS);
  });

  it("is identical for two screens sharing a playlist — the sync property", () => {
    const now = 1_723_400_123_456;
    expect(rotationAt(now, segs)).toEqual(rotationAt(now, segs));
  });

  it("survives a negative clock", () => {
    expect(() => rotationAt(-SLOT_MS * 3.5, segs)).not.toThrow();
    expect(segs.map((s) => s.scene)).toContain(rotationAt(-SLOT_MS * 3.5, segs).segment.scene);
  });
});

describe("crownActiveAt", () => {
  const on = resolveScreenConfig(
    { interrupts: { "billboard-crown": { enabled: true, joinEvery: 1 } } },
    "HPFM",
  ).billboardCrown;

  it("pins CROWN_WINDOW_MS to the bank's real choreography", () => {
    // Derive the true window from billboard.ts rather than trusting arithmetic:
    // when the bank retunes its timeline, this fails instead of the crown
    // silently overstaying its welcome on the wall.
    const count = 5;
    let last = 0;
    for (let t = 0; t < BILLBOARD_CYCLE_MS; t += 10) {
      const anyLit = Array.from({ length: count }, (_, p) => billboardStage(t, p, count)).some(
        (s) => s.image || s.word || s.finale,
      );
      if (anyLit) last = t;
    }
    expect(CROWN_WINDOW_MS).toBeGreaterThanOrEqual(last);
    expect(CROWN_WINDOW_MS).toBeLessThan(last + 100);
  });

  it("is on for the show and off for the rest of the cycle", () => {
    expect(crownActiveAt(0, on)).toBe(true);
    expect(crownActiveAt(CROWN_WINDOW_MS - 1, on)).toBe(true);
    expect(crownActiveAt(CROWN_WINDOW_MS + 1, on)).toBe(false);
    expect(crownActiveAt(SLOT_MS - 1, on)).toBe(false);
  });

  it("honours joinEvery so a screen can sit cycles out", () => {
    const every3 = resolveScreenConfig(
      { interrupts: { "billboard-crown": { enabled: true, joinEvery: 3 } } },
      "HPFM",
    ).billboardCrown;
    expect(crownActiveAt(0, every3)).toBe(true);
    expect(crownActiveAt(SLOT_MS, every3)).toBe(false);
    expect(crownActiveAt(2 * SLOT_MS, every3)).toBe(false);
    expect(crownActiveAt(3 * SLOT_MS, every3)).toBe(true);
  });

  it("is off unless a screen opts in", () => {
    const off = resolveScreenConfig({}, "HPFM").billboardCrown;
    expect(off.enabled).toBe(false);
    expect(crownActiveAt(0, off)).toBe(false);
  });
});

describe("vipTakeoverAt", () => {
  const cfg = resolveScreenConfig({}, "HPFM").vip; // lead 10, floor 3
  const now = Date.parse("2026-08-11T23:00:00.000Z");
  const bowlingIn = (mins: number) => vipAt(new Date(now + mins * 60_000).toISOString());

  it("greets inside the window", () => {
    expect(vipTakeoverAt(now, [bowlingIn(8)], cfg, isBowlingStep)?.vip.title).toBe("Sarah");
  });

  it("stays quiet before the lead", () => {
    expect(vipTakeoverAt(now, [bowlingIn(20)], cfg, isBowlingStep)).toBeNull();
  });

  it("stops once they're walking up (past the floor)", () => {
    // Deliberate: a countdown that says "1 minute" to someone already at the
    // lanes is worse than showing nothing.
    expect(vipTakeoverAt(now, [bowlingIn(2)], cfg, isBowlingStep)).toBeNull();
    expect(vipTakeoverAt(now, [bowlingIn(-5)], cfg, isBowlingStep)).toBeNull();
  });

  it("ignores non-bowling legs", () => {
    const raceOnly: VipEntry = {
      id: "v2",
      title: "Marcus",
      comboName: null,
      playerCount: 4,
      schedule: [
        {
          label: "Starter Race",
          iso: new Date(now + 5 * 60_000).toISOString(),
          lane: null,
          location: null,
          durationMin: 20,
        },
      ],
    };
    expect(vipTakeoverAt(now, [raceOnly], cfg, isBowlingStep)).toBeNull();
  });

  it("greets the most urgent party when two overlap", () => {
    const picked = vipTakeoverAt(now, [bowlingIn(9), bowlingIn(5)], cfg, isBowlingStep);
    expect(picked?.minsUntil).toBeCloseTo(5, 5);
  });

  it("is silent when disabled or fed nothing", () => {
    const off = resolveScreenConfig(
      { interrupts: { "vip-welcome": { enabled: false } } },
      "HPFM",
    ).vip;
    expect(vipTakeoverAt(now, [bowlingIn(8)], off, isBowlingStep)).toBeNull();
    expect(vipTakeoverAt(now, null, cfg, isBowlingStep)).toBeNull();
  });

  it("tolerates an unparseable time", () => {
    expect(minutesUntil("not-a-date", now)).toBeNull();
    expect(minutesUntil(null, now)).toBeNull();
  });
});

describe("celebrationAt — full-screen takeovers only", () => {
  const cfg = resolveScreenConfig({}, "HPFM").celebration; // 90s, 8s show
  const now = 1_000_000;
  const bday = (over: Partial<SignageEvent> = {}) => evt({ birthday: true, ...over });

  it("does NOT take the screen over for an ordinary scan", () => {
    // Racers scan in bursts. A takeover each would queue a minute of them and
    // bury the session — ordinary scans belong on the rail (see recentScans).
    expect(celebrationAt(now, [evt({ atMs: now - 2_000 })], cfg, [], new Set())).toBeNull();
  });

  it("takes over for a birthday", () => {
    expect(celebrationAt(now, [bday({ atMs: now - 2_000 })], cfg, [], new Set())?.id).toBe("e1");
  });

  it("drops stale events rather than replaying old joy after an outage", () => {
    expect(celebrationAt(now, [bday({ atMs: now - 200_000 })], cfg, [], new Set())).toBeNull();
  });

  it("distrusts a future-stamped event (writer clock skew)", () => {
    expect(celebrationAt(now, [bday({ atMs: now + 60_000 })], cfg, [], new Set())).toBeNull();
  });

  it("never repeats one this screen already showed", () => {
    expect(celebrationAt(now, [bday({ atMs: now - 1000 })], cfg, [], new Set(["e1"]))).toBeNull();
  });

  it("takes the newest when several land at once", () => {
    const picked = celebrationAt(
      now,
      [bday({ id: "old", atMs: now - 30_000 }), bday({ id: "new", atMs: now - 1_000 })],
      cfg,
      [],
      new Set(),
    );
    expect(picked?.id).toBe("new");
  });

  it("respects screen scope — the Blue board ignores a Red Track birthday", () => {
    const blue = ["11208654"];
    expect(
      celebrationAt(
        now,
        [bday({ atMs: now - 1_000, resourceId: "11208660" })],
        cfg,
        blue,
        new Set(),
      ),
    ).toBeNull();
    expect(
      celebrationAt(
        now,
        [bday({ id: "b", atMs: now - 1_000, resourceId: "11208654" })],
        cfg,
        blue,
        new Set(),
      )?.id,
    ).toBe("b");
  });

  it("a scoped screen ignores events with no resource at all", () => {
    expect(
      celebrationAt(now, [bday({ atMs: now - 1_000 })], cfg, ["11208654"], new Set()),
    ).toBeNull();
  });
});

describe("recentScans — the live rail", () => {
  const now = 1_000_000;
  const scan = (id: string, agoMs: number, over: Partial<SignageEvent> = {}) =>
    evt({ id, kind: "racer-scanned", atMs: now - agoMs, ...over });

  it("shows a whole burst at once, newest first", () => {
    // The case this exists for: a party of eight through the desk in 20s.
    const burst = Array.from({ length: 8 }, (_, i) => scan(`r${i}`, i * 2_000));
    const rail = recentScans(now, burst, [], 90_000, 6);
    expect(rail).toHaveLength(6);
    expect(rail[0].id).toBe("r0");
    expect(rail[5].id).toBe("r5");
  });

  it("ages names off the rail", () => {
    const rail = recentScans(now, [scan("old", 200_000), scan("new", 1_000)], [], 90_000, 6);
    expect(rail.map((r) => r.id)).toEqual(["new"]);
  });

  it("obeys the screen's track scope", () => {
    const rail = recentScans(
      now,
      [
        scan("blue", 1_000, { resourceId: "11208654" }),
        scan("red", 1_000, { resourceId: "11208660" }),
      ],
      ["11208654"],
      90_000,
      6,
    );
    expect(rail.map((r) => r.id)).toEqual(["blue"]);
  });

  it("ignores anything that isn't a racer scan", () => {
    expect(recentScans(now, [evt({ atMs: now - 1_000 })], [], 90_000, 6)).toHaveLength(0);
  });
});

describe("resolveActiveScene precedence", () => {
  const config = resolveScreenConfig(
    {
      playlist: [{ scene: "ads", slots: 1 }],
      interrupts: { "billboard-crown": { enabled: true, joinEvery: 1 } },
    },
    "HPFM",
  );
  const now = Date.parse("2026-08-11T23:00:00.000Z");
  const base = {
    nowMs: now,
    config,
    hasData: always,
    vips: null,
    events: [] as SignageEvent[],
    seenEventIds: new Set<string>(),
  };

  it("sleep beats everything", () => {
    const d = resolveActiveScene({
      ...base,
      asleep: true,
      events: [evt({ atMs: now - 1_000 })],
      vips: [vipAt(new Date(now + 8 * 60_000).toISOString())],
    });
    expect(d.scene).toBe("sleep");
  });

  it("a birthday outranks a VIP takeover — that guest is standing right there", () => {
    const d = resolveActiveScene({
      ...base,
      events: [evt({ atMs: now - 1_000, birthday: true })],
      vips: [vipAt(new Date(now + 8 * 60_000).toISOString())],
    });
    expect(d.scene).toBe("celebration");
    expect(d.event?.id).toBe("e1");
    // A birthday holds both boards longer than an ordinary moment.
    expect(d.durationMs).toBe(BIRTHDAY_SHOW_MS);
  });

  it("an ordinary scan does NOT preempt anything — it belongs on the rail", () => {
    const d = resolveActiveScene({
      ...base,
      events: [evt({ atMs: now - 1_000 })],
      vips: [vipAt(new Date(now + 8 * 60_000).toISOString())],
    });
    expect(d.scene).toBe("vip-welcome");
  });

  it("VIP takeover outranks the crown and the rotation", () => {
    const d = resolveActiveScene({
      ...base,
      vips: [vipAt(new Date(now + 8 * 60_000).toISOString())],
    });
    expect(d.scene).toBe("vip-welcome");
    expect(d.isInterrupt).toBe(true);
  });

  it("crown rides over the rotation inside its window", () => {
    const cycleStart = Math.floor(now / SLOT_MS) * SLOT_MS;
    expect(resolveActiveScene({ ...base, nowMs: cycleStart + 1_000 }).scene).toBe(
      "billboard-crown",
    );
    expect(resolveActiveScene({ ...base, nowMs: cycleStart + CROWN_WINDOW_MS + 1_000 }).scene).toBe(
      "ads",
    );
  });

  it("falls all the way back to ads with no data and no events", () => {
    const d = resolveActiveScene({ ...base, hasData: never, nowMs: 0 + CROWN_WINDOW_MS + 1 });
    expect(d.scene).toBe("ads");
    expect(d.isInterrupt).toBe(false);
  });
});
