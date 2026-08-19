import { describe, it, expect } from "vitest";
import {
  dollars,
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
import { TOKEN_PACKAGES } from "~/features/game-cards";
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
    // Still NAMES the product with the badge under it, even with no price to quote.
    expect(identityRail(0, null)!.text).toBe(COMBO?.name ?? "VIP Experience");
    expect(identityRail(0, null)!.small).toBe("All Access");
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
    // THE PRODUCT NAME, with the badge beneath it — never the badge alone (owner
    // 2026-08-19). A guest who reads only "All Access" cannot ask for it at the desk.
    expect(identityRail(0, price)).toMatchObject({
      text: COMBO?.name ?? "VIP Experience",
      small: "All Access",
      isName: true,
    });
    expect(identityRail(3, price)).toMatchObject({ isPrice: true, quiet: "per person" });
    expect(identityRail(3, price)!.text).toContain("$");
  });

  it("names the pack the registry names, so a rebrand carries through", () => {
    if (!COMBO) return;
    expect(identityRail(0, price)!.text).toBe(COMBO.name);
  });

  it("the second cell stopped repeating the name, and carries the pack's duration", () => {
    // It used to be the product name, which would now be said twice on one wall.
    expect(identityRail(1, price)!.text).not.toBe(COMBO?.name ?? "VIP Experience");
    expect(identityRail(1, price)!.text.toLowerCase()).toContain("hours");
  });

  it("THE TWO BRANDS ARE MARKS, never words on the glass", () => {
    // The wall shipped saying "FastTrax HeadPinz" as text, which reads as one
    // invented company rather than two venues on one pass (owner 2026-08-19).
    // The cell must therefore carry `brands` for the renderer to draw logos.
    const pair = identityRail(2, price)!;
    expect(pair.brands).toEqual(["fasttrax", "headpinz"]);
    // …and `text` stays as the accessible name for the lockup, joined so it cannot
    // be mistaken for a single name if it is ever read aloud.
    expect(pair.text).toBe("FastTrax + HeadPinz");
  });

  it("no rail cell anywhere spells a brand pair as bare words", () => {
    // The regression guard: any cell naming both brands must render them as marks.
    for (const slide of [undefined, 0, 1, 2, 3]) {
      for (const p of [0, 1, 2, 3, 4]) {
        const cell = identityRail(p, price, slide);
        if (!cell) continue;
        const namesBoth = /fasttrax/i.test(cell.text) && /headpinz/i.test(cell.text);
        if (namesBoth) {
          expect(cell.brands, `slide ${slide} panel ${p} spells both brands`).toBeTruthy();
        }
      }
    }
  });

  it("NOWHERE says All Access without naming the product above it", () => {
    // The badge is the wall's word for the thing, not the thing's name.
    for (const slide of [0, 1, 2, 3]) {
      for (const p of [0, 1, 2, 3, 4]) {
        const cell = identityRail(p, price, slide);
        if (!cell) continue;
        if (cell.text === "All Access") throw new Error(`slide ${slide} panel ${p} is badge-only`);
        if (cell.small === "All Access") {
          expect(cell.text).toBe(COMBO?.name ?? "VIP Experience");
        }
      }
    }
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
    // …and the takeover's 2 slots are exactly ONE full pass of the four slides, so no
    // slide is ever cut in half (owner 2026-08-19).
    const slots = (rolePreset("front-desk").config.playlist ?? []).find(
      (e) => e.scene === "vip-showcase",
    )?.slots;
    expect((slots! * SLOT_MS) / VIP_SLIDE_MS).toBe(4);
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

describe("the menu board — one subject per panel, three at a time", () => {
  // Slot boundaries, so the subject set is deterministic: even slot = set A.
  const setA = 1000 * SLOT_MS + 5_000;
  const setB = 1001 * SLOT_MS + 5_000;

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

  it("is THREE panels — the board spans the middle of the wall", () => {
    // Not five: TV1 and TV5 run their own boards, and choreo() hands this scene a
    // span-relative position so it composes over 0..2.
    expect(menuPanels(setA, BOWLING)).toHaveLength(3);
    expect(menuPanels(setB, BOWLING)).toHaveLength(3);
    for (const p of [0, 1, 2]) expect(menuPanelAt(setA, p, BOWLING)).not.toBeNull();
  });

  it("deals SIX subject slots across two sets, cut on the slot boundary", () => {
    const a = menuPanels(setA, BOWLING).map((p) => p.headline);
    const b = menuPanels(setB, BOWLING).map((p) => p.headline);
    expect(a).toEqual(["Bowling", "Gel Blasters", "Game Zone"]);
    expect(b[0]).toBe("At FastTrax");
    expect(b[1]).toBe(COMBO?.name ?? "VIP Experience");
    expect(b[2]).toBe("Bowling");
  });

  it("the set is clock-derived, so all three panels cut TOGETHER", () => {
    // Same instant ⇒ same set for every position. If this were per-panel state the
    // three would drift and the board would read as three unrelated screens.
    for (const p of [0, 1, 2]) {
      expect(menuPanelAt(setA, p, BOWLING)!.headline).toBe(menuPanels(setA, BOWLING)[p].headline);
    }
    expect(menuPanels(setA, BOWLING)[0].headline).not.toBe(menuPanels(setB, BOWLING)[0].headline);
  });

  it("BOWLING appears in both sets, but never with the same rows", () => {
    // It is a bowling centre — the headline product earns double airtime, and the
    // second pass sells the VIP tier rather than repeating the offer.
    const a = menuPanels(setA, BOWLING)[0];
    const b = menuPanels(setB, BOWLING)[2];
    expect(a.headline).toBe("Bowling");
    expect(b.headline).toBe("Bowling");
    expect(a.rows[0].name).not.toBe(b.rows[0].name);
    expect(a.rows[0].name).toBe("Fun 4 All");
    expect(b.rows[0].name).toBe("Fun 4 All VIP");
    expect(b.subhead).toContain("VIP");
  });

  it("no two panels in a set share a subject or a picture", () => {
    for (const now of [setA, setB]) {
      const panels = menuPanels(now, BOWLING);
      expect(new Set(panels.map((p) => p.headline)).size).toBe(3);
      expect(new Set(panels.map((p) => p.photo)).size).toBe(3);
    }
  });

  it("EVERY panel carries the kiosk instruction — it is chrome now, not a scene", () => {
    // The separate how-to slot was deleted; carrying the instruction on the pricing
    // panel says both at once and costs no airtime (owner 2026-08-19).
    for (const now of [setA, setB]) {
      for (const panel of menuPanels(now, BOWLING)) {
        expect(panel.band, panel.headline).toContain("kiosk below");
        // "THE kiosk below", never "any" — the ad rotation sells the bank; this board
        // names the one machine under this panel.
        expect(panel.band.toLowerCase()).not.toContain("any kiosk");
      }
    }
  });

  it("the band's verb agrees with the panel — you don't buy a game card", () => {
    expect(menuPanels(setA, BOWLING)[2].band).toBe("Load it on the kiosk below");
    expect(menuPanels(setB, BOWLING)[0].band).toBe("Book it on the kiosk below");
    expect(menuPanels(setA, BOWLING)[0].band).toBe("Buy it on the kiosk below");
  });

  it("every headline lands WHOLE on its panel — no word crosses a gap", () => {
    for (const now of [setA, setB]) {
      for (const p of menuPanels(now, BOWLING)) {
        expect(p.headline.includes("\n")).toBe(false);
        expect(p.headline.trim().endsWith("-")).toBe(false);
      }
    }
  });

  it("a fourth panel gets NOTHING rather than a repeat", () => {
    expect(menuPanelAt(setA, 3, BOWLING)).toBeNull();
  });

  it("Kids Bowl Free and Birthdays are OFF the board", () => {
    const ids = [setA, setB].flatMap((now) =>
      menuPanels(now, BOWLING).flatMap((p) => p.rows.map((r) => r.productId)),
    );
    expect(ids).not.toContain("kbf");
    expect(ids).not.toContain("birthday-party");
  });

  it("EVERY ROW KEYS ON A REAL PRODUCT ID, or its pause gate silently never fires", () => {
    const known = new Set(allProductIds());
    for (const now of [setA, setB]) {
      for (const panel of menuPanels(now, BOWLING)) {
        for (const row of panel.rows) {
          if (!row.productId) continue;
          expect(known, `"${panel.headline} / ${row.name}" keys on "${row.productId}"`).toContain(
            row.productId,
          );
        }
      }
    }
  });

  it("every row has either a price or a word, and none quotes $0", () => {
    for (const now of [setA, setB]) {
      for (const panel of menuPanels(now, BOWLING)) {
        for (const row of panel.rows) {
          expect(Boolean(row.price || row.word), `${panel.headline} / ${row.name}`).toBe(true);
          expect(row.price).not.toBe("$0");
        }
      }
    }
  });
});

describe("the bowling panel — the one attraction with no static price", () => {
  const setA = 1000 * SLOT_MS + 5_000;
  const BOWLING = {
    special: {
      regular: {
        label: "Fun 4 All",
        priceLabel: "$15.99",
        unit: "per person",
        durationLabel: "1.5 hours",
        shoesIncluded: true,
      },
      vip: null,
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

  it("LEADS WITH TONIGHT'S SPECIAL, not the everyday lane rate", () => {
    // The first cut sorted by `sort_order`, which puts the hourly rate (20-23) ahead of
    // the packages (30+) — so a Tuesday showed "Regular $45 per lane" and Fun 4 All
    // never appeared at all (owner 2026-08-18).
    const panel = menuPanelAt(setA, 0, BOWLING)!;
    expect(panel.subhead).toBe("Tonight's special");
    expect(panel.rows[0]).toMatchObject({ name: "Fun 4 All", price: "$15.99" });
  });

  it("carries the plain lane rate underneath, marked as such", () => {
    const panel = menuPanelAt(setA, 0, BOWLING)!;
    expect(panel.rows).toHaveLength(2);
    expect(panel.rows[1].name.toLowerCase()).toContain("by the hour");
    expect(panel.rows[1].price).toBe("$45");
    expect(panel.rows[1].note).toContain("per lane");
  });

  it("says SHOES INCLUDED only where the offer actually includes them", () => {
    // Fun 4 All includes shoes; an hourly lane does not, and neither does Midnight
    // Madness. Blanket-printing it would be a $5-a-head surprise at the desk.
    const panel = menuPanelAt(setA, 0, BOWLING)!;
    expect(panel.rows[0].note).toContain("shoes included");
    expect(panel.rows[1].note).not.toContain("shoes");
  });

  it("says WHICH UNIT every price is in — per lane is not per person", () => {
    // An hourly lane holds six bowlers. A bare "$45" is wrong by a factor of six
    // depending on which it is, which is why the unit rides with the price.
    const panel = menuPanelAt(setA, 0, BOWLING)!;
    expect(panel.rows[0].note).toContain("per person");
    expect(panel.rows[1].note).toContain("per lane");
  });

  it("with NO catalog answer it sells availability — never an invented lane price", () => {
    // The house pricing rule: a displayed price must be the price the kiosk will
    // charge. Bowling is QAMF-dynamic and the static catalogue carries `price: 0`.
    const panel = menuPanelAt(setA, 0, null)!;
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBeUndefined();
    expect(panel.rows[0].word).toBeTruthy();
    expect(panel.rows[0].tracksAvailability).toBe(true);
  });

  it("falls back to the LANE RATE on a night with no package", () => {
    const panel = menuPanelAt(setA, 0, { special: null, hourly: BOWLING.hourly })!;
    expect(panel.subhead).toBeUndefined();
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0].price).toBe("$45");
  });

  it("a catalog row with no priced item shows no price rather than a zero", () => {
    const panel = menuPanelAt(setA, 0, {
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
    const panel = menuPanelAt(setA, 0, BOWLING)!;
    for (const row of panel.rows) expect(row.productId).toBe("bowling");
  });
});

describe("the other subject panels", () => {
  const setA = 1000 * SLOT_MS + 5_000;
  const setB = 1001 * SLOT_MS + 5_000;

  it("gel blasters and laser tag SHARE a panel, both priced, both tracked", () => {
    const panel = menuPanelAt(setA, 1, null)!;
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
    const panel = menuPanelAt(setA, 2, null)!;
    expect(panel.rows).toHaveLength(2);
    for (const row of panel.rows) {
      expect(row.productId).toBe("game-zone");
      // Game Zone runs on Intercard, independent of every booking vendor, so it has no
      // bookable slot to track.
      expect(row.tracksAvailability).toBeUndefined();
      expect(row.name).toMatch(/^\$\d+ card$/);
      expect(row.word).toContain("tokens");
      expect(row.note).toContain("bonus");
    }
  });

  it("the Game Zone tiers read cheapest-first and quote the TOTAL, not the price", () => {
    // A guest choosing a tier compares how many tokens land on the card, so that is the
    // headline number; the price is the row's name.
    const rows = menuPanelAt(setA, 2, null)!.rows;
    const cents = rows.map((r) => Number(r.name.replace(/[^0-9]/g, "")));
    expect(cents[0]).toBeLessThan(cents[1]);
    // …and the total exceeds the face tokens, which is what the bonus means.
    const totals = rows.map((r) => Number((r.word ?? "").replace(/[^0-9]/g, "")));
    expect(totals[0]).toBeGreaterThan(cents[0] * 10);
    expect(totals[1]).toBeGreaterThan(cents[1] * 10);
  });

  it("the Game Zone prices come from the table the KIOSK charges from", () => {
    const rows = menuPanelAt(setA, 2, null)!.rows;
    const bonusTiers = TOKEN_PACKAGES.filter((t) => t.bonusTokens > 0);
    expect(bonusTiers.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const price = Number(row.name.replace(/[^0-9]/g, "")) * 100;
      const pkg = bonusTiers.find((t) => t.priceCents === price);
      expect(pkg, `no package priced ${row.name}`).toBeTruthy();
      expect(row.word).toContain((pkg!.tokens + pkg!.bonusTokens).toLocaleString("en-US"));
      expect(row.note).toContain(String(pkg!.bonusTokens));
    }
  });

  it("the FastTrax panel carries Racing and Duckpin — the other building", () => {
    const panel = menuPanelAt(setB, 0, null)!;
    expect(panel.rows.map((r) => r.productId)).toEqual(["race", "duck-pin"]);
  });

  it("RACING does not claim a next-available it can never have", () => {
    // `firstOpen.race` is declared in ExperienceFirstOpen and nothing ever writes it
    // (owner 2026-07-25), verified against the live cache. A row claiming to track it
    // would print "Ask at the desk" over a track open all evening.
    const racing = menuPanelAt(setB, 0, null)!.rows.find((r) => r.productId === "race")!;
    expect(racing.tracksAvailability).toBeUndefined();
    expect(racing.price).toBeTruthy();
  });

  it("Duckpin DOES track availability — it has a real key in the cache", () => {
    const duck = menuPanelAt(setB, 0, null)!.rows.find((r) => r.productId === "duck-pin")!;
    expect(duck.tracksAvailability).toBe(true);
  });

  it("the VIP panel is named for the product and badged All Access", () => {
    const panel = menuPanelAt(setB, 1, null)!;
    expect(panel.headline).toBe(COMBO?.name ?? "VIP Experience");
    expect(panel.subhead).toBe("All Access");
  });

  it("the VIP panel quotes tonight's real tier and names the other days", () => {
    if (!COMBO) return;
    const weekend = 1001 * SLOT_MS + 5_000;
    const panel = menuPanelAt(weekend, 1, null)!;
    expect(panel.rows[0].name).toContain("$");
    expect(panel.rows[0].note).toContain(String(COMBO.minHeadcount ?? 2));
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

  it("is 9 slots — SIX MINUTES exactly", () => {
    // The reason it is nine and not eight: 9 x 40s is 6:00, of which the showcase takes
    // two slots (80s, one full pass of its four 20s slides) and pricing holds the other
    // 4:40. That is the whole "standing state taken over" rhythm, with no new mechanism.
    const slots = (preset.config.playlist ?? []).reduce((n, e) => n + (e.slots ?? 1), 0);
    expect(slots).toBe(9);
    expect((slots * SLOT_MS) / 1000).toBe(360);
    const vip = (preset.config.playlist ?? []).find((e) => e.scene === "vip-showcase");
    expect(vip?.slots).toBe(2);
    expect(Math.round(((vip!.slots ?? 1) / slots) * 100)).toBe(22);
  });

  it("the showcase spans the WALL and the menu board the MIDDLE", () => {
    const byScene = Object.fromEntries(
      (preset.config.playlist ?? []).map((e) => [e.scene, e.span]),
    );
    expect(byScene["vip-showcase"]).toBe("wall");
    expect(byScene["open-now"]).toBe("middle");
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
    // deliberate rather than incidental. If anyone reintroduces a literal in the form,
    // that is what to catch in review; the code has no second source any more.
    const fromPreset = (preset.config.playlist ?? []).map(
      (e) => `${e.scene}:${e.slots ?? 1}:${e.span ?? "wall"}:${e.requiresData === true}`,
    );
    expect(fromPreset).toEqual(["open-now:7:middle:false", "vip-showcase:2:wall:false"]);
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
