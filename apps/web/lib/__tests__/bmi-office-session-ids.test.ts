import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { officeReadSessionId } from "../bmi-office-ids";

/**
 * The rule this file exists to hold: A BMI OFFICE SESSION ID IS NEVER DERIVED
 * FROM A CLOCK.
 *
 * BMI Office keeps server-side state per `x-session-id`. A clock-derived id is a
 * new session on every call by construction, so a polling caller leaves one
 * behind per tick forever — `scan-${Date.now()}` on a 60-second cron was ~1,440
 * a day per tenant. On 2026-08-25 BMI Office reported that our traffic was
 * consuming their server connections, and named `sweep-headpinzftmyers`: the one
 * poller whose id was already stable, and therefore the only one they could
 * point at. The unstable pollers were the volume.
 *
 * `randomUUID()` is deliberately NOT banned here. On a write rail it is minted
 * once per operation and reused across that operation's GET → mutate → PUT,
 * which is what the Office UI does across a single edit — see `apiHeaders` in
 * lib/bmi-office-actions.ts. A clock has no such story: it is a worse UUID.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..", "..");
const SCAN_ROOTS = ["app", "lib", "src"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Every production line that sets an `x-session-id`, as `path:line → text`. */
function sessionIdLines(): Array<{ where: string; text: string; file: string }> {
  const found: Array<{ where: string; text: string; file: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(WEB_ROOT, root))) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        if (!text.includes('"x-session-id"')) return;
        // The header name also appears in prose comments about the rule itself.
        if (/^\s*(\*|\/\/)/.test(text)) return;
        const path = relative(WEB_ROOT, file).split("\\").join("/");
        found.push({ where: `${path}:${i + 1}`, text: text.trim(), file: path });
      });
    }
  }
  return found;
}

describe("officeReadSessionId", () => {
  it("is stable across calls, so a poller reuses one BMI session", () => {
    // The whole point. If this ever varies, every cron tick opens a new session
    // again and we are back to the 2026-08-25 report.
    const a = officeReadSessionId("scan", "headpinzftmyers");
    const b = officeReadSessionId("scan", "headpinzftmyers");
    expect(a).toBe(b);
    expect(a).toBe("scan-headpinzftmyers");
  });

  it("keys by tenant, so Naples reads are not attributed to the Fort Myers session", () => {
    expect(officeReadSessionId("scan", "headpinzftmyers")).not.toBe(
      officeReadSessionId("scan", "headpinznaples"),
    );
  });

  it("keys by caller, so BMI can attribute load to the poller that made it", () => {
    expect(officeReadSessionId("scan", "headpinzftmyers")).not.toBe(
      officeReadSessionId("sweep", "headpinzftmyers"),
    );
  });
});

describe("x-session-id across production Office callers", () => {
  it("finds the callers at all (guard against a silently empty scan)", () => {
    // A file-walk guard that matches nothing passes forever. Anchor it.
    expect(sessionIdLines().length).toBeGreaterThan(5);
  });

  it("never derives a session id from a clock", () => {
    const offenders = sessionIdLines().filter(
      ({ text }) => text.includes("Date.now()") || text.includes("new Date()"),
    );
    expect(
      offenders.map((o) => `${o.where}  ${o.text}`),
      "A clock-derived x-session-id opens a new BMI session per call — use officeReadSessionId(tag, clientKey) for reads, or mint one per write operation.",
    ).toEqual([]);
  });

  it("keeps every timer-driven poller on the stable helper", () => {
    // These run on a cron, so they are the callers that accumulate sessions.
    // Asserted on the session-id LINE, not on the file: an earlier version of
    // this test only checked that the identifier appeared somewhere in the file,
    // which still passed with `scan-${Date.now()}` restored one line below the
    // (now unused) import.
    const pollers = [
      "lib/bmi-scan.ts",
      "app/api/cron/bmi-cancel-sweep/route.ts",
      "app/api/cron/race-cancel-watch/route.ts",
      "app/api/cron/race-dayof-pay/route.ts",
    ];
    const offenders = sessionIdLines()
      .filter((l) => pollers.includes(l.file))
      .filter((l) => !l.text.includes("officeReadSessionId("));
    expect(
      offenders.map((o) => `${o.where}  ${o.text}`),
      "A cron poller must build its x-session-id with officeReadSessionId(tag, clientKey).",
    ).toEqual([]);

    // Every poller in the list must actually have been found, or a rename turns
    // this into a test of nothing.
    const covered = new Set(sessionIdLines().map((l) => l.file));
    for (const poller of pollers) expect(covered, `${poller} no longer sets one`).toContain(poller);
  });

  it("defaults the daily-events client to the stable read session", () => {
    // This one indirects through an `officeFetch({ sessionId })` option, so the
    // header line itself is a variable. The default is the thing under test —
    // its one write (officePut on projectLog) deliberately passes randomUUID().
    const src = readFileSync(
      join(WEB_ROOT, "src/features/daily-events/data/bmi-office.ts"),
      "utf8",
    );
    expect(src).toContain('officeReadSessionId("events", clientKey)');
    expect(src).toContain("sessionId: randomUUID()");
  });
});
