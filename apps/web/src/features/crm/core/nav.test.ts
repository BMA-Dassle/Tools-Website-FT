import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUP_ID, DIRECTOR_ONLY_SCREENS } from "./contracts";
import {
  MORE_ITEMS,
  NAV_GROUPS,
  PHONE_TABS,
  SCREEN_META,
  allNavIds,
  canViewScreen,
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

  it("ready: true only for the screens whose PR has landed on this branch", () => {
    // PR1: statuses · B2: rules. A feature PR adds its own id here when it flips its line.
    const READY = new Set(["statuses", "rules"]);
    for (const i of [...NAV_GROUPS.flatMap((g) => g.items), ...PHONE_TABS, ...MORE_ITEMS]) {
      expect(i.ready, i.id).toBe(READY.has(i.id));
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
