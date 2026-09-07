/**
 * Structural contract for Today's Crew across the TWO people components.
 *
 * KioskPeopleStep and KioskPartyManager are near-verbatim twins that must be
 * kept in lockstep, and the family pill proved they drift (different pill
 * metrics, one formats CRM names and one does not). These assertions are on
 * the SOURCE, like guest-race-history.structure.test.ts: they pin that both
 * screens run the SAME hook, draw pills through the SAME component, keep the
 * chip row on ONE line (owner 2026-09-06), and mark the family lookup pending
 * on every path — none of which a jsdom render with no layout can see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kiosk = path.resolve(here, "..");
const read = (rel: string) => readFileSync(path.join(kiosk, rel), "utf8");

const SCREENS = {
  KioskPeopleStep: read("steps/KioskPeopleStep.tsx"),
  KioskPartyManager: read("components/KioskPartyManager.tsx"),
};
const hook = read("todays-crew/useTodaysCrew.ts");
const pill = read("components/RosterPill.tsx");
const sheet = read("components/FamilyPickerSheet.tsx");
const route = readFileSync(
  path.resolve(here, "../../../../app/api/kiosk/todays-crew/route.ts"),
  "utf8",
);

/** The users glyph that used to be hand-rolled into each screen's family pill. */
const USERS_GLYPH = "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2";

describe.each(Object.entries(SCREENS))("%s", (_name, src) => {
  it("runs the shared Today's Crew hook", () => {
    expect(src).toContain("useTodaysCrew(");
  });

  it("fires the crew lookup wherever the family lookup fires", () => {
    // handleVerified and the setup-form attach branch both call importLinked;
    // each must call crew.load right beside it, or one sign-in path gets the
    // family pill and no crew pill.
    const linked = src.match(/void importLinked\(/g)?.length ?? 0;
    const crew = src.match(/void crew\.load\(/g)?.length ?? 0;
    expect(linked, "importLinked call sites").toBeGreaterThanOrEqual(2);
    expect(crew, "crew.load must be called at every importLinked call site").toBe(linked);
  });

  it("draws every pill through RosterPill — no hand-rolled pill left", () => {
    expect(src).toContain("<RosterPill");
    expect(src, "the users glyph belongs in RosterPill's FAMILY_ICON").not.toContain(USERS_GLYPH);
  });

  it("keeps the chip row on ONE line", () => {
    expect(src).toContain("flex flex-nowrap items-center gap-[12px]");
    expect(src, "a wrapping chip row stacks the pills (owner 2026-09-06)").not.toMatch(
      /mt-\[14px\] flex flex-wrap items-center gap-\[12px\]/,
    );
  });

  it("marks the family lookup pending on entry and done on EVERY exit", () => {
    const loading = src.match(
      /setLinkedStatus\(\(s\) => \(\{ \.\.\.s, \[memberId\]: "loading" \}\)\)/g,
    );
    const done = src.match(/setLinkedStatus\(\(s\) => \(\{ \.\.\.s, \[memberId\]: "done" \}\)\)/g);
    expect(loading?.length, "importLinked must flip the pill to pending first").toBe(1);
    expect(done?.length, "…and back to done in its finally").toBe(1);
    // The "done" write sits in a finally, so an early return or a thrown fetch
    // can never leave a spinner on the card.
    const idx = src.indexOf('[memberId]: "done"');
    expect(src.slice(Math.max(0, idx - 120), idx)).toContain("finally");
  });

  it("mounts the crew sheet as the shared FamilyPickerSheet, guarded like the family one", () => {
    expect(src).toContain("crew.open !== null && crew.crewFor(crew.open).length > 0");
    expect(src).toContain("checkWaiverSuffix:");
  });

  it("adds picks through ONE addBatch and verifies only the unknown waivers", () => {
    expect(src).toContain("const addBatch = (picks: PickPerson[])");
    expect(src).toContain("picks[i].waiverValid === null");
    expect(src).toContain("crew.take(taken)");
  });
});

describe("useTodaysCrew", () => {
  it("calls the route the API file serves", () => {
    expect(hook).toContain("/api/kiosk/todays-crew?personId=");
    expect(route).toContain("export async function GET");
  });
  it("reads its options through a ref at resolve time (no stale overlay/roster)", () => {
    expect(hook).toContain("optsRef.current = opts");
    expect(hook).toContain("optsRef.current.overlayOpen()");
    expect(hook).toContain("optsRef.current.rosterIds()");
  });
  it("offers the sheet once per member", () => {
    expect(hook).toContain("offeredRef.current.has(memberId)");
    expect(hook).toContain("offeredRef.current.add(memberId)");
  });
});

describe("RosterPill", () => {
  it("has a real pending state: disabled, aria-busy, spinner", () => {
    expect(pill).toContain("disabled={pending}");
    expect(pill).toContain("aria-busy={pending || undefined}");
    expect(pill).toContain("animate-spin");
  });
  it("never wraps its label", () => {
    expect(pill).toContain("whitespace-nowrap");
  });
});

describe("FamilyPickerSheet as the shared people picker", () => {
  it("understands an unchecked waiver and a per-person note", () => {
    expect(sheet).toContain("waiverValid: boolean | null");
    expect(sheet).toContain("note?: string");
    expect(sheet).toContain("copy.checkWaiverSuffix ?? copy.needsWaiverSuffix");
  });
});

describe("the route", () => {
  it("is read-only, id-validated and rate limited", () => {
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(route).toContain("ID_RE.test(personId)");
    expect(route).toContain('rateLimited("todays-crew"');
  });
});
