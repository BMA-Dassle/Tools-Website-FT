import { describe, it, expect } from "vitest";
import {
  dollars,
  howtoPanel,
  identityRail,
  menuTiles,
  menuTilesFor,
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
    expect(sentence.toLowerCase()).toContain("one vip experience");
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

  it("the three legs are the pack's own three legs, in order", () => {
    if (!COMBO) return;
    const legs = [1, 2, 3].map((p) => {
      const panel = vipSlidePanel(1, p, price)!;
      return panel.layout === "card" ? panel.word.replace(/\n/g, " ").toLowerCase() : "";
    });
    expect(legs[0]).toContain("starter");
    expect(legs[1]).toContain("bowling");
    expect(legs[2]).toContain("intermediate");
    // …and they are the components the combo actually books, in the same order.
    const kinds = COMBO.components.map((c) => `${c.kind}:${"tier" in c ? c.tier : ""}`);
    expect(kinds).toEqual(["race:starter", "bowling:", "race:intermediate"]);
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

describe("the menu board", () => {
  const now = Date.parse("2026-08-17T18:00:00-04:00");

  it("is ten tiles, so five panels get two each with none left over", () => {
    expect(menuTiles(now)).toHaveLength(10);
    const dealt = [0, 1, 2, 3, 4].map((p) => menuTilesFor(now, p, 5));
    expect(dealt.map((t) => t.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it("every tile appears exactly once across the wall", () => {
    const ids = [0, 1, 2, 3, 4].flatMap((p) => menuTilesFor(now, p, 5).map((t) => t.productId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      menuTiles(now)
        .map((t) => t.productId)
        .sort(),
    );
  });

  it("EVERY TILE KEYS ON A REAL PRODUCT ID, or its pause gate silently never fires", () => {
    // A tile keyed on a name the maintenance registry does not know looks gated and
    // is not — worse than no gate at all, because nobody checks it again.
    const known = new Set(allProductIds());
    // Birthdays is deliberately unclassified: an enquiry at the desk is not a
    // vendor booking and stays sellable through any outage.
    const exempt = new Set(["birthday-party"]);
    for (const tile of menuTiles(now)) {
      if (exempt.has(tile.productId)) continue;
      expect(known, `tile "${tile.name}" keys on unknown product "${tile.productId}"`).toContain(
        tile.productId,
      );
    }
  });

  it("BOWLING SHOWS AVAILABILITY, NEVER A PRICE — lane pricing is QAMF-dynamic", () => {
    const bowling = menuTiles(now).find((t) => t.productId === "bowling")!;
    expect(bowling.price).toBeUndefined();
    expect(bowling.word).toBeTruthy();
  });

  it("Game Zone shows no price either — a card is loaded with whatever they choose", () => {
    const gz = menuTiles(now).find((t) => t.productId === "game-zone")!;
    expect(gz.price).toBeUndefined();
  });

  it("every tile has either a price or a word — never a blank where money goes", () => {
    for (const tile of menuTiles(now)) {
      expect(Boolean(tile.price || tile.word), `tile "${tile.name}"`).toBe(true);
    }
  });

  it("no tile quotes $0", () => {
    for (const tile of menuTiles(now)) expect(tile.price).not.toBe("$0");
  });

  it("the All Access tile quotes tonight's real tier", () => {
    if (!COMBO) return;
    const tile = menuTiles(Date.parse("2026-08-15T18:00:00-04:00")).find(
      (t) => t.productId === "race-bowl",
    )!;
    expect(tile.price).toBe(dollars(COMBO.price.weekend));
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
