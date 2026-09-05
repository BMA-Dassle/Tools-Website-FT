/**
 * Structural contract for the guest race-history sheet.
 *
 * THE BUG THIS PINS (shipped 2026-09-05, caught on glass): the sheet was
 * rendered beside its button, inside the roster card. Every roster card is
 * `.k-glass`, which sets `backdrop-filter` — and a backdrop-filter ancestor
 * becomes the containing block for `position: fixed` descendants. So the
 * "full-screen" overlay painted INSIDE the member card, clipped to it, with
 * the card's own blur over the top.
 *
 * The fix is the shape staff mode already uses (StaffSheetHost): the button
 * lives on the card, the SHEET is hosted once by the provider, above the
 * cards. These assertions are on the SOURCE because that is where the mistake
 * is expressible — a `fixed inset-0` inside the per-card component is wrong
 * whatever it renders to in a jsdom tree with no real layout.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "GuestRaceHistory.tsx"), "utf8");

/** The body of a top-level `export function <name>(` / `function <name>(`. */
function functionBody(name: string): string {
  const start = new RegExp(`(?:export )?function ${name}\\(`).exec(src)?.index;
  expect(start, `${name} not found — was it renamed?`).toBeDefined();
  const rest = src.slice(start);
  // Everything up to the next top-level `function` declaration.
  const next = /\n(?:export )?function /.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe("guest race history keeps the sheet out of the roster card", () => {
  it("the per-card component renders NO fixed overlay", () => {
    const body = functionBody("GuestRaceHistoryActions");
    expect(
      body,
      "GuestRaceHistoryActions renders a `fixed` overlay. Every roster card is " +
        ".k-glass (backdrop-filter), which becomes the containing block for a " +
        "fixed child — the sheet would paint inside the card. Host it from " +
        "GuestRaceHistoryProvider instead.",
    ).not.toMatch(/\bfixed\b/);
  });

  it("the per-card component does not mount the sheet itself", () => {
    expect(functionBody("GuestRaceHistoryActions")).not.toContain("<GuestRaceHistorySheet");
  });

  it("the provider hosts the sheet", () => {
    const body = functionBody("GuestRaceHistoryProvider");
    expect(body).toContain("<GuestRaceHistorySheet");
  });

  it("the sheet itself is a full-canvas fixed overlay", () => {
    // The other half of the contract: hosted, and still full-screen.
    expect(functionBody("GuestRaceHistorySheet")).toContain("fixed inset-0");
  });

  it("the sheet portals to the canvas so the action bar cannot sit on top", () => {
    // `.k-flow-head`, `.k-flow-body` and `.k-z-actions` are all z-index:2
    // siblings, so an overlay rendered inside the body loses to the action bar
    // on DOM order whatever its own z-index — "Book something" stayed tappable
    // through the open sheet (owner, 2026-09-05).
    expect(
      functionBody("GuestRaceHistorySheet"),
      "the overlay must be wrapped in <KioskSheetPortal> to escape .k-flow-body",
    ).toContain("<KioskSheetPortal>");
  });

  it("does not label with k-eyebrow, which unlayered css re-sizes to 24px cyan", () => {
    // `.kiosk-canvas .k-eyebrow` (0,2,0) beats a single-class utility (0,1,0),
    // so `text-[17px] text-white/45` on it silently rendered 24px cyan and the
    // section labels shouted over their own data.
    const labels = /function (?:SectionLabel|Th|Stat)\b/.test(src);
    expect(labels, "label helpers not found — were they renamed?").toBe(true);
    for (const name of ["SectionLabel", "Th", "Stat"]) {
      expect(functionBody(name), `${name} must not use k-eyebrow`).not.toContain("k-eyebrow");
    }
  });
});
