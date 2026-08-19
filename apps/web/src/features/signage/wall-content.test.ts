import { describe, it, expect } from "vitest";
import {
  dollars,
  howtoPanel,
  identityRail,
  menuPanels,
  menuPanelAt,
  vipSlideIndex,
  vipSlidePanel,
  vipWallPrice,
  venueDateString,
  venueDayTier,
  wallGoldSlide,
  VIP_SLIDE_MS,
} from "./wall-content";
import { SLOT_MS } from "./director/schedule";
import { activeVipCombo } from "~/features/combos/combo-specials";
import { allProductIds } from "~/features/maintenance";
import { rolePreset } from "./defaults";

/**
 * What the front-desk wall SAYS, held against the modules that decide it.
 *
 * The two failures worth a test here are both quiet ones. A price that drifts
 * from what the kiosk charges is a guest arguing at the desk with a photograph of
 * the wall. And a wall label that outlives the thing it describes — a retired
 * voucher, a renamed leg — is the wall confidently selling something we do not
 * sell, with nothing anywhere to say so.
 */

const COMBO = activeVipCombo();

/** Everything the live VIP pack claims, lowercased, as one haystack. */
function comboClaims(): string {
  const c = COMBO;
  if (!c) return "";
  return [
    ...c.includes,
    ...(c.perks ?? []),
    ...(c.voucherIncludes?.items ?? []),
    c.durationLabel ?? "",
    c.shortDescription ?? "",
    c.longDescription ?? "",
  ]
    .join(" | ")
    .toLowerCase();
}

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
    if (!COMBO) return; // no pack on sale — covered by its own test below
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

  it('the rail quotes "from" the LOWER tier — the only claim true on every day', () => {
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

  it("renders whole dollars without a dead .00 — two characters of nothing at 165px", () => {
    expect(dollars(7900)).toBe("$79");
    expect(dollars(9900)).toBe("$99");
    expect(dollars(2099)).toBe("$20.99");
  });
});

describe("no VIP pack on sale is a DARK state, never a placeholder price", () => {
  it("every VIP surface degrades rather than inventing a number", () => {
    // vipWallPrice is null exactly when activeVipCombo() is. Feeding that null
    // through the surfaces proves none of them prints "$0" or "$NaN".
    expect(vipSlidePanel(3, 1, null)).toBeNull();
    expect(wallGoldSlide(Date.now()) === null || COMBO !== null).toBe(true);
    // The rail still names the product and points at the kiosks — it just stops
    // quoting a price, which is the difference between a quiet wall and a lying one.
    const priceCell = identityRail(3, null)!;
    expect(priceCell.isPrice).toBeUndefined();
    expect(priceCell.text).toBe("Ask at the desk");
    expect(identityRail(0, null)!.text).toBe("All Access");
  });
});

describe("the identity rail — no slide is an orphan", () => {
  const price = vipWallPrice(Date.parse("2026-08-17T18:00:00-04:00"));

  it("every panel of a five-wide wall carries a cell", () => {
    for (const p of [0, 1, 2, 3, 4]) expect(identityRail(p, price)).not.toBeNull();
  });

  it("THE NAME lands whole on panel 0 and THE PRICE whole on panel 3", () => {
    // The two tokens that matter each sit entirely on one panel, so the wall still
    // identifies itself and its price with a player down. That is the whole reason
    // the rail is cells rather than one spanning string.
    expect(identityRail(0, price)).toMatchObject({ text: "All Access", isName: true });
    expect(identityRail(3, price)).toMatchObject({ isPrice: true, quiet: "per person" });
    expect(identityRail(3, price)!.text).toContain("$");
  });

  it("names the pack the registry names, so a rebrand carries through", () => {
    if (!COMBO) return;
    expect(identityRail(1, price)!.text).toBe(COMBO.name);
  });

  it("a sixth panel gets NO rail rather than a repeat of All Access", () => {
    // Two panels both saying "All Access" would read as two products.
    expect(identityRail(5, price)).toBeNull();
  });
});

describe("the VIP showcase", () => {
  const price = vipWallPrice(Date.parse("2026-08-17T18:00:00-04:00"));

  it("a sub-slide never straddles a slot boundary", () => {
    // 20s must divide the 40s slot evenly, or a cut lands mid-slide on a wall whose
    // entire selling point is that five panels change together.
    expect(SLOT_MS % VIP_SLIDE_MS).toBe(0);
    // …and the scene's 4 slots are exactly two full passes of four slides.
    const slots = (rolePreset("front-desk").config.playlist ?? []).find(
      (e) => e.scene === "vip-showcase",
    )?.slots;
    expect((slots! * SLOT_MS) / VIP_SLIDE_MS).toBe(8);
  });

  it("the slide index is clock-derived and cycles 0..3", () => {
    expect([0, 1, 2, 3, 4].map((i) => vipSlideIndex(i * VIP_SLIDE_MS))).toEqual([0, 1, 2, 3, 0]);
  });

  it("a negative clock (a wildly wrong RTC) still lands in range", () => {
    expect(vipSlideIndex(-VIP_SLIDE_MS * 3)).toBeGreaterThanOrEqual(0);
    expect(vipSlideIndex(-VIP_SLIDE_MS * 3)).toBeLessThan(4);
  });

  it("every slide fills all five panels — no gap in the middle of a wall", () => {
    for (const slide of [0, 1, 2, 3]) {
      for (const p of [0, 1, 2, 3, 4]) {
        expect(vipSlidePanel(slide, p, price), `slide ${slide} panel ${p}`).not.toBeNull();
      }
    }
  });

  it("LAYOUT FOLLOWS THE JOB: statement and price are posters, legs and inclusions are cards", () => {
    expect(vipSlidePanel(0, 1, price)!.layout).toBe("poster");
    expect(vipSlidePanel(1, 1, price)!.layout).toBe("card");
    expect(vipSlidePanel(2, 1, price)!.layout).toBe("card");
    expect(vipSlidePanel(3, 1, price)!.layout).toBe("poster");
  });

  it("the statement puts a brand mark on each END and the sentence between them", () => {
    const panels = [0, 1, 2, 3, 4].map((p) => vipSlidePanel(0, p, price)!);
    expect(panels[0]).toMatchObject({ bigBrand: true });
    expect(panels[4]).toMatchObject({ bigBrand: true });
    // Each inner panel holds ONE complete phrase, so no word crosses a gap.
    for (const p of panels.slice(1, 4)) expect(p).not.toMatchObject({ bigBrand: true });
    const sentence = panels
      .slice(1, 4)
      .map((p) => ("word" in p ? p.word : ""))
      .join(" ")
      .replace(/\n/g, " ");
    expect(sentence.toLowerCase()).toContain("two locations");
    expect(sentence.toLowerCase()).toContain("one price");
    // THE STATEMENT NAMES THE PRODUCT. It used to end on the phrase "one VIP
    // experience", which describes it without naming it — a guest could read the
    // whole wall and still not know what to ask for (owner 2026-08-18).
    expect(sentence).toContain(COMBO?.name ?? "VIP Experience");
    const named = panels[3];
    expect("rule" in named && named.rule).toBe("All Access");
  });

  it("NO WORD CROSSES A GAP — every headline is whole on its own panel", () => {
    // Line breaks inside a panel are fine (that is a wrap the design authored);
    // what must never happen is a phrase that only makes sense read with its
    // neighbour. Each panel's headline is checked to be a self-contained phrase by
    // being non-empty and not ending mid-word in a hyphen.
    for (const slide of [0, 1, 2, 3]) {
      for (const p of [0, 1, 2, 3, 4]) {
        const panel = vipSlidePanel(slide, p, price)!;
        const word = "word" in panel ? (panel.word ?? "") : "";
        if (!word) continue; // a brand-mark-only panel says nothing, which is whole
        expect(word.trim().endsWith("-"), `slide ${slide} panel ${p}: "${word}"`).toBe(false);
      }
    }
  });

  it("EVERY EYEBROW IS SELF-IDENTIFYING — a guest arriving mid-slide is not lost", () => {
    for (const slide of [1, 2]) {
      for (const p of [0, 1, 2, 3, 4]) {
        const panel = vipSlidePanel(slide, p, price)!;
        expect(panel.layout).toBe("card");
        if (panel.layout !== "card") continue;
        expect(panel.eyebrow.length, `slide ${slide} panel ${p}`).toBeGreaterThan(0);
      }
    }
  });

  it("the night names the five things a guest GETS, as a list not a timetable", () => {
    if (!COMBO) return;
    const words = [0, 1, 2, 3, 4].map((p) => {
      const panel = vipSlidePanel(1, p, price)!;
      return panel.layout === "card" ? panel.word.replace(/\n/g, " ").toLowerCase() : "";
    });
    // The two races sit TOGETHER (owner 2026-08-18). Ordering by sequence would put
    // the bowling between them and make the wall read as an itinerary.
    expect(words[0]).toContain("starter");
    expect(words[1]).toContain("intermediate");
    expect(words[2]).toContain("bowling");
    expect(words[3]).toContain("gel");
    expect(words[4]).toContain("game");

    // The three legs are still the pack's own three, whatever order they are SHOWN
    // in — that is what keeps the list honest as the pack changes.
    const kinds = COMBO.components.map((c) => `${c.kind}:${"tier" in c ? c.tier : ""}`);
    expect(kinds).toEqual(["race:starter", "bowling:", "race:intermediate"]);
  });

  it("every panel of the night carries its OWN picture, and no two repeat", () => {
    // "all with respective picture" (owner 2026-08-18) — a shared ground would put
    // the same bowling photo behind the gel blasters.
    const photos = [0, 1, 2, 3, 4].map((p) => {
      const panel = vipSlidePanel(1, p, price)!;
      return panel.layout === "card" ? panel.photo : undefined;
    });
    expect(photos.every(Boolean)).toBe(true);
    expect(new Set(photos).size).toBe(5);
  });

  it("the voucher panels keep the terms that make them TRUE", () => {
    // The pass is laser tag OR gel blaster, so a panel headlined "Gel blasters"
    // has to say so, or the wall has promised the wrong one of the two.
    const gel = vipSlidePanel(1, 3, price)!;
    expect(gel.layout === "card" && gel.line.toLowerCase()).toContain("laser tag");
    const gz = vipSlidePanel(1, 4, price)!;
    expect(gz.layout === "card" && gz.line).toContain("$10");
  });

  it("THE COPY PIN: every VIP wall label is something the live pack still claims", () => {
    // The labels are wall-shortened, not verbatim catalog strings — 88px type
    // cannot hold "1.5 Hours of VIP Bowling". So each one is pinned to a token the
    // pack's own includes/perks/vouchers contain. Retire a voucher or rename a leg
    // and THIS test names the label that stopped being true, instead of the wall
    // going on advertising it.
    if (!COMBO) return;
    const claims = comboClaims();
    const tokens = [
      "starter",
      "vip bowling",
      "intermediate",
      "licen", // "Racing License" (US) vs the wall's "licence" (house spelling)
      "pov",
      "neoverse",
      "chips & salsa",
      "game zone",
      "laser tag",
      "gel blaster",
      "shuffly",
    ];
    for (const t of tokens) {
      expect(claims, `the pack no longer mentions "${t}", but the wall does`).toContain(t);
    }
  });

  it("the price slide leads with TONIGHT's tier and states the other beside it", () => {
    const weekend = vipWallPrice(Date.parse("2026-08-15T18:00:00-04:00"))!;
    const p1 = vipSlidePanel(3, 1, weekend)!;
    const p2 = vipSlidePanel(3, 2, weekend)!;
    expect("word" in p1 && p1.word).toBe(weekend.todayLabel);
    expect("word" in p2 && p2.word).toBe(weekend.otherLabel);
    // The condition of the price sits on the same slide, not in small print.
    const p3 = vipSlidePanel(3, 3, weekend)!;
    expect("word" in p3 && p3.word).toContain(String(weekend.minGuests));
  });
});

describe("the menu board — one subject per panel", () => {
  const now = Date.parse("2026-08-17T18:00:00-04:00");

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

  it("is exactly five panels — one per TV", () => {
    expect(menuPanels(now, BOWLING)).toHaveLength(5);
    for (const p of [0, 1, 2, 3, 4]) expect(menuPanelAt(now, p, BOWLING)).not.toBeNull();
  });

  it("puts one SUBJECT on each panel, in wall order", () => {
    const heads = menuPanels(now, BOWLING).map((p) => p.headline);
    expect(heads[0]).toBe("Bowling");
    expect(heads[1]).toBe("Gel Blasters");
    expect(heads[2]).toBe("Game Zone");
    expect(heads[3]).toBe("At FastTrax");
    expect(heads[4]).toBe(COMBO?.name ?? "VIP Experience");
  });

  it("no two panels share a subject or a picture", () => {
    const panels = menuPanels(now, BOWLING);
    expect(new Set(panels.map((p) => p.headline)).size).toBe(5);
    expect(new Set(panels.map((p) => p.photo)).size).toBe(5);
  });

  it("every headline lands WHOLE on its panel — no word crosses a gap", () => {
    for (const p of menuPanels(now, BOWLING)) {
      expect(p.headline.includes("\n")).toBe(false);
      expect(p.headline.trim().endsWith("-")).toBe(false);
    }
  });

  it("a sixth panel gets NOTHING rather than a repeat of Bowling", () => {
    // Two panels headed "Bowling" would read as two bowling centres.
    expect(menuPanelAt(now, 5, BOWLING)).toBeNull();
  });

  it("Kids Bowl Free and Birthdays are OFF the board (owner 2026-08-18)", () => {
    const ids = menuPanels(now, BOWLING).flatMap((p) => p.rows.map((r) => r.productId));
    expect(ids).not.toContain("kbf");
    expect(ids).not.toContain("birthday-party");
  });

  it("EVERY ROW KEYS ON A REAL PRODUCT ID, or its pause gate silently never fires", () => {
    // A row keyed on a name the maintenance registry does not know looks gated and
    // is not — worse than no gate, because nobody checks it again.
    const known = new Set(allProductIds());
    for (const panel of menuPanels(now, BOWLING)) {
      for (const row of panel.rows) {
        if (!row.productId) continue;
        expect(known, `"${panel.headline} / ${row.name}" keys on "${row.productId}"`).toContain(
          row.productId,
        );
      }
    }
  });

  it("every row has either a price or a word — never a blank where money goes", () => {
    for (const panel of menuPanels(now, BOWLING)) {
      for (const row of panel.rows) {
        expect(Boolean(row.price || row.word), `${panel.headline} / ${row.name}`).toBe(true);
      }
    }
  });

  it("no row quotes $0", () => {
    for (const panel of menuPanels(now, BOWLING)) {
      for (const row of panel.rows) expect(row.price).not.toBe("$0");
    }
  });
});

describe("the bowling panel — the one attraction with no static price", () => {
  const now = Date.parse("2026-08-17T18:00:00-04:00");
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

  it("LEADS WITH TONIGHT'S SPECIAL, not the everyday lane rate", () => {
    // The first version sorted by `sort_order`, which puts the hourly rate (20-23)
    // ahead of the packages (30+) — so a Tuesday showed "Regular $45 per lane" and
    // Fun 4 All never appeared at all (owner 2026-08-18).
    const panel = menuPanelAt(now, 0, BOWLING)!;
    expect(panel.subhead).toBe("Tonight's special");
    expect(panel.rows[0]).toMatchObject({ name: "Fun 4 All", price: "$15.99" });
    expect(panel.rows[1]).toMatchObject({ name: "Fun 4 All VIP", price: "$17.99" });
  });

  it("still carries the plain lane rate underneath, marked as such", () => {
    // A guest who just wants a lane needs a number too — but it must not be
    // confusable with the package: one is per person for 90 minutes, the other per
    // lane by the hour.
    const panel = menuPanelAt(now, 0, BOWLING)!;
    expect(panel.rows).toHaveLength(3);
    expect(panel.rows[2].name.toLowerCase()).toContain("by the hour");
    expect(panel.rows[2].price).toBe("$45");
    expect(panel.rows[2].note).toContain("per lane");
  });

  it("says SHOES INCLUDED only where the offer actually includes them", () => {
    // Fun 4 All includes shoes; an hourly lane does not, and neither does Midnight
    // Madness. Blanket-printing it would be a $5-a-head surprise at the desk.
    const panel = menuPanelAt(now, 0, BOWLING)!;
    expect(panel.rows[0].note).toContain("shoes included");
    expect(panel.rows[1].note).toContain("shoes included");
    expect(panel.rows[2].note).not.toContain("shoes");
  });

  it("says WHICH UNIT every price is in — per lane is not per person", () => {
    // An hourly lane holds six bowlers. A bare "$45" is wrong by a factor of six
    // depending on which it is, which is why the unit rides with the price.
    const panel = menuPanelAt(now, 0, BOWLING)!;
    expect(panel.rows[0].note).toContain("per person");
    expect(panel.rows[0].note).toContain("1.5 hours");
    expect(panel.rows[2].note).toContain("per lane");
  });

  it("falls back to the LANE RATE on a night with no package", () => {
    const panel = menuPanelAt(now, 0, { special: null, hourly: BOWLING.hourly })!;
    expect(panel.subhead).toBeUndefined();
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBe("$45");
  });

  it("with NO catalog answer it sells availability — never an invented lane price", () => {
    // The house pricing rule: a displayed price must be the price the kiosk will
    // charge. Bowling is QAMF-dynamic and the static catalogue carries `price: 0`,
    // so a made-up number here is the exact failure that rule exists to prevent.
    const panel = menuPanelAt(now, 0, null)!;
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBeUndefined();
    expect(panel.rows[0].word).toBeTruthy();
    expect(panel.rows[0].tracksAvailability).toBe(true);
  });

  it("a catalog row with no priced item shows no price rather than a zero", () => {
    const panel = menuPanelAt(now, 0, {
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
    const panel = menuPanelAt(now, 0, BOWLING)!;
    for (const row of panel.rows) expect(row.productId).toBe("bowling");
  });
});

describe("the gel blaster, Game Zone and FastTrax panels", () => {
  const now = Date.parse("2026-08-17T18:00:00-04:00");

  it("gel blasters and laser tag SHARE a panel, both priced, both tracked", () => {
    // One trip, one desk, one briefing — so one panel, over the gel photograph
    // (owner 2026-08-18).
    const panel = menuPanelAt(now, 1, null)!;
    expect(panel.rows.map((r) => r.productId)).toEqual(["gel-blaster", "laser-tag"]);
    for (const row of panel.rows) {
      expect(row.price, row.name).toBeTruthy();
      expect(row.tracksAvailability).toBe(true);
    }
  });

  it("Game Zone is alone, and quotes no price — a card is loaded with any amount", () => {
    const panel = menuPanelAt(now, 2, null)!;
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].productId).toBe("game-zone");
    expect(panel.rows[0].price).toBeUndefined();
    // Independent of every booking vendor, so it never tracks booking availability.
    expect(panel.rows[0].tracksAvailability).toBeUndefined();
  });

  it("the FastTrax panel carries Racing and Duckpin — the other building", () => {
    const panel = menuPanelAt(now, 3, null)!;
    expect(panel.rows.map((r) => r.productId)).toEqual(["race", "duck-pin"]);
  });

  it("RACING does not claim a next-available it can never have", () => {
    // `firstOpen.race` is declared in ExperienceFirstOpen and nothing ever writes
    // it (owner 2026-07-25 — a per-tier heat line was too busy for a tile), which
    // is verified against the live cache. A row that claimed to track it would
    // print "Ask at the desk" over a track that is open all evening.
    const racing = menuPanelAt(now, 3, null)!.rows.find((r) => r.productId === "race")!;
    expect(racing.tracksAvailability).toBeUndefined();
    expect(racing.price).toBeTruthy();
  });

  it("Duckpin DOES track availability — it has a real key in the cache", () => {
    const duck = menuPanelAt(now, 3, null)!.rows.find((r) => r.productId === "duck-pin")!;
    expect(duck.tracksAvailability).toBe(true);
  });
});

describe("the VIP panel", () => {
  const now = Date.parse("2026-08-15T18:00:00-04:00"); // a weekend

  it("is named for the product and badged All Access", () => {
    const panel = menuPanelAt(now, 4, null)!;
    expect(panel.headline).toBe(COMBO?.name ?? "VIP Experience");
    expect(panel.subhead).toBe("All Access");
  });

  it("quotes tonight's real tier and names the other days", () => {
    if (!COMBO) return;
    const panel = menuPanelAt(now, 4, null)!;
    expect(panel.rows[0].name).toContain(dollars(COMBO.price.weekend));
    expect(panel.rows[0].note).toContain(dollars(COMBO.price.weekday));
    expect(panel.rows[0].note).toContain(String(COMBO.minHeadcount ?? 2));
  });
});

describe("the kiosk how-to", () => {
  it("is one verb per panel, five of them, each self-contained", () => {
    for (const p of [0, 1, 2, 3, 4]) {
      const panel = howtoPanel(p)!;
      expect(panel).not.toBeNull();
      expect(panel.verb.length).toBeGreaterThan(0);
      expect(panel.line.length).toBeGreaterThan(0);
    }
  });

  it("a sixth panel gets NULL, never a repeat", () => {
    // The verb names the machine BELOW THIS PANEL. A duplicated verb points a guest
    // at the wrong kiosk, which is worse than a quiet panel.
    expect(howtoPanel(5)).toBeNull();
  });

  it("no two panels give the same instruction", () => {
    const verbs = [0, 1, 2, 3, 4].map((p) => howtoPanel(p)!.verb);
    expect(new Set(verbs).size).toBe(5);
  });

  it('EVERY panel says "on the kiosk below" — the verb alone does not point', () => {
    // Owner 2026-08-18: an arrow-only band was tried and the words were asked for
    // back. A guest reading a verb eight feet up is not thereby told that the box
    // in front of them is how.
    for (const p of [0, 1, 2, 3, 4]) {
      expect(howtoPanel(p)!.band, `panel ${p}`).toContain("kiosk below");
    }
  });

  it('says "THE kiosk below", never "any" — this board names one machine', () => {
    // The ad rotation says "any kiosk below" because it sells the whole bank. This
    // board's entire point is that the verb belongs to the machine under THIS panel.
    for (const p of [0, 1, 2, 3, 4]) {
      expect(howtoPanel(p)!.band.toLowerCase()).not.toContain("any kiosk");
    }
  });

  it("the band's verb agrees with the headline — check in is not a purchase", () => {
    expect(howtoPanel(0)!.band).toBe("Check in on the kiosk below");
    expect(howtoPanel(1)!.band).toBe("Buy it on the kiosk below");
    expect(howtoPanel(2)!.band).toBe("Book it on the kiosk below");
    expect(howtoPanel(3)!.band).toBe("Load it on the kiosk below");
    expect(howtoPanel(4)!.band).toBe("Buy it on the kiosk below");
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

  it("is 8 slots — 5m20s", () => {
    const slots = (preset.config.playlist ?? []).reduce((n, e) => n + (e.slots ?? 1), 0);
    expect(slots).toBe(8);
    expect((slots * SLOT_MS) / 1000).toBe(320);
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
