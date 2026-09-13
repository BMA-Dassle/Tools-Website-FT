import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";
import { Banner } from "./Banner";
import { Chip } from "./Chip";
import { DateBlock, dateParts } from "./DateBlock";
import { Folders } from "./Folders";
import { Kv } from "./Kv";
import { Meter, MeterRow, clampPct } from "./Meter";
import { Pill } from "./Pill";
import { RuleTrace, traceNote } from "./RuleTrace";
import { Seg } from "./Seg";
import { EmptyState, ErrorState, LoadingState } from "./States";
import { Table } from "./Table";
import { Tile } from "./Tile";
import { Timer, formatMinutes } from "./Timer";

/**
 * STRUCTURE-LEVEL TESTS (brief §3.10 / R12): every primitive is hook-free, so
 * it is called as a plain function and its element tree walked — the
 * `stage-rail-view.test.tsx:13-16` technique (node environment, no DOM, no
 * react-dom/server because of the react 18/19 split in this install layout).
 *
 * What is pinned is the prototype's contract: the class names crm.css styles,
 * the ARIA the shell and the Playwright proof rely on, and the pure helpers.
 */

type El = ReactElement<Record<string, unknown>>;

function isEl(n: unknown): n is El {
  return isValidElement(n);
}

function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) {
    for (const c of node) yield* walk(c as ReactNode);
    return;
  }
  if (isEl(node)) {
    yield node;
    yield* walk(node.props.children as ReactNode);
  }
}

function all(node: ReactNode, pred: (el: El) => boolean): El[] {
  return [...walk(node)].filter(pred);
}

function one(node: ReactNode, pred: (el: El) => boolean): El {
  const found = all(node, pred);
  if (found.length !== 1) throw new Error(`expected exactly one match, got ${found.length}`);
  return found[0];
}

const classes = (el: El) =>
  String(el.props.className ?? "")
    .split(/\s+/)
    .filter(Boolean);
const hasClass = (name: string) => (el: El) => classes(el).includes(name);
const tag = (t: string) => (el: El) => el.type === t;

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => text(n as ReactNode)).join("");
  if (isEl(node)) return text(node.props.children as ReactNode);
  return "";
}

/** Every <button> in a tree is type="button" and has a name (text or aria-label). */
function expectButtonsAccessible(node: ReactNode) {
  for (const b of all(node, tag("button"))) {
    expect(b.props.type, "button type").toBe("button");
    const name = text(b.props.children as ReactNode).trim() || String(b.props["aria-label"] ?? "");
    expect(name.length, "button has a name").toBeGreaterThan(0);
  }
}

describe("Chip", () => {
  it("renders .chip with the kind and status hooks crm.css styles", () => {
    const el = Chip({ kind: "open", st: "quote", children: "Quote sent" });
    expect(el.type).toBe("span");
    expect(classes(el)).toEqual(["chip"]);
    expect(el.props["data-kind"]).toBe("open");
    expect(el.props["data-st"]).toBe("quote");
    expect(text(el)).toBe("Quote sent");
  });
  it("the BMI variant is outlined (.chip-bmi) and carries its tooltip", () => {
    const el = Chip({ bmi: true, title: "BMI Office state", children: "BMI · New Lead" });
    expect(classes(el)).toEqual(["chip", "chip-bmi"]);
    expect(el.props.title).toBe("BMI Office state");
  });
});

describe("Pill", () => {
  it("centreTag: .pill.c-<code>", () => {
    expect(classes(Pill({ centre: "HPFM", children: "HP Fort Myers" }))).toEqual([
      "pill",
      "c-HPFM",
    ]);
    expect(classes(Pill({ children: "Web form" }))).toEqual(["pill"]);
  });
});

describe("Meter", () => {
  it("clamps and rounds the percentage", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(140)).toBe(100);
    expect(clampPct(33.4)).toBe(33);
    expect(clampPct(Number.NaN)).toBe(0);
  });
  it("draws .meter > i at width% and is a progressbar only when named", () => {
    const bare = Meter({ pct: 42 });
    expect(classes(bare)).toEqual(["meter"]);
    expect(bare.props.role).toBeUndefined();
    expect(one(bare, tag("i")).props.style).toEqual({ width: "42%" });
    const named = Meter({ pct: 250, tone: "warn", label: "Calls" });
    expect(classes(named)).toEqual(["meter", "warn"]);
    expect(named.props.role).toBe("progressbar");
    expect(named.props["aria-valuenow"]).toBe(100);
  });
  it("MeterRow lays out name · meter · n", () => {
    const el = MeterRow({ name: "Calls", n: "12 / 40", pct: 30 });
    expect(classes(el)).toEqual(["meter-row"]);
    expect(text(el)).toContain("Calls");
    expect(text(el)).toContain("12 / 40");
    expect(all(el, (e) => e.type === Meter)).toHaveLength(1);
  });
});

describe("Tile", () => {
  it("label, value, unit and sub in the prototype's spans; no .tico without an icon", () => {
    const el = Tile({ label: "Booked", value: "$41,200", unit: "MTD", sub: "vs LY" });
    expect(classes(el)).toEqual(["tile"]);
    expect(text(one(el, hasClass("label")))).toBe("Booked");
    expect(text(one(el, hasClass("value")))).toBe("$41,200MTD");
    expect(one(el, tag("small")).props.children).toBe("MTD");
    expect(all(el, hasClass("tico"))).toHaveLength(0);
    expect(text(one(el, hasClass("xs")))).toBe("vs LY");
  });
  it("an icon gets the .tico square with its hue, and a meter passes through", () => {
    const el = Tile({
      label: "x",
      value: 1,
      ico: "I",
      icoCls: "warn",
      meter: { p: 53, tone: "warn" },
    });
    expect(classes(one(el, hasClass("tico")))).toEqual(["tico", "warn"]);
    const m = one(el, (e) => e.type === Meter);
    expect(m.props.pct).toBe(53);
    expect(m.props.tone).toBe("warn");
  });
});

describe("Avatar", () => {
  it("initials tinted per rep slug; small variant", () => {
    const el = Avatar({ initials: "KK", repSlug: "kelsea", name: "Kelsea Kosco", sm: true });
    expect(classes(el)).toEqual(["avatar", "sm", "rep-kelsea"]);
    expect(el.props.title).toBe("Kelsea Kosco");
    expect(text(el)).toBe("KK");
  });
  it("no rep → '?' titled Unassigned (crm-shared.js:205)", () => {
    const el = Avatar({});
    expect(text(el)).toBe("?");
    expect(el.props.title).toBe("Unassigned");
  });
});

describe("DateBlock", () => {
  it("dateParts reads YYYY-MM-DD without an instant", () => {
    expect(dateParts("2026-10-17")).toEqual({ month: "Oct", day: 17, weekday: "Sat" });
    expect(dateParts("2026-09-12")).toEqual({ month: "Sep", day: 12, weekday: "Sat" });
    expect(dateParts("nope")).toBeNull();
    expect(dateParts("2026-13-01")).toBeNull();
  });
  it("m / d / w spans, 'soon' inside 14 days, tooltip from daysOut", () => {
    const soon = DateBlock({ date: "2026-10-17", daysOut: 10 });
    expect(classes(soon)).toEqual(["dblock", "soon"]);
    expect(soon.props.title).toBe("10 days out");
    expect(text(one(soon, hasClass("m")))).toBe("Oct");
    expect(text(one(soon, hasClass("d")))).toBe("17");
    expect(text(one(soon, hasClass("w")))).toBe("Sat");
    expect(classes(DateBlock({ date: "2026-10-17", daysOut: 20, lg: true }))).toEqual([
      "dblock",
      "lg",
    ]);
    expect(DateBlock({ date: "2026-10-17" }).props.title).toBeUndefined();
    expect(text(one(DateBlock({ date: "bad" }), hasClass("m")))).toBe("—");
  });
});

describe("Timer", () => {
  it("formatMinutes matches the prototype's dur()", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(185)).toBe("3 h 05 m");
    expect(formatMinutes(1500)).toBe("1 d 1 h");
    expect(formatMinutes(-3)).toBe("0 min");
  });
  it(".timer with its urgency tone and optional icon", () => {
    const el = Timer({ tone: "crit", icon: "C", children: "Overdue 2 h 10 m" });
    expect(classes(el)).toEqual(["timer", "crit"]);
    expect(text(el)).toBe("COverdue 2 h 10 m");
  });
});

describe("Kv", () => {
  it("one dt/dd pair per row inside dl.kv", () => {
    const el = Kv({
      rows: [
        { label: "Name", value: "Marcus" },
        { label: "Phone", value: "(239) 555-2710" },
      ],
    });
    expect(el.type).toBe("dl");
    expect(classes(el)).toEqual(["kv"]);
    expect(all(el, tag("dt"))).toHaveLength(2);
    expect(all(el, tag("dd"))).toHaveLength(2);
  });
});

describe("Table", () => {
  it("scrolls in its own .scroll-x, column headers have scope, numeric columns are .num", () => {
    const el = Table({
      columns: [
        { key: "a", label: "Event" },
        { key: "b", label: "Total", num: true },
      ],
      children: null,
      testId: "t",
    });
    expect(classes(el)).toEqual(["scroll-x"]);
    const table = one(el, tag("table"));
    expect(classes(table)).toEqual(["tbl"]);
    expect(table.props["data-testid"]).toBe("t");
    const ths = all(el, tag("th"));
    expect(ths).toHaveLength(2);
    expect(ths.every((th) => th.props.scope === "col")).toBe(true);
    expect(ths[0].props.className).toBeUndefined();
    expect(ths[1].props.className).toBe("num");
  });
});

describe("Banner", () => {
  it("tone class, text in .bt, alert role for crit and status otherwise", () => {
    const crit = Banner({ tone: "crit", children: "Paused" });
    expect(classes(crit)).toEqual(["banner", "crit"]);
    expect(crit.props.role).toBe("alert");
    expect(text(one(crit, hasClass("bt")))).toBe("Paused");
    expect(Banner({ tone: "info", children: "x" }).props.role).toBe("status");
    expect(Banner({ tone: "info", role: "none", children: "x" }).props.role).toBeUndefined();
  });
});

describe("Seg and Folders", () => {
  const options = [
    { value: "HPFM", label: "HP Fort Myers" },
    { value: "FT", label: "FastTrax", badge: 3 },
    { value: "HPN", label: "HP Naples", disabled: true },
  ] as const;

  it("Seg: role=group with a name, aria-pressed on the active option only, typed buttons, badge", () => {
    const onChange = vi.fn();
    const el = Seg({ options, value: "FT", onChange, label: "Centre" });
    expect(classes(el)).toEqual(["seg"]);
    expect(el.props.role).toBe("group");
    expect(el.props["aria-label"]).toBe("Centre");
    const buttons = all(el, tag("button"));
    expect(buttons.map((b) => b.props["aria-pressed"])).toEqual([false, true, false]);
    expect(buttons[2].props.disabled).toBe(true);
    expect(text(one(el, hasClass("badge")))).toBe("3");
    expectButtonsAccessible(el);
    (buttons[0].props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith("HPFM");
  });

  it("Folders: the same contract in the .folders skin", () => {
    const el = Folders({ options, value: "HPFM", onChange: () => {}, label: "Filter" });
    expect(classes(el)).toEqual(["folders"]);
    expect(all(el, tag("button")).map((b) => b.props["aria-pressed"])).toEqual([
      true,
      false,
      false,
    ]);
    expectButtonsAccessible(el);
  });
});

describe("RuleTrace", () => {
  const steps = [
    { ruleId: "R1", label: "Big groups go to Marketing", hit: false },
    {
      ruleId: "R4",
      label: "Skip anyone marked off today",
      hit: true,
      note: "skipped Lori (off today)",
    },
    { ruleId: "R6", label: "Lowest volume for the party's month", hit: true },
  ];
  it("traceNote falls back to matched / did not apply", () => {
    expect(traceNote(steps[0])).toBe("did not apply");
    expect(traceNote(steps[1])).toBe("skipped Lori (off today)");
    expect(traceNote(steps[2])).toBe("matched");
  });
  it("one .tr-row per step; hits are .hit; the deciding rule is .final", () => {
    const el = RuleTrace({ steps, finalRuleId: "R6", heading: "Why Kelsea" });
    expect(classes(el)).toEqual(["rule-trace"]);
    const rows = all(el, hasClass("tr-row"));
    expect(rows.map(classes)).toEqual([["tr-row"], ["tr-row", "hit"], ["tr-row", "hit", "final"]]);
    expect(all(el, hasClass("tr-id")).map((e) => text(e))).toEqual(["R1", "R4", "R6"]);
    expect(text(one(el, hasClass("eyebrow")))).toBe("Why Kelsea");
  });
});

describe("query states", () => {
  it("LoadingState announces itself and is busy", () => {
    const el = LoadingState({});
    expect(classes(el)).toEqual(["empty"]);
    expect(el.props["aria-busy"]).toBe("true");
    expect(el.props.role).toBe("status");
    expect(text(el)).toContain("Loading…");
  });
  it("EmptyState is the prototype's .empty", () => {
    expect(classes(EmptyState({ children: "Nothing here" }))).toEqual(["empty"]);
  });
  it("ErrorState is a crit Banner with a typed Retry button wired to onRetry", () => {
    const onRetry = vi.fn();
    const el = ErrorState({ message: "Office unavailable", onRetry });
    expect(el.type).toBe(Banner);
    expect(el.props.tone).toBe("crit");
    const btn = one(el.props.actions as ReactNode, tag("button"));
    expect(btn.props.type).toBe("button");
    (btn.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(ErrorState({ message: "x" }).props.actions).toBeUndefined();
  });
});
