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
  isRacingBoard,
  recentScans,
  vipCandidatesAt,
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
    comboName: "VIP Experience",
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

describe("VIP greeting window (candidates feed the welcome rotation)", () => {
  const cfg = resolveScreenConfig({}, "HPFM").vip; // lead 10, floor 3
  const now = Date.parse("2026-08-11T23:00:00.000Z");
  const bowlingIn = (mins: number, id = "v1") =>
    vipAt(new Date(now + mins * 60_000).toISOString(), id);

  it("greets inside the window", () => {
    expect(vipCandidatesAt(now, [bowlingIn(8)], cfg, isBowlingStep)[0]?.vip.title).toBe("Sarah");
  });

  it("stays quiet before the lead", () => {
    expect(vipCandidatesAt(now, [bowlingIn(20)], cfg, isBowlingStep)).toHaveLength(0);
  });

  it("stops once they're walking up (past the floor)", () => {
    expect(vipCandidatesAt(now, [bowlingIn(2)], cfg, isBowlingStep)).toHaveLength(0);
    expect(vipCandidatesAt(now, [bowlingIn(-5)], cfg, isBowlingStep)).toHaveLength(0);
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
    expect(vipCandidatesAt(now, [raceOnly], cfg, isBowlingStep)).toHaveLength(0);
  });

  it("carries EVERY in-window party, most urgent first", () => {
    // They all appear on the gold slide together (owner 2026-08-11).
    const out = vipCandidatesAt(
      now,
      [bowlingIn(9, "party-a"), bowlingIn(5, "party-b")],
      cfg,
      isBowlingStep,
    );
    expect(out.map((c) => c.vip.id)).toEqual(["party-b", "party-a"]);
  });

  it("is silent when disabled or fed nothing", () => {
    const off = resolveScreenConfig(
      { interrupts: { "vip-welcome": { enabled: false } } },
      "HPFM",
    ).vip;
    expect(vipCandidatesAt(now, [bowlingIn(8)], off, isBowlingStep)).toHaveLength(0);
    expect(vipCandidatesAt(now, null, cfg, isBowlingStep)).toHaveLength(0);
  });

  it("tolerates an unparseable time", () => {
    expect(minutesUntil("not-a-date", now)).toBeNull();
    expect(minutesUntil(null, now)).toBeNull();
  });
});

describe("celebrationAt — full-screen takeovers only", () => {
  const cfg = resolveScreenConfig({}, "HPFM").celebration; // 90s, 8s show
  const now = 1_000_000;
  // Birthdays arrive from the race-check-in scan seam, so the fixture carries
  // that kind — a lobby board must ignore them by KIND, and the booking events
  // it does celebrate are covered separately below.
  const bday = (over: Partial<SignageEvent> = {}) =>
    evt({ kind: "racer-scanned", birthday: true, ...over });

  it("does NOT take the screen over for an ordinary scan", () => {
    // Racers scan in bursts. A takeover each would queue a minute of them and
    // bury the session — ordinary scans belong on the rail (see recentScans).
    expect(celebrationAt(now, [evt({ atMs: now - 2_000 })], cfg, [], new Set(), true)).toBeNull();
  });

  it("takes over for a birthday", () => {
    expect(celebrationAt(now, [bday({ atMs: now - 2_000 })], cfg, [], new Set(), true)?.id).toBe(
      "e1",
    );
  });

  it("drops stale events rather than replaying old joy after an outage", () => {
    expect(
      celebrationAt(now, [bday({ atMs: now - 200_000 })], cfg, [], new Set(), true),
    ).toBeNull();
  });

  it("distrusts a future-stamped event (writer clock skew)", () => {
    expect(celebrationAt(now, [bday({ atMs: now + 60_000 })], cfg, [], new Set(), true)).toBeNull();
  });

  it("never repeats one this screen already showed", () => {
    expect(
      celebrationAt(now, [bday({ atMs: now - 1000 })], cfg, [], new Set(["e1"]), true),
    ).toBeNull();
  });

  it("takes the newest when several land at once", () => {
    const picked = celebrationAt(
      now,
      [bday({ id: "old", atMs: now - 30_000 }), bday({ id: "new", atMs: now - 1_000 })],
      cfg,
      [],
      new Set(),
      true,
    );
    expect(picked?.id).toBe("new");
  });

  it("a birthday fires on BOTH boards, whatever track it came from", () => {
    // Birthday check-in happens at race check-in downstairs, which serves both
    // tracks — one building-wide moment. Scoping it by track is what made only
    // one board light up (owner 2026-08-11).
    const blueBoard = ["11208654"];
    const redBoard = ["11208660"];
    const scanOnBlue = bday({ atMs: now - 1_000, resourceId: "11208654" });
    expect(celebrationAt(now, [scanOnBlue], cfg, blueBoard, new Set(), true)?.id).toBe("e1");
    expect(celebrationAt(now, [scanOnBlue], cfg, redBoard, new Set(), true)?.id).toBe("e1");
  });

  it("fires even with no resource on the event at all", () => {
    expect(
      celebrationAt(now, [bday({ atMs: now - 1_000 })], cfg, ["11208654"], new Set(), true)?.id,
    ).toBe("e1");
  });

  it("does NOT fire on a screen that is not a karting board", () => {
    // A lobby TV across the building has no part in a race check-in.
    expect(celebrationAt(now, [bday({ atMs: now - 1_000 })], cfg, [], new Set(), false)).toBeNull();
  });

  it("a LOBBY board celebrates kiosk bookings and check-ins", () => {
    // The guest is standing at the bank directly below the screen — reacting
    // to them is the point of hanging it there (owner: "kiosk interactions can
    // interrupt").
    const booking = evt({ kind: "booking-completed", atMs: now - 1_000 });
    const checkin = evt({ id: "e2", kind: "checkin-completed", atMs: now - 500 });
    expect(celebrationAt(now, [booking], cfg, [], new Set(), false)?.id).toBe("e1");
    expect(celebrationAt(now, [checkin], cfg, [], new Set(), false)?.id).toBe("e2");
  });

  it("a KARTING board ignores kiosk bookings — its takeover is birthdays only", () => {
    const booking = evt({ kind: "booking-completed", atMs: now - 1_000 });
    expect(celebrationAt(now, [booking], cfg, [], new Set(), true)).toBeNull();
  });

  it("an ordinary racer scan is never a takeover anywhere", () => {
    const scan = evt({ kind: "racer-scanned", atMs: now - 1_000 });
    expect(celebrationAt(now, [scan], cfg, [], new Set(), true)).toBeNull();
    expect(celebrationAt(now, [scan], cfg, [], new Set(), false)).toBeNull();
  });
});

describe("events-first mode — ads as pure filler", () => {
  // Ads UNTICKED: the playlist is just the data-gated welcome board. The
  // owner's ask (2026-08-11): "ads shown only when no events or vips". Pinned
  // as a contract, not an accident of the empty-playlist fallback.
  const eventsFirst = resolveScreenConfig(
    { playlist: [{ scene: "event-welcome", slots: 2, requiresData: true }] },
    "HPFM",
  );

  it("with parties today, the board is welcome wall to wall — zero ads", () => {
    const segs = buildRotation(eventsFirst.playlist, always);
    expect(segs.map((x) => x.scene)).toEqual(["event-welcome"]);
  });

  it("with no parties, ads fill in — a wall never goes blank", () => {
    const segs = buildRotation(eventsFirst.playlist, never);
    expect(segs.map((x) => x.scene)).toEqual(["ads"]);
  });
});

describe("isRacingBoard", () => {
  it("is true only when the screen runs the check-in scene", () => {
    const racing = resolveScreenConfig({ playlist: [{ scene: "race-checkin" }] }, "FT");
    const lobby = resolveScreenConfig(
      { playlist: [{ scene: "event-welcome" }, { scene: "ads" }] },
      "HPFM",
    );
    expect(isRacingBoard(racing.playlist)).toBe(true);
    expect(isRacingBoard(lobby.playlist)).toBe(false);
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
  // A racing board: birthdays only take over screens that run check-in.
  const config = resolveScreenConfig(
    {
      playlist: [
        { scene: "ads", slots: 1 },
        { scene: "race-checkin", slots: 1 },
      ],
      interrupts: { "billboard-crown": { enabled: true, joinEvery: 1 } },
    },
    "HPFM",
  );
  const now = Date.parse("2026-08-11T23:00:00.000Z");
  const base = {
    nowMs: now,
    config,
    hasData: always,
    events: [] as SignageEvent[],
    seenEventIds: new Set<string>(),
  };

  it("sleep beats everything", () => {
    const d = resolveActiveScene({
      ...base,
      asleep: true,
      events: [evt({ atMs: now - 1_000, kind: "racer-scanned", birthday: true })],
    });
    expect(d.scene).toBe("sleep");
  });

  it("a birthday takes the racing boards — that guest is standing right there", () => {
    const d = resolveActiveScene({
      ...base,
      events: [evt({ atMs: now - 1_000, kind: "racer-scanned", birthday: true })],
    });
    expect(d.scene).toBe("celebration");
    expect(d.event?.id).toBe("e1");
    // A birthday holds both boards longer than an ordinary moment.
    expect(d.durationMs).toBe(BIRTHDAY_SHOW_MS);
  });

  it("VIP is NOT an interrupt — nothing here can decide vip-welcome", () => {
    // Owner 2026-08-11: "it shouldn't just take over everything". VIP parties
    // are a gold slide inside the welcome board's rotation, so the scheduler
    // has no VIP branch at all — whatever else is going on wins the frame.
    const d = resolveActiveScene({
      ...base,
      events: [evt({ atMs: now - 1_000, kind: "racer-scanned" })],
    });
    expect(d.scene).not.toBe("vip-welcome");
    expect(d.scene).not.toBe("celebration"); // ordinary scans stay on the rail
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

describe("recentScans — one entry per racer", () => {
  const NOW = 1_760_000_000_000;
  const scan = (personId: string, sessionId: string, agoMs: number, over = {}) => ({
    id: `scan-${personId}-${sessionId}-${NOW - agoMs}`,
    kind: "racer-scanned" as const,
    center: "fort-myers",
    firstName: `P${personId}`,
    atMs: NOW - agoMs,
    ...over,
  });

  it("shows a racer ONCE however many times they swipe", () => {
    // The reported bug: someone scanned four times and landed on the board four
    // times (owner 2026-08-11).
    const events = [
      scan("111", "60", 1_000),
      scan("111", "60", 4_000),
      scan("111", "60", 8_000),
      scan("111", "60", 12_000),
    ];
    const out = recentScans(NOW, events, [], 90_000, 10);
    expect(out).toHaveLength(1);
  });

  it("keeps the NEWEST swipe, which carries current state", () => {
    const events = [
      scan("111", "60", 9_000, { headsockDue: true }),
      scan("111", "60", 1_000, { headsockDue: false }),
    ];
    const out = recentScans(NOW, events, [], 90_000, 10);
    expect(out).toHaveLength(1);
    expect(out[0].headsockDue).toBe(false);
    expect(out[0].atMs).toBe(NOW - 1_000);
  });

  it("keeps different racers separate", () => {
    const out = recentScans(
      NOW,
      [scan("111", "60", 1_000), scan("222", "60", 2_000), scan("333", "60", 3_000)],
      [],
      90_000,
      10,
    );
    expect(out).toHaveLength(3);
  });

  it("treats the same racer in a LATER heat as a new entry", () => {
    // Legitimately checking in again for their next race — not a duplicate.
    const out = recentScans(
      NOW,
      [scan("111", "61", 1_000), scan("111", "60", 5_000)],
      [],
      90_000,
      10,
    );
    expect(out).toHaveLength(2);
  });

  it("prefers the explicit racerKey over the id shape", () => {
    const out = recentScans(
      NOW,
      [
        { ...scan("111", "60", 1_000), id: "a", racerKey: "111:60" },
        { ...scan("111", "60", 3_000), id: "b", racerKey: "111:60" },
      ],
      [],
      90_000,
      10,
    );
    expect(out).toHaveLength(1);
  });

  it("dedupes events published BEFORE racerKey existed, via the id", () => {
    // The rail holds an hour, so the fix must work on events already on it —
    // otherwise it appears to do nothing for the first hour after a deploy.
    const out = recentScans(
      NOW,
      [scan("111", "60", 1_000), scan("111", "60", 6_000)],
      [],
      90_000,
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0].racerKey).toBeUndefined();
  });

  it("leaves un-keyable events (simulated scans) alone", () => {
    const sim = (i: number) => ({
      id: `sim-${i}`,
      kind: "racer-scanned" as const,
      center: "fort-myers",
      firstName: "Marcus",
      atMs: NOW - i * 1_000,
    });
    expect(recentScans(NOW, [sim(1), sim(2), sim(3)], [], 90_000, 10)).toHaveLength(3);
  });

  it("still honours the limit and the window", () => {
    const many = Array.from({ length: 12 }, (_, i) => scan(String(i), "60", i * 1_000));
    expect(recentScans(NOW, many, [], 90_000, 6)).toHaveLength(6);
    expect(recentScans(NOW, [scan("111", "60", 200_000)], [], 90_000, 10)).toHaveLength(0);
  });
});
