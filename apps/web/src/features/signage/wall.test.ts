import { describe, it, expect } from "vitest";
import {
  choreo,
  wallSpan,
  spanRange,
  wallCentre,
  isWallCentre,
  atWallPosition,
  wallBrand,
  SOLO,
} from "./wall";
import { resolveScreenConfig, rolePreset, screenShowsScene } from "./defaults";
import { resolveActiveScene, SLOT_MS } from "./director/schedule";
import { isSceneImplemented } from "./scenes/registry";
import type { SceneType } from "./types";

/**
 * The front-desk wall's geometry, and the ONE claim that makes it additive:
 * a screen carrying only `pairing` behaves exactly as it did before `wall`
 * existed. Every karting board in production is such a screen.
 */

const FRONT_DESK = { wallId: "hpfm-front-desk", count: 5, gapPct: 12 };

describe("choreo — which field wins", () => {
  it("a lone screen is its own group of one", () => {
    expect(choreo({ wall: null, pairing: null })).toEqual(SOLO);
  });

  it("a screen with only pairing is choreographed by its pairing — the karting boards", () => {
    const red = choreo({ wall: null, pairing: { groupId: "ft-tracks", position: 1, count: 2 } });
    expect(red.position).toBe(1);
    expect(red.count).toBe(2);
  });

  it("a pairing contributes NO gap — those boards are four feet apart", () => {
    // Reporting 0% would read as "bezel to bezel" and invite a spanning layout
    // across four feet of wall, which is the one thing the karting rule forbids.
    // Nothing consumes gapPct unless it is painting across a wall, and only a
    // wall has one.
    expect(choreo({ wall: null, pairing: { groupId: "ft", position: 0, count: 2 } }).gapPct).toBe(
      0,
    );
  });

  it("wall WINS over pairing — the wall is the object the audience sees", () => {
    // Front-desk TVs 1 and 2 share player A, so they carry BOTH fields. If
    // pairing won, the five-panel show would split into two 2-panel shows and
    // a lone screen, each running its own composition.
    const tv2 = choreo({
      wall: { ...FRONT_DESK, position: 1 },
      pairing: { groupId: "hpfm-fd-a", position: 1, count: 2 },
    });
    expect(tv2).toEqual({ position: 1, count: 5, gapPct: 12, inSpan: true });
  });

  it("every panel of the wall agrees on the count, whatever its pairing says", () => {
    const counts = [0, 1, 2, 3, 4].map(
      (position) =>
        choreo({
          wall: { ...FRONT_DESK, position },
          // TV 3 is unpaired; the rest are halves of a 2-monitor player.
          pairing: position === 2 ? null : { groupId: "p", position: position % 2, count: 2 },
        }).count,
    );
    expect(counts).toEqual([5, 5, 5, 5, 5]);
  });
});

describe("choreo — resolveScreenConfig is the real caller", () => {
  it("a config with no wall resolves to a solo choreo", () => {
    expect(choreo(resolveScreenConfig({ playlist: [{ scene: "ads" }] }, "HPFM"))).toEqual(SOLO);
  });

  it("THE EQUIVALENCE: a pairing-only board is unchanged by wall existing", () => {
    // A production karting board, verbatim in shape. Its choreography must be
    // exactly position/count off its pairing — this is what lets the front-desk
    // work ship without touching a single track screen.
    const blue = resolveScreenConfig(
      {
        playlist: [{ scene: "race-checkin", slots: 3 }],
        scope: { resourceIds: ["11208654"] },
        pairing: { groupId: "ft-tracks", position: 0, count: 2 },
      },
      "FT",
    );
    expect(blue.wall).toBeNull();
    expect(choreo(blue)).toEqual({ position: 0, count: 2, gapPct: 0, inSpan: true });
    expect(choreo(blue).position).toBe(blue.pairing!.position);
    expect(choreo(blue).count).toBe(blue.pairing!.count);
  });

  it("a stored wall survives resolution, gap and all", () => {
    const c = resolveScreenConfig(
      { wall: { wallId: "hpfm-front-desk", position: 3, count: 5, gapPct: 12 } },
      "HPFM",
    );
    expect(c.wall).toEqual({
      wallId: "hpfm-front-desk",
      position: 3,
      count: 5,
      gapPct: 12,
      brand: null,
      outsideScene: null,
    });
    expect(choreo(c)).toEqual({ position: 3, count: 5, gapPct: 12, inSpan: true });
  });

  it("gapPct defaults to 12 — ~6 inches on a ~48in picture (owner 2026-08-17)", () => {
    const c = resolveScreenConfig({ wall: { wallId: "w", position: 0, count: 5 } }, "HPFM");
    expect(c.wall?.gapPct).toBe(12);
  });

  it('an explicit "none" brand SURVIVES resolution, so "No mark" in the form works', () => {
    // Collapsing "none" to null would make wallBrand derive a mark for an end
    // panel that was deliberately told not to carry one.
    const c = resolveScreenConfig(
      { wall: { wallId: "w", position: 0, count: 5, brand: "none" } },
      "HPFM",
    );
    expect(c.wall?.brand).toBe("none");
    expect(wallBrand(0, 5, c.wall?.brand)).toBeNull();
  });

  it("a nonsense wall is CLAMPED, never discarded — the CONFIG_VERSION contract", () => {
    const c = resolveScreenConfig(
      // Position past the end, count below one, absurd gap: every one of these
      // is a fat-fingered admin field, and a screen that has run unattended for
      // weeks must not go dark over one.
      { wall: { wallId: "w", position: 99, count: 0, gapPct: 5000 } },
      "HPFM",
    );
    expect(c.wall).toEqual({
      wallId: "w",
      position: 0,
      count: 1,
      gapPct: 100,
      brand: null,
      outsideScene: null,
    });
  });

  it("a wall with no id is not a wall", () => {
    // wallId is what groups the panels. Without it there is no group, and
    // adopting a nameless one would make a lone screen render one fifth of a
    // composition.
    expect(
      resolveScreenConfig({ wall: { position: 2, count: 5 } as never }, "HPFM").wall,
    ).toBeNull();
  });

  it("an unknown brand is derived, not trusted", () => {
    const c = resolveScreenConfig(
      { wall: { wallId: "w", position: 0, count: 5, brand: "acme" as never } },
      "HPFM",
    );
    expect(c.wall?.brand).toBeNull();
    expect(wallBrand(0, 5, c.wall?.brand ?? undefined)).toBe("fasttrax");
  });
});

describe("spans — the wall stays five panels, scenes use some of them", () => {
  const FD = { wallId: "hpfm-front-desk", count: 5, gapPct: 12 };
  const at = (position: number, span: "wall" | "middle") =>
    choreo({ wall: { ...FD, position }, pairing: null }, span);

  it("a wall-span scene reaches every panel, positions 0..4", () => {
    expect([0, 1, 2, 3, 4].map((p) => at(p, "wall"))).toEqual([
      { position: 0, count: 5, gapPct: 12, inSpan: true },
      { position: 1, count: 5, gapPct: 12, inSpan: true },
      { position: 2, count: 5, gapPct: 12, inSpan: true },
      { position: 3, count: 5, gapPct: 12, inSpan: true },
      { position: 4, count: 5, gapPct: 12, inSpan: true },
    ]);
  });

  it("a MIDDLE-span scene is a THREE-panel scene, and says so", () => {
    // The point of a span-relative position: a 3-wide scene composes over 0..2 and
    // never has to know two more panels exist either side of it.
    expect(at(1, "middle")).toMatchObject({ position: 0, count: 3, inSpan: true });
    expect(at(2, "middle")).toMatchObject({ position: 1, count: 3, inSpan: true });
    expect(at(3, "middle")).toMatchObject({ position: 2, count: 3, inSpan: true });
  });

  it("the WINGS are outside a middle span", () => {
    expect(at(0, "middle").inSpan).toBe(false);
    expect(at(4, "middle").inSpan).toBe(false);
  });

  it("spanRange drops one panel from each end, and never empties a narrow wall", () => {
    expect(spanRange("middle", 5)).toEqual({ first: 1, last: 3 });
    expect(spanRange("wall", 5)).toEqual({ first: 0, last: 4 });
    // Two panels have no middle to speak of; dropping both ends would leave nothing.
    expect(spanRange("middle", 2)).toEqual({ first: 0, last: 1 });
    expect(spanRange("middle", 1)).toEqual({ first: 0, last: 0 });
    // Three panels: the middle IS the centre one.
    expect(spanRange("middle", 3)).toEqual({ first: 1, last: 1 });
  });

  it("a screen off a wall ignores spans entirely", () => {
    // Otherwise a `middle` entry would blank every single-screen board in the estate.
    expect(choreo({ wall: null, pairing: null }, "middle")).toEqual(SOLO);
    expect(
      choreo({ wall: null, pairing: { groupId: "ft", position: 1, count: 2 } }, "middle"),
    ).toMatchObject({ position: 1, count: 2, inSpan: true });
  });
});

describe("wallSpan — the virtual canvas includes the gaps", () => {
  it("a solo screen owns the whole canvas", () => {
    expect(wallSpan(0, 1, 0)).toEqual({ start: 0, end: 1 });
  });

  it("five panels at 12% span the wall end to end with no overlap", () => {
    const spans = [0, 1, 2, 3, 4].map((p) => wallSpan(p, 5, 12));
    expect(spans[0].start).toBeCloseTo(0, 10);
    expect(spans[4].end).toBeCloseTo(1, 10);
    for (let i = 1; i < spans.length; i++) {
      // Each panel starts AFTER the previous one ends — the difference is the gap.
      expect(spans[i].start).toBeGreaterThan(spans[i - 1].end);
    }
  });

  it("the wall is 5.48 panel-widths wide, so one panel is 1/5.48 of it", () => {
    // 5 panels + 4 gaps of 12% = 5.48. Getting this wrong is how a wall-wide
    // gradient ends up moving at a different speed than the eye expects.
    const { start, end } = wallSpan(0, 5, 12);
    expect(end - start).toBeCloseTo(1 / 5.48, 10);
    expect(wallSpan(4, 5, 12).start).toBeCloseTo((4 * 1.12) / 5.48, 10);
  });

  it("with no gap the panels tile exactly", () => {
    expect(wallSpan(2, 5, 0)).toEqual({ start: 0.4, end: 0.6000000000000001 });
  });

  it("garbage in never produces an inverted or unlit span", () => {
    for (const args of [
      [NaN, 5, 12],
      [2, NaN, 12],
      [2, 5, NaN],
      [-3, 5, 12],
      [9, 5, 12],
      [0, -1, -5],
    ] as const) {
      const s = wallSpan(...(args as [number, number, number]));
      expect(Number.isFinite(s.start)).toBe(true);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeLessThanOrEqual(1);
    }
  });
});

describe("wallCentre / isWallCentre", () => {
  it("the middle panel of five is centred on the wall", () => {
    expect(wallCentre(2, 5, 12)).toBeCloseTo(0.5, 10);
  });

  it("TV 3 is the centre — where a guest's name lands whole", () => {
    expect([0, 1, 2, 3, 4].map((p) => isWallCentre(p, 5))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("an even wall has no centre", () => {
    expect([0, 1, 2, 3].some((p) => isWallCentre(p, 4))).toBe(false);
  });

  it("a solo screen is its own centre, so a name still lands on it", () => {
    expect(isWallCentre(0, 1)).toBe(true);
  });
});

describe("atWallPosition — one item per panel", () => {
  const LEGS = ["hours", "starter", "bowling", "intermediate", "booking"];

  it("each panel takes its own leg", () => {
    expect([0, 1, 2, 3, 4].map((p) => atWallPosition(LEGS, p))).toEqual(LEGS);
  });

  it("a panel past the end of the list gets NULL, never a repeat", () => {
    // Repeating would claim the night has two leg threes. The kiosk bank repeats
    // its last billboard slide on purpose ("…and more"); an itinerary may not.
    expect(atWallPosition(LEGS, 5)).toBeNull();
    expect(atWallPosition(LEGS, 99)).toBeNull();
    expect(atWallPosition(LEGS, -1)).toBeNull();
  });
});

describe("wallBrand — marks bookend the wall", () => {
  it("derives FastTrax left, HeadPinz right, nothing in between", () => {
    expect([0, 1, 2, 3, 4].map((p) => wallBrand(p, 5, undefined))).toEqual([
      "fasttrax",
      null,
      null,
      null,
      "headpinz",
    ]);
  });

  it("config wins, so the ends can be swapped without a deploy", () => {
    // Which way the room faces is a fact about the building (plan, open
    // decision 1) — staff must be able to swap the two marks in the admin form.
    expect(wallBrand(0, 5, "headpinz")).toBe("headpinz");
    expect(wallBrand(4, 5, "fasttrax")).toBe("fasttrax");
  });

  it('an explicit "none" silences an end', () => {
    expect(wallBrand(0, 5, "none")).toBeNull();
  });

  it("a solo screen carries no wall mark", () => {
    expect(wallBrand(0, 1, undefined)).toBeNull();
  });
});

describe("the wings — what a panel outside the span actually renders", () => {
  const FD = { wallId: "hpfm-front-desk", position: 0, count: 5, gapPct: 12 };

  /** The front-desk playlist, resolved: 7 slots of pricing, 2 of the VIP showcase,
   *  both spanning the whole wall. Position and the wing's own scene vary per panel.
   *
   *  BOTH ARE `wall` AND THEY MEAN DIFFERENT THINGS BY IT — the showcase is one
   *  picture that needs all five, the menu board is five independent panels and is in
   *  `YIELDS_TO_WINGS`, so the ends keep their own boards when those have something to
   *  say. These tests are what hold that difference in place. */
  const screen = (position: number, outsideScene?: string) =>
    resolveScreenConfig(
      {
        playlist: [
          { scene: "open-now", slots: 7, span: "wall" },
          { scene: "vip-showcase", slots: 2, span: "wall" },
        ],
        wall: { ...FD, position, ...(outsideScene ? { outsideScene } : {}) },
      } as never,
      "HPFM",
    );

  /** What this panel shows at `slot` of the nine. */
  const sceneAt = (
    position: number,
    slot: number,
    outsideScene?: string,
    hasData: (s: SceneType) => boolean = () => true,
  ) =>
    resolveActiveScene({
      nowMs: slot * SLOT_MS + 5_000,
      config: screen(position, outsideScene),
      hasData,
      events: [],
      seenEventIds: new Set(),
      isImplemented: isSceneImplemented,
    }).scene;

  it("EVERY panel without a board of its own runs the menu board", () => {
    // Four priced panels instead of three, which is the whole point: a whole TV used
    // to sit idle while six subjects took turns on the three beside it (owner
    // 2026-09-01).
    for (const position of [1, 2, 3, 4]) {
      for (const slot of [0, 1, 2, 3, 4, 5, 6]) {
        expect(sceneAt(position, slot), `panel ${position} slot ${slot}`).toBe("open-now");
      }
    }
  });

  it("THE PRICED WALL REACHES THE LAST PANEL — TV5 is no longer idle", () => {
    // TV5's own board is the events greeting, which has nothing to show most nights.
    // Before this it fell to an idle signpost; now it prices.
    expect(sceneAt(4, 3, "event-welcome", (sc) => sc !== "event-welcome")).toBe("open-now");
  });

  it("but a panel WITH something of its own to say keeps it", () => {
    // The check-in list always has something (it owns a designed empty state), so TV1
    // never joins the pricing board. The events wing joins it only when a party is on.
    expect(sceneAt(0, 3, "bowling-checkin")).toBe("bowling-checkin");
    expect(sceneAt(4, 3, "event-welcome")).toBe("event-welcome");
  });

  it("a yielding panel takes its OWN board, never its idle understudy", () => {
    // The understudy exists so a wing outside the running scene has something designed
    // to show instead of a black panel. Here the alternative is real prices, and prices
    // beat a signpost saying nothing is on — so `event-checkin` must NOT win here.
    expect(sceneAt(4, 3, "event-welcome", (sc) => sc !== "event-welcome")).not.toBe(
      "event-checkin",
    );
  });

  it("a panel with NO board of its own simply joins the menu board", () => {
    // It used to fall to house ads, because the board was a THREE-panel composition
    // and a lone wing rendering it would paint panel 0 of that set and duplicate its
    // neighbour. The subject is pinned to the physical position now, so every panel
    // renders its own slice safely and there is nothing to fall back from.
    expect(sceneAt(0, 3)).toBe("open-now");
    expect(sceneAt(4, 3)).toBe("open-now");
  });

  it("an UNBUILT wing scene is ignored, and the panel prices instead of going to ads", () => {
    // `billboard-crown` IS a SceneType and is deliberately NOT in IMPLEMENTED, which
    // makes it the honest test of "declared but unbuilt" — the exact state that painted
    // house ads over HPFM:1 for a third of every cycle in August 2026. An unbuilt name
    // must never paint as something else; here it simply does not win the panel.
    expect(sceneAt(0, 3, "billboard-crown")).toBe("open-now");
    expect(sceneAt(0, 3, "not-a-scene")).toBe("open-now");
  });

  it("THE SHOWCASE NEVER YIELDS — all five run it, including both wings", () => {
    // This is the difference between the two `wall` entries, and the one that would
    // break the owner's artwork if it were ever lost: the showcase is ONE PICTURE and
    // a panel dropping out takes a piece of the sentence with it. Both wings are given
    // boards that DO have data, so only YIELDS_TO_WINGS keeps them here.
    for (const position of [0, 1, 2, 3, 4]) {
      for (const slot of [7, 8]) {
        expect(sceneAt(position, slot, "bowling-checkin"), `panel ${position}`).toBe(
          "vip-showcase",
        );
        expect(sceneAt(position, slot, "event-welcome"), `panel ${position}`).toBe("vip-showcase");
      }
    }
  });

  describe("the 20-second beat — the artwork is a punctuation mark", () => {
    // Owner 2026-09-01: the artwork "should only be 20 seconds about every 2 minutes".
    // 20s is HALF the estate's slot, so this only works if `slotMs` genuinely reaches
    // the rotation — these are what fail if the threading is ever unpicked.
    const panel = (position: number) =>
      resolveScreenConfig(
        {
          ...(rolePreset("front-desk").config as object),
          wall: { ...FD, position },
        } as never,
        "HPFM",
      );

    const sceneAtMs = (nowMs: number, position = 2) =>
      resolveActiveScene({
        nowMs,
        config: panel(position),
        hasData: () => true,
        events: [],
        seenEventIds: new Set(),
        isImplemented: isSceneImplemented,
      }).scene;

    it("prices for 100 seconds, then the artwork for 20", () => {
      // The cycle is 6 x 20s starting at epoch 0: slots 0-4 pricing, slot 5 artwork.
      for (const s of [0, 1, 2, 3, 4]) {
        expect(sceneAtMs(s * 20_000 + 5_000), `slot ${s}`).toBe("open-now");
      }
      expect(sceneAtMs(5 * 20_000 + 5_000)).toBe("vip-showcase");
      // …and it wraps back to pricing on the next cycle.
      expect(sceneAtMs(6 * 20_000 + 5_000)).toBe("open-now");
    });

    it("the artwork lands on ALL FIVE panels in the same 20 seconds", () => {
      // A panel reading a different slot LENGTH would drift out of the artwork while
      // its neighbours were still in it, which tears the one composition that cannot
      // survive losing a panel.
      for (const p of [0, 1, 2, 3, 4]) {
        expect(sceneAtMs(5 * 20_000 + 5_000, p), `panel ${p}`).toBe("vip-showcase");
      }
    });

    it("the segment reports a 20-second duration, not 40", () => {
      // durationMs is what the director uses to schedule the next decision; leaving it
      // on the estate's 40s would hold the artwork for twice as long as the slot.
      const d = resolveActiveScene({
        nowMs: 5 * 20_000 + 5_000,
        config: panel(2),
        hasData: () => true,
        events: [],
        seenEventIds: new Set(),
        isImplemented: isSceneImplemented,
      });
      expect(d.durationMs).toBe(20_000);
    });
  });

  it("a screen OFF a wall ignores spans — every existing board is untouched", () => {
    const lone = resolveScreenConfig(
      { playlist: [{ scene: "open-now", slots: 7, span: "middle" }] } as never,
      "HPFM",
    );
    expect(
      resolveActiveScene({
        nowMs: 3 * SLOT_MS,
        config: lone,
        hasData: () => true,
        events: [],
        seenEventIds: new Set(),
        isImplemented: isSceneImplemented,
      }).scene,
    ).toBe("open-now");
  });

  describe("a NARROWER span still parks its wings on their own boards", () => {
    // The front-desk wall no longer runs a middle-span scene, but the mechanism is
    // general and a future wall will. These keep the understudy and the ads floor
    // covered rather than letting them rot untested.
    const middle = (position: number, outsideScene?: string) =>
      resolveScreenConfig(
        {
          playlist: [{ scene: "open-now", slots: 7, span: "middle" }],
          wall: { ...FD, position, ...(outsideScene ? { outsideScene } : {}) },
        } as never,
        "HPFM",
      );

    const at = (
      position: number,
      outsideScene?: string,
      hasData: (s: SceneType) => boolean = () => true,
    ) =>
      resolveActiveScene({
        nowMs: 3 * SLOT_MS + 5_000,
        config: middle(position, outsideScene),
        hasData,
        events: [],
        seenEventIds: new Set(),
        isImplemented: isSceneImplemented,
      }).scene;

    it("the middle three run the scene and the wings do not", () => {
      for (const position of [1, 2, 3]) expect(at(position)).toBe("open-now");
      expect(at(0, "bowling-checkin")).toBe("bowling-checkin");
    });

    it("a wing with NOTHING ON shows its understudy, not ads", () => {
      // SceneEventWelcome draws nothing with no events and no VIPs, and a wing outside
      // the span is substituted directly rather than gated out of the rotation — so
      // without an answer here that panel went black on a quiet night (owner 2026-08-20).
      expect(at(4, "event-welcome", (sc) => sc !== "event-welcome")).toBe("event-checkin");
    });

    it("a wing whose board has NO DATA and NO understudy falls to ads", () => {
      // The floor is still house ads. `bowling-checkin` owns its own empty state so it
      // never actually reaches here, which is exactly why it is the honest probe for
      // "no understudy declared" — WING_IDLE lists only `event-welcome`.
      expect(at(0, "bowling-checkin", (sc) => sc !== "bowling-checkin")).toBe("ads");
    });

    it("an unbuilt wing scene falls to ads", () => {
      expect(at(0, "billboard-crown")).toBe("ads");
    });
  });
});

describe("the VIP greeting rules are the kiosk welcome TV's", () => {
  /** A role's resolved config, as a screen hung with that preset would run it. */
  const resolved = (role: "kiosk-bank" | "front-desk") =>
    resolveScreenConfig(rolePreset(role).config as never, "HPFM");

  it("front-desk greets a VIP party by exactly the same rules as kiosk-bank", () => {
    // "VIP should be same as the kiosk welcome tv at headpinz" (owner 2026-08-20).
    // `config.vip` is what `vipCandidatesAt` consults, so these four numbers decide
    // whether a party inside its window gets a gold page on the wall's events wing —
    // and TWO SCREENS GREETING THE SAME PARTY BY DIFFERENT RULES is invisible until a
    // party is standing in front of one of them.
    expect(resolved("front-desk").vip).toEqual(resolved("kiosk-bank").vip);
  });

  it("and it is genuinely on, not merely equal to an off pair", () => {
    // Guards the lazy way to make the assertion above pass.
    expect(resolved("front-desk").vip.enabled).toBe(true);
    expect(resolved("front-desk").vip.leadMins).toBeGreaterThan(
      resolved("front-desk").vip.floorMins,
    );
  });

  it("shows a party for the same stretch of the evening as kiosk-bank", () => {
    // The other half of "same as the kiosk welcome tv": these two numbers decide how
    // long a party is on the glass either side of its first leg, and therefore how
    // much of the night the wing spends on the check-in signpost instead. They agree
    // today only because front-desk omits them and the resolve defaults happen to be
    // kiosk-bank's explicit 75/30 — an accident worth pinning, not relying on.
    const fd = resolved("front-desk");
    const kb = resolved("kiosk-bank");
    expect([fd.welcomeLeadMins, fd.welcomeTrailMins]).toEqual([
      kb.welcomeLeadMins,
      kb.welcomeTrailMins,
    ]);
  });
});

describe("does this screen show this scene at all — the feed's question", () => {
  /** A front-desk panel: the shared playlist, plus whichever wing board this one runs. */
  const panel = (position: number, outsideScene?: string) =>
    resolveScreenConfig(
      {
        playlist: [
          { scene: "open-now", slots: 7, span: "middle" },
          { scene: "vip-showcase", slots: 2, span: "wall" },
        ],
        wall: { ...FRONT_DESK, position, ...(outsideScene ? { outsideScene } : {}) },
      } as never,
      "HPFM",
    );

  it("counts a WING'S OWN BOARD, which appears in no playlist anywhere", () => {
    // The bug this closes: the feed builder asked the playlist alone, and the five
    // panels share one byte-identical playlist that names no wing scene — so TV5's
    // events board was never sent any parties and fell to house ads every night.
    expect(screenShowsScene(panel(4, "event-welcome"), "event-welcome")).toBe(true);
    expect(screenShowsScene(panel(0, "bowling-checkin"), "bowling-checkin")).toBe(true);
  });

  it("counts a rotation entry, for every screen that is not on a wall", () => {
    const hpfm1 = resolveScreenConfig(
      { playlist: [{ scene: "event-welcome", slots: 2, requiresData: true }] } as never,
      "HPFM",
    );
    expect(screenShowsScene(hpfm1, "event-welcome")).toBe(true);
    expect(screenShowsScene(hpfm1, "bowling-checkin")).toBe(false);
  });

  it("says no to a scene this screen does not run either way", () => {
    // A middle panel has no wing board, so it must not be sent the wings' sections —
    // that is the whole point of asking.
    expect(screenShowsScene(panel(2), "event-welcome")).toBe(false);
    expect(screenShowsScene(panel(4, "event-welcome"), "bowling-checkin")).toBe(false);
  });
});
