import { describe, expect, it } from "vitest";
import type { RepAccountability, WeeklyActual, WeeklyTarget } from "~/features/crm/kpi/contracts";
import {
  CHANNELS,
  behindSentence,
  cellTone,
  channelRows,
  meterTone,
  pctOf,
  responseLabel,
  responseMissed,
  teamTotal,
} from "./model";

const TARGET: WeeklyTarget = {
  calls: 40,
  texts: 30,
  emails: 25,
  reachouts: 15,
  responseTargetMinutes: 60,
  effectiveFrom: "2026-09-07",
};

const ACTUAL: WeeklyActual = {
  calls: 18,
  texts: 30,
  emails: 24,
  reachouts: 4,
  leadsTouched: 11,
  medianResponseMinutes: 71,
  trend: [30, 28, 22, 18],
};

function rep(over: Partial<RepAccountability> = {}): RepAccountability {
  return {
    repId: "1",
    slug: "lori",
    firstName: "Lori",
    displayName: "Lori Lehman",
    initials: "LL",
    target: TARGET,
    actual: ACTUAL,
    ...over,
  };
}

describe("meterTone", () => {
  it("is green only at or above target", () => {
    expect(meterTone(100)).toBe("good");
    expect(meterTone(140)).toBe("good");
    // A bar that turns green at three-quarters teaches the rep that
    // three-quarters is the target.
    expect(meterTone(99)).toBe("");
    expect(meterTone(70)).toBe("");
  });

  it("warns below 70 and goes critical below 40", () => {
    expect(meterTone(69)).toBe("warn");
    expect(meterTone(40)).toBe("warn");
    expect(meterTone(39)).toBe("crit");
    expect(meterTone(0)).toBe("crit");
  });
});

describe("channelRows", () => {
  it("builds one row per meter, in the prototype's order", () => {
    const rows = channelRows(TARGET, ACTUAL);
    expect(rows.map((r) => r.key)).toEqual(["calls", "texts", "emails", "reachouts"]);
    expect(rows.map((r) => r.label)).toEqual(CHANNELS.map((c) => c.label));
  });

  it("carries the pair and the tone the bar needs", () => {
    const rows = channelRows(TARGET, ACTUAL);
    expect(rows[0]).toMatchObject({ actual: 18, target: 40, pct: 45, tone: "warn" });
    expect(rows[1]).toMatchObject({ pct: 100, tone: "good" });
    expect(rows[3]).toMatchObject({ pct: 27, tone: "crit" });
  });

  it("is 0% rather than NaN against a target of zero", () => {
    const rows = channelRows({ ...TARGET, calls: 0 }, ACTUAL);
    expect(rows[0].pct).toBe(0);
    expect(pctOf(3, 0)).toBe(0);
  });
});

describe("response time", () => {
  it("reads in minutes then hours", () => {
    expect(responseLabel(38)).toBe("38 min");
    expect(responseLabel(71)).toBe("1 h 11 m");
    expect(responseLabel(120)).toBe("2 h");
  });

  it("is a dash, not a zero, when nobody has been answered", () => {
    // Zero would read as "we answer instantly".
    expect(responseLabel(null)).toBe("—");
  });

  it("is missed only when it is actually over the target", () => {
    expect(responseMissed(71, 60)).toBe(true);
    expect(responseMissed(60, 60)).toBe(false);
    expect(responseMissed(null, 60)).toBe(false);
  });
});

describe("behindSentence", () => {
  it("reads like the prototype's banner", () => {
    expect(
      behindSentence(
        {
          displayName: "Lori Lehman",
          callsPct: 45,
          reachoutsPct: 27,
          medianResponseMinutes: 71,
          responseTargetMinutes: 60,
        },
        1,
      ),
    ).toBe(
      "Lori Lehman is at 45% of calls and 27% of last-year reach-outs with 1 day left. Median response 1 h 11 m (target 60 min).",
    );
  });

  it("drops the median clause when the rep is INSIDE their response target", () => {
    // Naming a number somebody is hitting, in a banner about falling behind,
    // reads as a criticism of the one thing they got right.
    const s = behindSentence(
      {
        displayName: "Lori",
        callsPct: 45,
        reachoutsPct: 27,
        medianResponseMinutes: 30,
        responseTargetMinutes: 60,
      },
      2,
    );
    expect(s).not.toContain("Median response");
    expect(s).toContain("with 2 days left");
  });

  it("says the week is over rather than 'with 0 days left'", () => {
    const s = behindSentence(
      {
        displayName: "Lori",
        callsPct: 45,
        reachoutsPct: 27,
        medianResponseMinutes: null,
        responseTargetMinutes: 60,
      },
      0,
    );
    expect(s).toContain("and the week is over");
  });
});

describe("teamTotal", () => {
  it("sums the actual and the target together, so the pair stays comparable", () => {
    const reps = [rep(), rep({ slug: "kelsea", actual: { ...ACTUAL, calls: 38 } })];
    expect(teamTotal(reps, "calls")).toEqual({ actual: 56, target: 80 });
  });

  it("is zero for an empty roster, not NaN", () => {
    expect(teamTotal([], "calls")).toEqual({ actual: 0, target: 0 });
  });
});

describe("cellTone", () => {
  it("marks the two ends and leaves the middle alone", () => {
    expect(cellTone(40, 40)).toBe("good");
    expect(cellTone(41, 40)).toBe("good");
    expect(cellTone(25, 40)).toBe("");
    expect(cellTone(19, 40)).toBe("crit");
  });

  it("is neutral when no target was set — there is nothing to be under", () => {
    expect(cellTone(0, 0)).toBe("");
  });
});
