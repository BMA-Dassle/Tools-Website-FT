import { describe, it, expect } from "vitest";
import {
  dollars,
  menuPanels,
  menuPanelAt,
  panelFilmAt,
  splitPrice,
  wallVideoAt,
  WALL_VIDEO_TURN_MS,
  vipBookingUrl,
  vipSlideArtAt,
  vipWallPrice,
  venueDateString,
  venueDayTier,
  wallGoldSlide,
  VIP_ART_CLAIMS,
} from "./wall-content";
import { SLOT_MS } from "./director/schedule";
import { activeVipCombo } from "~/features/combos/combo-specials";
import { allProductIds } from "~/features/maintenance";
import { TOKEN_PACKAGES } from "~/features/game-cards";
import { rolePreset } from "./defaults";

/**
 * What the front-desk wall SAYS, held against the modules that decide it.
 *
 * The two failures worth a test here are both quiet ones. A price that drifts
 * from what the kiosk charges is a guest arguing at the desk with a photograph of
 * the wall. And since 2026-09-01 there is a sharper version of the same problem:
 * the VIP showcase is exported ARTWORK, so its prices are pixels that no amount of
 * catalog change can move. `VIP_ART_CLAIMS` is what stands in for reading them, and
 * the pin below is the only thing between a repricing and a wall that goes on
 * promising last season's number to a lobby full of people.
 */

const COMBO = activeVipCombo();

describe("the day tier is the COMBOS feature's rule, not a new one", () => {
  // Fixed instants, so this never depends on the day the suite runs.
  const at = (iso: string) => Date.parse(iso);

  it("Saturday bills the weekend tier", () => {
    expect(venueDayTier(at("2026-08-15T18:00:00-04:00"))).toBe("weekend");
  });

  it("Sunday bills the weekend tier", () => {
    expect(venueDayTier(at("2026-08-16T18:00:00-04:00"))).toBe("weekend");
  });

  it("MEGA TUESDAY bills the WEEKDAY tier — the trap this helper exists for", () => {
    // scheduleForDate returns "mega" for a Tuesday, which is NOT "weekend", and
    // combos bill the weekday tier on it. Re-deriving the tier from the day of the
    // week is exactly how that gets quoted wrong on a wall.
    expect(venueDayTier(at("2026-08-18T18:00:00-04:00"))).toBe("weekday");
  });

  it("Monday, Wednesday and Thursday bill the weekday tier", () => {
    expect(venueDayTier(at("2026-08-17T18:00:00-04:00"))).toBe("weekday");
    expect(venueDayTier(at("2026-08-19T18:00:00-04:00"))).toBe("weekday");
    expect(venueDayTier(at("2026-08-20T18:00:00-04:00"))).toBe("weekday");
  });

  it("prices by the VENUE's day, not the renderer's", () => {
    // 8pm Sunday in Fort Myers is already Monday in UTC. A UTC-clocked renderer
    // reading its own local day would quote the weekday tier to a guest standing
    // in front of the wall on a Sunday night.
    const sundayNightEt = at("2026-08-16T20:00:00-04:00");
    expect(venueDateString(sundayNightEt)).toBe("2026-08-16");
    expect(new Date(sundayNightEt).toISOString().slice(0, 10)).toBe("2026-08-17");
    expect(venueDayTier(sundayNightEt)).toBe("weekend");
  });
});

describe("the price is the price the kiosk will charge", () => {
  it("both tiers come from the live pack, in cents, never re-typed", () => {
    if (!COMBO) return; // no pack on sale — covered by the art pin below
    const weekday = vipWallPrice(Date.parse("2026-08-17T18:00:00-04:00"))!;
    const weekend = vipWallPrice(Date.parse("2026-08-15T18:00:00-04:00"))!;
    expect(weekday.todayLabel).toBe(dollars(COMBO.price.weekday));
    expect(weekday.otherLabel).toBe(dollars(COMBO.price.weekend));
    expect(weekend.todayLabel).toBe(dollars(COMBO.price.weekend));
    expect(weekend.otherLabel).toBe(dollars(COMBO.price.weekday));
  });

  it("BOTH tiers stay available to the wall, so it is true on any day", () => {
    // A guest reading it on a Thursday and coming back on a Saturday must not feel
    // bait-and-switched.
    const p = vipWallPrice(Date.parse("2026-08-17T18:00:00-04:00"))!;
    expect(p.todayLabel).not.toBe(p.otherLabel);
  });

  it('a one-line quote is "from" the LOWER tier — the only claim true on every day', () => {
    if (!COMBO) return;
    const lower = Math.min(COMBO.price.weekday, COMBO.price.weekend);
    for (const iso of ["2026-08-15T18:00:00-04:00", "2026-08-17T18:00:00-04:00"]) {
      expect(vipWallPrice(Date.parse(iso))!.fromLabel).toBe(`From ${dollars(lower)}`);
    }
  });

  it("the minimum party size is the pack's own, not a remembered 2", () => {
    if (!COMBO) return;
    expect(vipWallPrice(Date.now())!.minGuests).toBe(COMBO.minHeadcount ?? 2);
  });

  it("renders whole dollars without a dead .00 — two characters of nothing at 170px", () => {
    expect(dollars(7900)).toBe("$79");
    expect(dollars(9900)).toBe("$99");
    expect(dollars(2099)).toBe("$20.99");
  });

  it("splits the cents off a price so the DOLLARS carry the size", () => {
    // "$67.50" set whole at 170px makes the "$45" three feet along the wall look
    // dearer than it is.
    expect(splitPrice("$67.50")).toEqual({ main: "$67", cents: "50" });
    expect(splitPrice("$20.99")).toEqual({ main: "$20", cents: "99" });
    expect(splitPrice("$45")).toEqual({ main: "$45", cents: null });
    // Anything that is not a price comes back whole, so a caller can render either
    // without asking what it was handed.
    expect(splitPrice("Open now")).toEqual({ main: "Open now", cents: null });
  });
});

describe("THE ART PIN — the showcase's promises are pixels now", () => {
  /**
   * The showcase used to be drawn from the live pack, so a repricing moved the wall
   * by itself. It is exported artwork now: better-looking, and unable to correct
   * itself. These tests cannot make the wall right — their whole job is to refuse to
   * let it go quietly wrong, by failing the build the moment the pack stops matching
   * what the pixels say. The fix when one fails is to re-export the slide and re-run
   * `scripts/upload-tv-wall-vip-slides.mjs`, never to edit the claim until it passes.
   */
  it("a pack MUST be on sale — five panels of artwork are advertising one", () => {
    // Every other VIP surface degrades to silence with no pack. This one cannot: the
    // prices are in the image. Disabling the pack has to break the build so that
    // taking the artwork down is part of the same change.
    expect(COMBO, "the VIP wall artwork is live but no VIP pack is on sale").not.toBeNull();
  });

  it("panel 4's burned-in prices are the pack's prices", () => {
    if (!COMBO) return;
    expect(VIP_ART_CLAIMS.priceWeekdayCents, "the artwork's Mon–Thu price").toBe(
      COMBO.price.weekday,
    );
    expect(VIP_ART_CLAIMS.priceWeekendCents, "the artwork's Fri–Sun price").toBe(
      COMBO.price.weekend,
    );
  });

  it("panel 1's burned-in name is the pack's name", () => {
    if (!COMBO) return;
    expect(VIP_ART_CLAIMS.name).toBe(COMBO.name);
  });

  it("panel 2's burned-in duration matches the pack's own label", () => {
    if (!COMBO) return;
    expect(COMBO.durationLabel ?? "").toContain(VIP_ART_CLAIMS.durationContains);
  });

  it("panel 3 promises only things the pack still includes", () => {
    if (!COMBO) return;
    for (const claim of VIP_ART_CLAIMS.includes) {
      expect(COMBO.includes, `the artwork promises "${claim}"`).toContain(claim);
    }
  });

  it('panel 3 says "TWO RACES", so the pack must still carry exactly two', () => {
    if (!COMBO) return;
    const races = COMBO.components.filter((c) => c.kind === "race");
    expect(races).toHaveLength(VIP_ART_CLAIMS.raceLegs);
  });
});

describe("the VIP showcase is ONE picture across five panels", () => {
  it("every panel of a five-wide wall carries its own artwork", () => {
    for (const p of [0, 1, 2, 3, 4]) {
      expect(vipSlideArtAt(p), `panel ${p}`).not.toBeNull();
    }
  });

  it("no two panels share artwork or a photograph", () => {
    // A repeated panel would read as a stutter in a sentence that runs across the
    // wall, and a shared backdrop would put the same picture behind two different
    // claims.
    const slides = [0, 1, 2, 3, 4].map((p) => vipSlideArtAt(p)!);
    expect(new Set(slides.map((s) => s.art)).size).toBe(5);
    expect(new Set(slides.map((s) => s.photo)).size).toBe(5);
  });

  it("every panel names what it says, for a screen reader — the art has no text nodes", () => {
    for (const p of [0, 1, 2, 3, 4]) {
      expect(vipSlideArtAt(p)!.alt.length, `panel ${p}`).toBeGreaterThan(10);
    }
  });

  it("the QR is on the LAST panel and nowhere else", () => {
    const withQr = [0, 1, 2, 3, 4].filter((p) => vipSlideArtAt(p)!.qr);
    expect(withQr).toEqual([4]);
  });

  it("never uses the backdrop with words burned into it", () => {
    // TV_PHOTOS.vipLanes is a video still carrying "NO MATTER WHO YOU ARE" in the
    // frame, and burned-in words under burned-in artwork is two headlines fighting.
    for (const p of [0, 1, 2, 3, 4]) {
      expect(vipSlideArtAt(p)!.photo).not.toContain("hyperbowling");
    }
  });

  it("a sixth panel gets NOTHING rather than a repeated slide", () => {
    expect(vipSlideArtAt(5)).toBeNull();
  });

  it("the QR points at the ACTIVE pack, so a swap moves the link", () => {
    if (!COMBO) return;
    const url = vipBookingUrl()!;
    expect(url).toContain(COMBO.id);
    // Absolute and on the public host: a phone camera has no notion of the origin
    // the TV happens to be running on.
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("the menu board — one subject per panel, and the subject never moves", () => {
  // Two different slots. Nothing may differ between them: the rotation is gone.
  const early = 1000 * SLOT_MS + 5_000;
  const later = 1001 * SLOT_MS + 5_000;

  // Tonight's PACKAGE plus the plain hourly lane rate — a real Tuesday, where Fun 4
  // All is the special and the Mon–Thu hourly rate is the baseline underneath it.
  const BOWLING = {
    special: {
      regular: {
        label: "Fun 4 All",
        priceLabel: "$15.99",
        unit: "per person",
        durationLabel: "1.5 hours",
        shoesIncluded: true,
      },
      vip: {
        label: "Fun 4 All VIP",
        priceLabel: "$17.99",
        unit: "per person",
        durationLabel: "1.5 hours",
        shoesIncluded: true,
      },
    },
    hourly: {
      regular: {
        label: "Regular",
        priceLabel: "$45",
        unit: "per lane",
        durationLabel: null,
        shoesIncluded: false,
      },
      vip: {
        label: "VIP",
        priceLabel: "$67.50",
        unit: "per lane",
        durationLabel: null,
        shoesIncluded: false,
      },
    },
  };

  it("is FIVE panels — one per physical position on the wall", () => {
    expect(menuPanels(early, BOWLING)).toHaveLength(5);
    for (const p of [0, 1, 2, 3, 4]) expect(menuPanelAt(early, p, BOWLING)).not.toBeNull();
  });

  it("NOTHING ROTATES — the same position shows the same subject at any hour", () => {
    // The board used to deal six subjects across three panels in two sets, cut on the
    // slot boundary; a guest at the desk for ninety seconds saw half the menu and the
    // panel they looked at had changed by the time they looked back (owner 2026-09-01).
    for (const p of [0, 1, 2, 3, 4]) {
      expect(menuPanelAt(early, p, BOWLING)!.headline).toBe(
        menuPanelAt(later, p, BOWLING)!.headline,
      );
    }
  });

  it("THE SUBJECT IS PINNED TO THE POSITION — which is what makes a panel safe to drop", () => {
    // TV1 keeps the check-in list and TV5 steps aside for a party greeting, so the
    // board is regularly rendered by only some of its panels. Indexing by physical
    // position means a panel leaving changes nothing for its neighbours; dealing a
    // list across the participants instead is the wall-tearing bug (YIELDS_TO_WINGS
    // in schedule.ts).
    const headlines = menuPanels(early, BOWLING).map((p) => p.headline);
    expect(headlines).toEqual([
      COMBO?.name ?? "VIP Experience",
      "Bowling",
      "Gel Blasters",
      "Game Zone",
      "At FastTrax",
    ]);
  });

  it("the four PRICED panels are the four a guest can buy at this bank", () => {
    // Position 0 is the understudy for TV1's check-in list and is not one of them.
    const priced = menuPanels(early, BOWLING).slice(1);
    expect(priced.map((p) => p.headline)).toEqual([
      "Bowling",
      "Gel Blasters",
      "Game Zone",
      "At FastTrax",
    ]);
  });

  it("no two panels share a subject or a picture", () => {
    const panels = menuPanels(early, BOWLING);
    expect(new Set(panels.map((p) => p.headline)).size).toBe(5);
    expect(new Set(panels.map((p) => p.photo)).size).toBe(5);
  });

  it("AT MOST TWO ROWS — a third would shrink the price back to unreadable", () => {
    for (const panel of menuPanels(early, BOWLING)) {
      expect(panel.rows.length, panel.headline).toBeGreaterThan(0);
      expect(panel.rows.length, panel.headline).toBeLessThanOrEqual(2);
    }
  });

  it("EVERY panel carries the kiosk instruction — it is chrome now, not a scene", () => {
    // The separate how-to slot was deleted; carrying the instruction on the pricing
    // panel says both at once and costs no airtime (owner 2026-08-19).
    for (const panel of menuPanels(early, BOWLING)) {
      expect(panel.band, panel.headline).toContain("kiosk below");
      // "THE kiosk below", never "any" — the ad rotation sells the bank; this board
      // names the one machine under this panel.
      expect(panel.band.toLowerCase()).not.toContain("any kiosk");
    }
  });

  it("the band's verb agrees with the panel — you don't buy a game card", () => {
    const panels = menuPanels(early, BOWLING);
    expect(panels[1].band).toBe("Buy it on the kiosk below");
    expect(panels[3].band).toBe("Load it on the kiosk below");
    expect(panels[4].band).toBe("Book it on the kiosk below");
  });

  it("every headline lands WHOLE on its panel — no word crosses a gap", () => {
    for (const p of menuPanels(early, BOWLING)) {
      expect(p.headline.includes("\n")).toBe(false);
      expect(p.headline.trim().endsWith("-")).toBe(false);
    }
  });

  it("a sixth panel gets NOTHING rather than a repeat", () => {
    expect(menuPanelAt(early, 5, BOWLING)).toBeNull();
  });

  it("Kids Bowl Free and Birthdays are OFF the board", () => {
    const ids = menuPanels(early, BOWLING).flatMap((p) => p.rows.map((r) => r.productId));
    expect(ids).not.toContain("kbf");
    expect(ids).not.toContain("birthday-party");
  });

  it("EVERY ROW KEYS ON A REAL PRODUCT ID, or its pause gate silently never fires", () => {
    const known = new Set(allProductIds());
    for (const panel of menuPanels(early, BOWLING)) {
      for (const row of panel.rows) {
        if (!row.productId) continue;
        expect(known, `"${panel.headline} / ${row.name}" keys on "${row.productId}"`).toContain(
          row.productId,
        );
      }
    }
  });

  it("every row has either a price or a word, and none quotes $0", () => {
    for (const panel of menuPanels(early, BOWLING)) {
      for (const row of panel.rows) {
        expect(Boolean(row.price || row.word), `${panel.headline} / ${row.name}`).toBe(true);
        expect(row.price).not.toBe("$0");
      }
    }
  });
});

describe("the bowling panel — the one attraction with no static price", () => {
  const now = 1000 * SLOT_MS + 5_000;
  /** Bowling sits on wall position 1 (TV2). */
  const BOWLING_AT = 1;

  const FULL = {
    special: {
      regular: {
        label: "Fun 4 All",
        priceLabel: "$15.99",
        unit: "per person",
        durationLabel: "1.5 hours",
        shoesIncluded: true,
      },
      vip: {
        label: "Fun 4 All VIP",
        priceLabel: "$17.99",
        unit: "per person",
        durationLabel: "1.5 hours",
        shoesIncluded: true,
      },
    },
    hourly: {
      regular: {
        label: "Regular",
        priceLabel: "$45",
        unit: "per lane",
        durationLabel: null,
        shoesIncluded: false,
      },
      vip: null,
    },
  };

  it("LEADS WITH TONIGHT'S SPECIAL, then the VIP tier of it", () => {
    // The first cut sorted by `sort_order`, which puts the hourly rate (20-23) ahead of
    // the packages (30+) — so a Tuesday showed "Regular $45 per lane" and Fun 4 All
    // never appeared at all (owner 2026-08-18). With one panel instead of two turns in
    // a rotation, the two rows are the two a guest actually chooses between.
    const panel = menuPanelAt(now, BOWLING_AT, FULL)!;
    expect(panel.eyebrow).toBe("Tonight at HeadPinz");
    expect(panel.rows).toHaveLength(2);
    expect(panel.rows[0]).toMatchObject({ name: "Fun 4 All", price: "$15.99" });
    expect(panel.rows[1]).toMatchObject({ name: "Fun 4 All VIP", price: "$17.99" });
  });

  it("falls back to the lane rate UNDER the special when there is no VIP tier", () => {
    const panel = menuPanelAt(now, BOWLING_AT, {
      special: { regular: FULL.special.regular, vip: null },
      hourly: FULL.hourly,
    })!;
    expect(panel.rows).toHaveLength(2);
    expect(panel.rows[1].name.toLowerCase()).toContain("by the hour");
    expect(panel.rows[1].price).toBe("$45");
    expect(panel.rows[1].note).toContain("per lane");
  });

  it("says SHOES INCLUDED only where the offer actually includes them", () => {
    // Fun 4 All includes shoes; an hourly lane does not, and neither does Midnight
    // Madness. Blanket-printing it would be a $5-a-head surprise at the desk.
    const panel = menuPanelAt(now, BOWLING_AT, {
      special: { regular: FULL.special.regular, vip: null },
      hourly: FULL.hourly,
    })!;
    expect(panel.rows[0].note).toContain("shoes included");
    expect(panel.rows[1].note).not.toContain("shoes");
  });

  it("says WHICH UNIT every price is in — per lane is not per person", () => {
    // An hourly lane holds six bowlers. A bare "$45" is wrong by a factor of six
    // depending on which it is, which is why the unit rides with the price.
    const panel = menuPanelAt(now, BOWLING_AT, {
      special: { regular: FULL.special.regular, vip: null },
      hourly: FULL.hourly,
    })!;
    expect(panel.rows[0].note).toContain("per person");
    expect(panel.rows[1].note).toContain("per lane");
  });

  it("with NO catalog answer it sells availability — never an invented lane price", () => {
    // The house pricing rule: a displayed price must be the price the kiosk will
    // charge. Bowling is QAMF-dynamic and the static catalogue carries `price: 0`.
    const panel = menuPanelAt(now, BOWLING_AT, null)!;
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBeUndefined();
    expect(panel.rows[0].word).toBeTruthy();
    expect(panel.rows[0].tracksAvailability).toBe(true);
  });

  it("falls back to the LANE RATE on a night with no package", () => {
    const panel = menuPanelAt(now, BOWLING_AT, { special: null, hourly: FULL.hourly })!;
    expect(panel.eyebrow).toBe("At HeadPinz");
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBe("$45");
  });

  it("a catalog row with no priced item shows no price rather than a zero", () => {
    const panel = menuPanelAt(now, BOWLING_AT, {
      special: {
        regular: {
          label: "Fun 4 All",
          priceLabel: null,
          unit: "per person",
          durationLabel: null,
          shoesIncluded: true,
        },
        vip: null,
      },
      hourly: null,
    })!;
    expect(panel.rows[0].price).toBeUndefined();
    expect(panel.rows[0].word).toBe("Ask at the desk");
  });

  it("still pauses with bowling — the lane system going dark takes the panel quiet", () => {
    const panel = menuPanelAt(now, BOWLING_AT, FULL)!;
    for (const row of panel.rows) expect(row.productId).toBe("bowling");
  });
});

describe("the other subject panels", () => {
  const now = 1000 * SLOT_MS + 5_000;

  it("gel blasters and laser tag SHARE a panel, both priced, both tracked", () => {
    const panel = menuPanelAt(now, 2, null)!;
    expect(panel.rows.map((r) => r.productId)).toEqual(["gel-blaster", "laser-tag"]);
    for (const row of panel.rows) {
      expect(row.price, row.name).toBeTruthy();
      expect(row.tracksAvailability).toBe(true);
    }
  });

  it("Game Zone leads with the two card tiers that carry a BONUS", () => {
    // It used to say "Any amount", which is true and sells nothing — a pricing panel
    // with no number is the one a guest scans past (owner 2026-08-19). The bonus is the
    // offer, so only the tiers that have one appear.
    const panel = menuPanelAt(now, 3, null)!;
    expect(panel.rows).toHaveLength(2);
    for (const row of panel.rows) {
      expect(row.productId).toBe("game-zone");
      // Game Zone runs on Intercard, independent of every booking vendor, so it has no
      // bookable slot to track.
      expect(row.tracksAvailability).toBeUndefined();
      expect(row.note).toContain("bonus");
    }
  });

  it("THE BIG NUMBER ON THE RIGHT IS ALWAYS MONEY — tokens are the row's name", () => {
    // Game Zone used to put the token TOTAL in the price position, which made it the
    // one panel on the wall where the huge right-hand figure was not a price (owner
    // 2026-09-01, from the live glass: "pricing on right, tokens on left").
    for (const row of menuPanelAt(now, 3, null)!.rows) {
      expect(row.name).toMatch(/^[\d,]+ tokens$/);
      expect(row.price).toMatch(/^\$\d+$/);
      expect(row.word).toBeUndefined();
    }
  });

  it("EVERY priced row on the wall puts its money in the same place", () => {
    // The regression guard for the above, across all four priced panels: a row that
    // has a price must not also carry a `word`, or the two would compete for the one
    // position a guest scans down the wall.
    for (const p of [1, 2, 3, 4]) {
      for (const row of menuPanelAt(now, p, null)!.rows) {
        if (row.price) expect(row.word, `${row.name}`).toBeUndefined();
      }
    }
  });

  it("the Game Zone tiers read cheapest-first", () => {
    const rows = menuPanelAt(now, 3, null)!.rows;
    const cents = rows.map((r) => Number((r.price ?? "").replace(/[^0-9]/g, "")));
    expect(cents[0]).toBeLessThan(cents[1]);
    // …and the token total exceeds ten per dollar, which is what the bonus means.
    const totals = rows.map((r) => Number(r.name.replace(/[^0-9]/g, "")));
    expect(totals[0]).toBeGreaterThan(cents[0] * 10);
    expect(totals[1]).toBeGreaterThan(cents[1] * 10);
  });

  it("the Game Zone prices come from the table the KIOSK charges from", () => {
    const rows = menuPanelAt(now, 3, null)!.rows;
    const bonusTiers = TOKEN_PACKAGES.filter((t) => t.bonusTokens > 0);
    expect(bonusTiers.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const price = Number((row.price ?? "").replace(/[^0-9]/g, "")) * 100;
      const pkg = bonusTiers.find((t) => t.priceCents === price);
      expect(pkg, `no package priced ${row.price}`).toBeTruthy();
      expect(row.name).toBe(`${(pkg!.tokens + pkg!.bonusTokens).toLocaleString("en-US")} tokens`);
      expect(row.note).toContain(String(pkg!.bonusTokens));
    }
  });

  it("the FastTrax panel carries Racing and Duckpin — the other building", () => {
    const panel = menuPanelAt(now, 4, null)!;
    expect(panel.rows.map((r) => r.productId)).toEqual(["race", "duck-pin"]);
  });

  it("RACING does not claim a next-available it can never have", () => {
    // `firstOpen.race` is declared in ExperienceFirstOpen and nothing ever writes it
    // (owner 2026-07-25), verified against the live cache. A row claiming to track it
    // would print "Ask at the desk" over a track open all evening.
    const racing = menuPanelAt(now, 4, null)!.rows.find((r) => r.productId === "race")!;
    expect(racing.tracksAvailability).toBeUndefined();
    expect(racing.price).toBeTruthy();
  });

  it("Duckpin DOES track availability — it has a real key in the cache", () => {
    const duck = menuPanelAt(now, 4, null)!.rows.find((r) => r.productId === "duck-pin")!;
    expect(duck.tracksAvailability).toBe(true);
  });

  it("the VIP understudy is named for the product and badged All Access", () => {
    // Position 0 is what TV1 would show if its check-in list ever went quiet. It never
    // does, but a wall must degrade to something rather than to a hole.
    const panel = menuPanelAt(now, 0, null)!;
    expect(panel.headline).toBe(COMBO?.name ?? "VIP Experience");
    expect(panel.eyebrow).toBe("All Access");
  });

  it("the VIP understudy quotes tonight's real tier and names the other days", () => {
    if (!COMBO) return;
    const panel = menuPanelAt(now, 0, null)!;
    expect(panel.rows[0].name).toContain("$");
    expect(panel.rows[0].note).toContain(String(COMBO.minHeadcount ?? 2));
  });
});

describe("the video turn — one panel at a time", () => {
  const now = 1000 * SLOT_MS + 5_000;
  const panels = menuPanels(now, null);
  const T = WALL_VIDEO_TURN_MS;

  it("grants the turn to exactly ONE panel at any instant", () => {
    // Owner 2026-09-01: "no more than one TV should play a video ad at the same time".
    // Five reels at once is five decodes on three player PCs, and a wall where
    // everything moves has nothing for the eye to land on.
    for (const turn of [0, 1, 2, 3, 4, 5, 6]) {
      const t = turn * T + 1_000;
      const playing = panels.filter((p, i) => panelFilmAt(t, i, p) !== null);
      expect(playing).toHaveLength(1);
    }
  });

  it("every filmed panel gets a turn, and they come round in order", () => {
    // All four priced panels have a reel now — the Nexus arena cut gave TV3 one
    // (owner 2026-09-01).
    const holders = [0, 1, 2, 3].map((turn) => wallVideoAt(turn * T + 1_000).position);
    expect(holders).toEqual([1, 2, 3, 4]);
    // …and it wraps rather than running off the end.
    expect(wallVideoAt(4 * T + 1_000).position).toBe(1);
  });

  it("the turn is TWO MINUTES — a panel holds it for a whole cycle", () => {
    // Matching the playlist's 2:00 means a panel holds the video for its entire pricing
    // stretch rather than starting one halfway through.
    expect(WALL_VIDEO_TURN_MS).toBe(120_000);
    expect(wallVideoAt(0).position).toBe(wallVideoAt(T - 1).position);
    expect(wallVideoAt(T).position).not.toBe(wallVideoAt(0).position);
  });

  it("a panel with TWO reels alternates between them across its turns", () => {
    // Bowling is the only one with a pair; replaying the same reel every six minutes
    // would waste the second.
    const bowling = panels[1];
    expect(bowling.films?.length).toBe(2);
    // Bowling holds turns 0, 4, 8 — one in four, now that all four panels are filmed.
    const first = panelFilmAt(0 * T + 1_000, 1, bowling);
    const second = panelFilmAt(4 * T + 1_000, 1, bowling);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    // …and comes back round to the first.
    expect(panelFilmAt(8 * T + 1_000, 1, bowling)).toBe(first);
  });

  it("a panel not holding the turn plays NOTHING, even though it has reels", () => {
    // Turn 0 belongs to bowling, so Game Zone must be still.
    expect(panels[3].films?.length).toBeGreaterThan(0);
    expect(panelFilmAt(1_000, 3, panels[3])).toBeNull();
  });

  it("the bowling panel plays the RETIMED HyperBowling reel, never the 25fps master", () => {
    /**
     * WHY A FRAME RATE IS A CORRECTNESS PROPERTY HERE, and not a detail of the file:
     * the panels run at 60Hz, and 60/25 is 2.4 — a player must hold each frame for two
     * refreshes or three, alternating forever. That irregular cadence is what "bowling
     * video is still lagging" was (owner 2026-09-01), on the LIGHTEST file on the wall
     * and after the cache fix had already landed. Its 30fps panel-mate was never once
     * reported.
     *
     * Pinned by URL because that is all a unit test can see — but the rule it stands for
     * is: anything re-cut for this wall lands at 30fps. A future re-cut that quietly goes
     * back to the 25fps web master would look like a fresh, unexplained regression.
     */
    const bowling = panelFilmAt(0 * T + 1_000, 1, panels[1]);
    expect(bowling).toContain("hyperbowling-32s-30fps");
    expect(bowling).not.toMatch(/hyperbowling-32s\.mp4/);
  });

  it("the Nexus panel plays the CUT reel, never the 26s master", () => {
    // The master's tail is a franchise map and a "COMING SOON!" card for an attraction
    // that is open and priced here — see TV_WALL_FILMS.nexus.
    const nexus = panelFilmAt(1 * T + 1_000, 2, panels[2]);
    expect(nexus).toContain("nexus-hero-18s");
  });

  it("THE FILMED SET MATCHES THE PANELS THAT ACTUALLY HAVE REELS", () => {
    // The drift guard: giving a panel `films` without adding its position to the
    // rotation would leave a reel that never plays, and nothing else would say so.
    const withFilms = panels.map((p, i) => (p.films?.length ? i : null)).filter((i) => i !== null);
    const rotated = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((t) => wallVideoAt(t * T).position));
    expect([...rotated].sort()).toEqual(withFilms);
  });

  it("a negative clock still lands on a real panel", () => {
    const turn = wallVideoAt(-T * 3 - 1_000);
    expect(turn.position).toBeGreaterThanOrEqual(0);
    expect(turn.filmIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("the resting gold slide", () => {
  it("gives a five-panel wall a fifth slide, so the two ends stop matching", () => {
    if (!COMBO) return;
    // The Fort Myers kiosk catalog is four slides; panel 4's (t+4) % 4 is panel 0's
    // t % 4. This is the fifth.
    expect(wallGoldSlide(Date.now())).not.toBeNull();
  });

  it("quotes the live from-price and pauses with the combo", () => {
    if (!COMBO) return;
    const slide = wallGoldSlide(Date.parse("2026-08-17T18:00:00-04:00"))!;
    expect(slide.line).toContain(dollars(Math.min(COMBO.price.weekday, COMBO.price.weekend)));
    // The combo needs BOTH the booking rail and the lane system; half an itinerary
    // is not a product we sell.
    expect(slide.productKeys).toEqual(["race-bowl"]);
  });

  it("never uses the backdrop with words burned into it", () => {
    if (!COMBO) return;
    expect(wallGoldSlide(Date.now())!.photo).not.toContain("hyperbowling");
  });
});

describe("the front-desk role preset", () => {
  const preset = rolePreset("front-desk");

  it("exists — a typo'd role name would silently fall back to ads-only", () => {
    expect(preset.role).toBe("front-desk");
  });

  it("runs on TWENTY-second slots, not the estate's forty", () => {
    // 20s is HALF a standard slot, so "the artwork for 20 seconds" (owner 2026-09-01)
    // is not expressible in the estate's unit at all — this wall carries its own.
    expect(preset.config.slotMs).toBe(20_000);
    // Still divides the kiosk billboard's cycle evenly, so a screen over a bank still
    // lands on the bank's boundaries every other slot.
    expect(SLOT_MS % preset.config.slotMs!).toBe(0);
  });

  it("is 6 slots — TWO MINUTES exactly, with the artwork as the last 20 seconds", () => {
    const slots = (preset.config.playlist ?? []).reduce((n, e) => n + (e.slots ?? 1), 0);
    const slotMs = preset.config.slotMs!;
    expect(slots).toBe(6);
    expect((slots * slotMs) / 1000).toBe(120);
    const vip = (preset.config.playlist ?? []).find((e) => e.scene === "vip-showcase");
    expect(vip?.slots).toBe(1);
    expect(((vip!.slots ?? 1) * slotMs) / 1000).toBe(20);
    // A punctuation mark, not a segment: a third of the airtime it had before.
    expect(Math.round(((vip!.slots ?? 1) / slots) * 100)).toBe(17);
  });

  it("BOTH entries span the whole wall — and they mean different things by it", () => {
    // The showcase is one picture that needs all five panels. The menu board is five
    // independent panels, so it is in YIELDS_TO_WINGS and the two ends keep their own
    // boards when those have something to say. It used to run across the MIDDLE three,
    // which is what left a whole TV idle (owner 2026-09-01).
    const byScene = Object.fromEntries(
      (preset.config.playlist ?? []).map((e) => [e.scene, e.span]),
    );
    expect(byScene["vip-showcase"]).toBe("wall");
    expect(byScene["open-now"]).toBe("wall");
  });

  it("has no separate kiosk how-to slot — the instruction is chrome now", () => {
    const scenes = (preset.config.playlist ?? []).map((e) => String(e.scene));
    expect(scenes).not.toContain("kiosk-howto");
  });

  it("carries NO house-ads slot — this wall prices what is on sale", () => {
    // Ads are a FALLBACK now (a quiet wing, an unbuilt scene), never a scheduled turn:
    // a generic advert beside a real price is the weaker of the two.
    expect((preset.config.playlist ?? []).map((e) => e.scene)).not.toContain("ads");
  });

  it("THE SECOND COPY: the admin form writes exactly the preset's playlist", () => {
    // This is the drift that actually happened. The preset moved to nine slots with
    // spans while the admin form still wrote four scenes including a since-deleted
    // `kiosk-howto` — so saving ANY front-desk screen from the form would have written a
    // playlist with no spans, rendering the three-panel menu board across all five and
    // leaving TV 4 and TV 5 blank.
    //
    // The fix is that the form now READS the preset instead of restating it, so the
    // second copy no longer exists and cannot drift. This test does not prove that —
    // it pins the preset's own shape, so changing the wall's rhythm has to be
    // deliberate rather than incidental.
    const fromPreset = (preset.config.playlist ?? []).map(
      (e) => `${e.scene}:${e.slots ?? 1}:${e.span ?? "wall"}:${e.requiresData === true}`,
    );
    expect(fromPreset).toEqual(["open-now:5:wall:false", "vip-showcase:1:wall:false"]);
  });

  it("THE TEAR INVARIANT: nothing on this playlist is data-gated", () => {
    // A gated entry is dropped when empty, which changes totalSlots on ONE panel —
    // and five players poll on independent 15s phases, so they can briefly disagree
    // about emptiness. That is a torn wall for up to fifteen seconds.
    for (const entry of preset.config.playlist ?? []) {
      expect(entry.requiresData, `${entry.scene} is data-gated`).not.toBe(true);
    }
  });

  it("asks for the availability times the menu board needs", () => {
    expect(preset.config.showNextAvailable).toBe(true);
  });

  it("keeps the crown flag ON — it is the 'over a kiosk bank' signal", () => {
    // The crown SCENE is not implemented and never renders; the flag's other job is
    // telling SceneAdRotation to run the kiosks' own catalog. Both are wanted here.
    expect(preset.config.interrupts?.["billboard-crown"]?.enabled).toBe(true);
  });

  it("celebrates, because the guest is at the bank directly below", () => {
    expect(preset.config.interrupts?.celebration?.enabled).toBe(true);
  });

  it("is offered at HeadPinz Fort Myers only", () => {
    expect(preset.venues).toEqual(["HPFM"]);
  });
});
