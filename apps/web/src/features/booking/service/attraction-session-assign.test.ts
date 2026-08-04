/**
 * Attraction → Pandora session assignment (owner 2026-08-04: "I have reason to
 * believe we're not assigning them to the session via pandora like we do
 * racing"). Proven on W57593: three participants registered as BMI project
 * persons, `9:15 PM HP Arena` column unchecked, because `buildKioskRacers` walks
 * race heats only and the rail's gate was race-only too.
 *
 * These pin the row shape and the server choice — the two things that decide
 * whether the vendor can bind the row at all.
 */
import { describe, expect, it } from "vitest";
import { buildKioskAttractionRows, pandoraLocationForCenter } from "./kiosk-post-reserve";
import type { AttractionItem, BookingSession } from "../state/types";

function slot(start: string, stop: string) {
  return {
    productLineId: 1,
    blocks: [
      {
        productLineIds: [1],
        block: {
          name: "HP Arena",
          capacity: 24,
          freeSpots: 20,
          resourceId: 305133,
          prices: [],
          start,
          stop,
        },
      },
    ],
  };
}

function attraction(patch: Partial<AttractionItem> = {}): AttractionItem {
  return {
    id: "a1",
    kind: "attraction",
    slug: "laser-tag",
    date: "2026-08-03",
    slot: "21:15",
    qty: 2,
    productId: "8976685",
    pageId: "24909729",
    price: 24.99,
    bmiLineId: "l1",
    slotProposal: slot("2026-08-03T21:15:00", "2026-08-03T21:30:00"),
    assignedTo: [],
    ...patch,
  } as AttractionItem;
}

function session(party: unknown[], items: unknown[]): BookingSession {
  return { party, items } as unknown as BookingSession;
}

const ADULT = { id: "m1", firstName: "Bruce", lastName: "Camille", pandoraPersonId: "23172271" };
const JUNIOR = {
  id: "m2",
  firstName: "Christopher",
  lastName: "Aponte",
  pandoraPersonId: "2178784",
  category: "junior",
};

describe("buildKioskAttractionRows", () => {
  it("one row per participant, with the slot's OWN window — never a guessed duration", () => {
    const item = attraction({ participants: ["m1", "m2"] });
    const rows = buildKioskAttractionRows(session([ADULT, JUNIOR], [item]), [item]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      racerName: "Bruce Camille",
      personId: "23172271",
      product: "Nexus Laser Tag",
      productId: "8976685",
      track: null,
      category: "adult",
      heatStart: "2026-08-03T21:15:00",
      heatStop: "2026-08-03T21:30:00",
    });
    // The junior must not be filed as an adult — the real W57593 party had a
    // 14-year-old on it.
    expect(rows[1]).toMatchObject({ personId: "2178784", category: "junior" });
  });

  it("tier is the attraction placeholder, never a race tier", () => {
    const item = attraction({ participants: ["m1"] });
    const [row] = buildKioskAttractionRows(session([ADULT], [item]), [item]);
    // Writing "starter" here would put false racing data in the vendor's
    // schedule. Pending tier/track becoming optional upstream.
    expect(row.tier).toBe("attraction");
    expect(row.tier).not.toBe("starter");
  });

  it("falls back to the bill roster when the kiosk participant list is absent", () => {
    const item = attraction({ assignedTo: ["m1"] });
    const rows = buildKioskAttractionRows(session([ADULT], [item]), [item]);
    expect(rows.map((r) => r.personId)).toEqual(["23172271"]);
  });

  it("prefers the kiosk participant list when both exist", () => {
    const item = attraction({ participants: ["m2"], assignedTo: ["m1", "m2"] });
    const rows = buildKioskAttractionRows(session([ADULT, JUNIOR], [item]), [item]);
    expect(rows.map((r) => r.personId)).toEqual(["2178784"]);
  });

  it("drops a participant with no person id rather than sending a null", () => {
    const noId = { id: "m3", firstName: "Walk", lastName: "Up" };
    const item = attraction({ participants: ["m1", "m3"] });
    const rows = buildKioskAttractionRows(session([ADULT, noId], [item]), [item]);
    expect(rows.map((r) => r.personId)).toEqual(["23172271"]);
  });

  it("skips an item whose slot proposal never came back — no window, no row", () => {
    const item = attraction({ participants: ["m1"], slotProposal: null });
    expect(buildKioskAttractionRows(session([ADULT], [item]), [item])).toEqual([]);
  });

  it("covers every BMI-vendored attraction, not just the arena ones", () => {
    const duckpin = attraction({
      id: "a2",
      slug: "duck-pin",
      participants: ["m1"],
      productId: "111",
    });
    const [row] = buildKioskAttractionRows(session([ADULT], [duckpin]), [duckpin]);
    expect(row.product).toBe("FastTrax Duckpin Bowling");
  });
});

describe("pandoraLocationForCenter", () => {
  it("Fort Myers shares the racing server — one post carries karts AND the arena", () => {
    // locationID is a BMI SERVER lookup, not a venue scope (vendor doc), and
    // FastTrax + HP Fort Myers are on the same server (owner 2026-08-04).
    expect(pandoraLocationForCenter("fort-myers")).toBe("LAB52GY480CJF");
  });

  it("Naples resolves to its own server", () => {
    expect(pandoraLocationForCenter("naples")).toBe("PPTR5G2N0QXF7");
  });

  it("an unknown/absent center falls back to Fort Myers, never to nothing", () => {
    expect(pandoraLocationForCenter(null)).toBe("LAB52GY480CJF");
    expect(pandoraLocationForCenter("mars")).toBe("LAB52GY480CJF");
  });
});
