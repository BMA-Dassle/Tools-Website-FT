import { describe, expect, it } from "vitest";
import { PORTAL_SEPARATOR } from "~/features/daily-events/constants";
import {
  PORTAL_SECTION_MARKER,
  WEB_SECTION_END,
  WEB_SECTION_START,
  cutWebSection,
  foodOutFromMemo,
  parsePrivateMemo,
  sectionsCoverMemo,
} from "./sections";

/**
 * The private-memo parser. Three writers share one BMI field and the CRM
 * displays all three — so the fixtures here are the three shapes a real memo
 * takes: BOTH markers, NEITHER, and the NESTED case `syncBmiNotes` creates
 * when the website's block lands AFTER the Portal Staff separator
 * (`daily-events/service.ts:1384-1394` goes out of its way to preserve it).
 *
 * Losing a staff note would be silent and unrecoverable, so every case also
 * asserts the sections cover the whole memo.
 */

const STAFF = "Host wants the cake table by the mezzanine.\nCall the mum before 3 PM.";
const WEB_BODY =
  "Contract: https://headpinz.com/contract/7Hx2Qk\n" +
  "[Sep 10, 2026 9:06 AM] Contract sent to guest@example.com";
const WEB_BLOCK = `${WEB_SECTION_START}\n${WEB_BODY}\n${WEB_SECTION_END}`;
const PORTAL_BODY = "Food Out: 4:45 PM";

/** The nested shape: staff text, the portal separator, then the web block. */
const NESTED = `${STAFF}\n\n${PORTAL_SECTION_MARKER}\n${PORTAL_BODY}\n\n${WEB_BLOCK}`;
/** Both markers, the web block BEFORE the separator. */
const BOTH = `${STAFF}\n\n${WEB_BLOCK}\n\n${PORTAL_SECTION_MARKER}\n${PORTAL_BODY}`;

describe("the markers are the ones the writers actually use", () => {
  it("matches lib/bmi-office-actions.ts and daily-events/constants.ts", () => {
    expect(WEB_SECTION_START).toBe("── FastTrax Web ──");
    expect(WEB_SECTION_END).toBe("── End FastTrax Web ──");
    // PORTAL_SEPARATOR is "\n\n----- Portal Staff -----\n" — our marker is its
    // body, so a memo written by `syncBmiNotes` is recognised character for
    // character rather than by a lookalike we typed from memory.
    expect(PORTAL_SEPARATOR.trim()).toBe(PORTAL_SECTION_MARKER);
  });
});

describe("parsePrivateMemo — both markers", () => {
  const sections = parsePrivateMemo(BOTH);

  it("returns staff, web and portal, in display order", () => {
    expect(sections.map((s) => s.key)).toEqual(["staff", "web", "portal"]);
    expect(sections[0].text).toBe(STAFF);
    expect(sections[1].text).toBe(WEB_BODY);
    expect(sections[2].text).toBe(PORTAL_BODY);
  });

  it("loses nothing", () => {
    expect(sectionsCoverMemo(BOTH, sections)).toBe(true);
  });
});

describe("parsePrivateMemo — neither marker", () => {
  it("is one staff section, and an empty memo is no sections at all", () => {
    const sections = parsePrivateMemo(STAFF);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: "staff", marker: null, text: STAFF });
    expect(sectionsCoverMemo(STAFF, sections)).toBe(true);

    expect(parsePrivateMemo("")).toEqual([]);
    expect(parsePrivateMemo("   \n ")).toEqual([]);
    expect(parsePrivateMemo(null)).toEqual([]);
    expect(parsePrivateMemo(undefined)).toEqual([]);
  });
});

describe("parsePrivateMemo — nested (web block after the Portal Staff separator)", () => {
  const sections = parsePrivateMemo(NESTED);

  it("keeps the portal section to its own line and does not swallow the web block", () => {
    expect(sections.map((s) => s.key)).toEqual(["staff", "web", "portal"]);
    expect(sections[2].text).toBe(PORTAL_BODY);
    expect(sections[2].text).not.toContain("FastTrax Web");
    expect(sections[1].text).toBe(WEB_BODY);
  });

  it("loses nothing", () => {
    expect(sectionsCoverMemo(NESTED, sections)).toBe(true);
  });
});

describe("cutWebSection", () => {
  it("a start with no end takes the rest of the memo rather than merging it into staff notes", () => {
    const truncated = `${STAFF}\n\n${WEB_SECTION_START}\n${WEB_BODY}`;
    const cut = cutWebSection(truncated);
    expect(cut?.text.trim()).toBe(WEB_BODY);
    expect(cut?.rest.trim()).toBe(STAFF);
    expect(parsePrivateMemo(truncated).map((s) => s.key)).toEqual(["staff", "web"]);
  });

  it("no start at all is null", () => {
    expect(cutWebSection(STAFF)).toBeNull();
  });
});

describe("foodOutFromMemo", () => {
  it("reads the Portal Staff line, in either shape", () => {
    expect(foodOutFromMemo(NESTED)).toBe("4:45 PM");
    expect(foodOutFromMemo(BOTH)).toBe("4:45 PM");
  });

  it("is null when the portal section says nobody is assigned, or is absent", () => {
    const none = `${STAFF}\n\n${PORTAL_SECTION_MARKER}\n(No staff assigned)`;
    expect(foodOutFromMemo(none)).toBeNull();
    expect(foodOutFromMemo(STAFF)).toBeNull();
    expect(foodOutFromMemo("")).toBeNull();
  });
});
