import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUP_ID, DIRECTOR_ONLY_SCREENS } from "./contracts";
import {
  MORE_ITEMS,
  NAV_GROUPS,
  PHONE_TABS,
  SCREEN_META,
  allNavIds,
  canViewScreen,
  eventDayHref,
  isDirectorOnlyScreen,
  isScreenId,
  moreForRole,
  navForRole,
  tabsForRole,
} from "./nav";
import { SCREENS } from "./screens";
import { SCREEN_IDS } from "./types";

const ids = (groups: { items: { id: string }[] }[]) =>
  groups.flatMap((g) => g.items.map((i) => i.id));

describe("the nav is the prototype's (direction-b.html:51-57,121)", () => {
  it("has the four groups in order with the prototype's items", () => {
    expect(NAV_GROUPS.map((g) => [g.id, g.label])).toEqual([
      ["main", null],
      ["grow", "Find & grow"],
      ["measure", "Measure"],
      ["admin", "Admin"],
    ]);
    expect(ids([...NAV_GROUPS])).toEqual([
      "today",
      "pipeline",
      "queue",
      "contracts",
      "events",
      "conversations",
      "calls",
      "history",
      "cold",
      "collateral",
      "accountability",
      "kpi",
      "rules",
      "statuses",
    ]);
    expect(NAV_GROUPS[3].id).toBe(ADMIN_NAV_GROUP_ID);
  });

  it("has the five phone tabs", () => {
    expect(PHONE_TABS.map((t) => t.id)).toEqual([
      "today",
      "pipeline",
      "contracts",
      "conversations",
      "more",
    ]);
    expect(PHONE_TABS.find((t) => t.id === "conversations")?.label).toBe("Messages");
  });

  it("flags exactly queue, rules, statuses and goals as director-only", () => {
    const flagged = [...NAV_GROUPS.flatMap((g) => g.items), ...PHONE_TABS, ...MORE_ITEMS]
      .filter((i) => i.director)
      .map((i) => i.id);
    expect(new Set(flagged)).toEqual(new Set(["queue", "rules", "statuses", "goals"]));
    expect([...DIRECTOR_ONLY_SCREENS].sort()).toEqual(["goals", "queue", "rules", "statuses"]);
    for (const id of DIRECTOR_ONLY_SCREENS) expect(isDirectorOnlyScreen(id)).toBe(true);
    expect(isDirectorOnlyScreen("pipeline")).toBe(false);
  });

  it("`ready` agrees with SCREENS: a ready item has a real body, an unready one is NotBuiltYet", () => {
    // PR-agnostic on purpose: each feature PR flips its own `ready` line(s) AND
    // its own SCREENS line, and this holds the two in step without every PR
    // editing the same assertion. A half-flipped entry (nav says ready, the
    // loader still points at NotBuiltYet — or the reverse) fails here.
    const items = [...NAV_GROUPS.flatMap((g) => g.items), ...PHONE_TABS, ...MORE_ITEMS];
    expect(items.length).toBeGreaterThan(10);
    for (const i of items) {
      const loader = SCREENS[i.id].toString();
      const notBuilt = loader.includes("shell/NotBuiltYet");
      expect(
        i.ready,
        `${i.id}: ready=${i.ready} but loader is ${notBuilt ? "NotBuiltYet" : "real"}`,
      ).toBe(!notBuilt);
    }
    // The same id appears in more than one list (sidebar / tabs / More); all copies agree.
    const byId = new Map<string, boolean>();
    for (const i of items) {
      const seen = byId.get(i.id);
      if (seen !== undefined) expect(seen, `${i.id} ready differs between lists`).toBe(i.ready);
      byId.set(i.id, i.ready);
    }
  });
});

describe("role views", () => {
  it("the rep view hides the director items AND the now-empty Admin group", () => {
    const rep = navForRole("rep");
    expect(rep.map((g) => g.id)).toEqual(["main", "grow", "measure"]);
    expect(ids(rep)).not.toContain("queue");
    expect(ids(rep)).not.toContain("rules");
    expect(ids(rep)).not.toContain("statuses");
    expect(moreForRole("rep").map((i) => i.id)).not.toContain("goals");
    expect(tabsForRole("rep").map((t) => t.id)).toEqual(PHONE_TABS.map((t) => t.id));
  });

  it("the director view is the whole nav", () => {
    const dir = navForRole("director");
    expect(dir.map((g) => g.id)).toEqual(["main", "grow", "measure", "admin"]);
    expect(ids(dir)).toEqual(ids([...NAV_GROUPS]));
    expect(moreForRole("director").map((i) => i.id)).toContain("goals");
  });

  it("canViewScreen refuses reps the director-only set and nothing else", () => {
    for (const id of SCREEN_IDS) {
      expect(canViewScreen("director", id), id).toBe(true);
      expect(canViewScreen("rep", id), id).toBe(!DIRECTOR_ONLY_SCREENS.includes(id));
    }
  });
});

describe("every screen id is wired end to end", () => {
  it("every nav id has a SCREENS loader and SCREEN_META", () => {
    for (const id of allNavIds()) {
      expect(typeof SCREENS[id], `SCREENS.${id}`).toBe("function");
      expect(SCREEN_META[id].title, `SCREEN_META.${id}`).toBeTruthy();
    }
  });

  it("SCREENS and SCREEN_META cover exactly SCREEN_IDS", () => {
    expect(Object.keys(SCREENS).sort()).toEqual([...SCREEN_IDS].sort());
    expect(Object.keys(SCREEN_META).sort()).toEqual([...SCREEN_IDS].sort());
  });

  it("isScreenId guards the URL's first segment", () => {
    expect(isScreenId("pipeline")).toBe(true);
    expect(isScreenId("leads")).toBe(false); // the prototype's name, not ours
    expect(isScreenId("")).toBe(false);
    expect(isScreenId(undefined)).toBe(false);
  });
});

/**
 * The link a contract, and a mirrored past booking, use to reach the day the
 * event actually happens. It has to be ONE spelling, because four screens link
 * to it and the Events board only understands `centre` + `view` + `date`.
 */
describe("eventDayHref", () => {
  it("opens the Events board on that centre and day", () => {
    expect(eventDayHref({ centre: "HPFM", eventDate: "2026-09-19" })).toBe(
      "/admin/crm/events?centre=HPFM&view=day&date=2026-09-19",
    );
    expect(eventDayHref({ centre: "FT", eventDate: "2026-12-31" })).toBe(
      "/admin/crm/events?centre=FT&view=day&date=2026-12-31",
    );
  });

  it("is null when the row cannot name a centre or a date", () => {
    // A legacy `center_code` that is not one of ours, or a mirrored project
    // with no schedule: the caller disables the control and says why rather
    // than sending a planner to an arbitrary day.
    expect(eventDayHref({ centre: null, eventDate: "2026-09-19" })).toBeNull();
    expect(eventDayHref({ centre: "HPN", eventDate: null })).toBeNull();
    expect(eventDayHref({ centre: "HPN", eventDate: "" })).toBeNull();
    expect(eventDayHref({ centre: "HPN", eventDate: "19/09/2026" })).toBeNull();
    // A timestamp is not a calendar day — the board would not match it.
    expect(eventDayHref({ centre: "HPN", eventDate: "2026-09-19T18:00:00Z" })).toBeNull();
  });
});
