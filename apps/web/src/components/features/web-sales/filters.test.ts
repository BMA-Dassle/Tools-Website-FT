import { describe, expect, it } from "vitest";
import { shiftYmd } from "~/features/web-sales";
import {
  hasActiveFilters,
  matchPreset,
  parseFilters,
  presetRange,
  serializeFilters,
  toApiQuery,
  toggle,
  type BoardFilters,
} from "./filters";

const FALLBACK = { from: "2026-07-05", to: "2026-08-03" };
const TODAY = "2026-08-03";

const base = (patch: Partial<BoardFilters> = {}): BoardFilters => ({
  ...FALLBACK,
  sources: [],
  statuses: [],
  venues: [],
  q: "",
  problemsOnly: false,
  ...patch,
});

describe("presetRange", () => {
  it("resolves each preset against the reference day", () => {
    expect(presetRange("today", TODAY, shiftYmd)).toEqual({ from: TODAY, to: TODAY });
    expect(presetRange("yesterday", TODAY, shiftYmd)).toEqual({ from: "2026-08-02", to: "2026-08-02" });
    expect(presetRange("7d", TODAY, shiftYmd)).toEqual({ from: "2026-07-28", to: TODAY });
    expect(presetRange("30d", TODAY, shiftYmd)).toEqual({ from: "2026-07-05", to: TODAY });
    expect(presetRange("mtd", TODAY, shiftYmd)).toEqual({ from: "2026-08-01", to: TODAY });
  });

  it("keeps month-to-date inside the month on the first", () => {
    expect(presetRange("mtd", "2026-08-01", shiftYmd)).toEqual({ from: "2026-08-01", to: "2026-08-01" });
  });
});

describe("matchPreset", () => {
  it("lights up the chip matching the current range", () => {
    expect(matchPreset({ from: TODAY, to: TODAY }, TODAY, shiftYmd)).toBe("today");
    expect(matchPreset({ from: "2026-07-05", to: TODAY }, TODAY, shiftYmd)).toBe("30d");
  });

  it("lights up nothing for a hand-picked range", () => {
    expect(matchPreset({ from: "2026-07-11", to: "2026-07-19" }, TODAY, shiftYmd)).toBeNull();
  });
});

describe("parseFilters", () => {
  it("falls back to the default range when the URL says nothing", () => {
    expect(parseFilters(new URLSearchParams(""), FALLBACK)).toEqual(base());
  });

  it("reads every filter out of the query string", () => {
    const f = parseFilters(
      new URLSearchParams(
        "from=2026-08-01&to=2026-08-03&source=deals&status=sent,minted&venue=naples&q=jacob&problems=1",
      ),
      FALLBACK,
    );
    expect(f).toEqual({
      from: "2026-08-01",
      to: "2026-08-03",
      sources: ["deals"],
      statuses: ["sent", "minted"],
      venues: ["naples"],
      q: "jacob",
      problemsOnly: true,
    });
  });

  it("drops an unknown source instead of rejecting a stale link", () => {
    const f = parseFilters(new URLSearchParams("source=deals,ghost-source"), FALLBACK);
    expect(f.sources).toEqual(["deals"]);
  });

  it("trims the search term", () => {
    expect(parseFilters(new URLSearchParams("q=%20%20jacob%20%20"), FALLBACK).q).toBe("jacob");
  });

  it("treats anything but problems=1 as off", () => {
    expect(parseFilters(new URLSearchParams("problems=0"), FALLBACK).problemsOnly).toBe(false);
    expect(parseFilters(new URLSearchParams("problems=true"), FALLBACK).problemsOnly).toBe(false);
  });
});

describe("serializeFilters", () => {
  it("writes nothing for a board at rest", () => {
    expect(serializeFilters(base(), FALLBACK)).toBe("");
  });

  it("omits a range that equals the default", () => {
    expect(serializeFilters(base({ q: "jacob" }), FALLBACK)).toBe("q=jacob");
  });

  it("round-trips byte-identically", () => {
    // A filtered view must survive a reload exactly, or a pasted link shows
    // someone different rows than the person who sent it.
    const f = base({
      from: "2026-08-01",
      to: "2026-08-02",
      sources: ["deals"],
      statuses: ["charge_failed"],
      venues: ["headpinz", "naples"],
      q: "HPWK8EJPXCR",
      problemsOnly: true,
    });
    const once = serializeFilters(f, FALLBACK);
    const back = parseFilters(new URLSearchParams(once), FALLBACK);
    expect(back).toEqual(f);
    expect(serializeFilters(back, FALLBACK)).toBe(once);
  });

  it("is stable in key order so history entries do not churn", () => {
    const a = serializeFilters(base({ q: "x", sources: ["deals"], problemsOnly: true }), FALLBACK);
    const b = serializeFilters(base({ problemsOnly: true, sources: ["deals"], q: "x" }), FALLBACK);
    expect(a).toBe(b);
  });
});

describe("toApiQuery", () => {
  it("always sends the token and the resolved range", () => {
    const p = new URLSearchParams(toApiQuery(base(), "TKN"));
    expect(p.get("token")).toBe("TKN");
    expect(p.get("from")).toBe("2026-07-05");
    expect(p.get("to")).toBe("2026-08-03");
  });

  it("does NOT send problemsOnly", () => {
    // "Needs attention" is derived from the projected row, not from any source's
    // native status vocabulary. Pushing it server-side would make every adapter
    // reimplement the same judgement in SQL, and they would drift.
    const p = new URLSearchParams(toApiQuery(base({ problemsOnly: true }), "TKN"));
    expect(p.has("problems")).toBe(false);
  });

  it("carries extras like the cursor and the csv format", () => {
    const p = new URLSearchParams(toApiQuery(base(), "TKN", { cursor: "abc", format: "csv" }));
    expect(p.get("cursor")).toBe("abc");
    expect(p.get("format")).toBe("csv");
  });

  it("omits empty filter lists rather than sending blanks", () => {
    const p = new URLSearchParams(toApiQuery(base(), "TKN"));
    expect(p.has("source")).toBe(false);
    expect(p.has("status")).toBe(false);
    expect(p.has("venue")).toBe(false);
    expect(p.has("q")).toBe(false);
  });
});

describe("toggle", () => {
  it("adds and removes", () => {
    expect(toggle<string>([], "a")).toEqual(["a"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("hasActiveFilters", () => {
  it("ignores the date range", () => {
    expect(hasActiveFilters(base({ from: "2026-01-01" }))).toBe(false);
  });

  it("notices every other filter", () => {
    expect(hasActiveFilters(base({ q: "x" }))).toBe(true);
    expect(hasActiveFilters(base({ sources: ["deals"] }))).toBe(true);
    expect(hasActiveFilters(base({ statuses: ["sent"] }))).toBe(true);
    expect(hasActiveFilters(base({ venues: ["naples"] }))).toBe(true);
    expect(hasActiveFilters(base({ problemsOnly: true }))).toBe(true);
  });
});
