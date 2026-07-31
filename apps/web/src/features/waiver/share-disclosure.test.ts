/**
 * Contract test for the ShareBlock privacy disclosure.
 *
 * The /waiver link is built to be forwarded to a whole party, so the sheet that
 * forwards it tells the guest what the recipient will see. That sentence is a
 * PROMISE, and on 2026-07-30 it went stale the moment the roster preload landed:
 * it still read "it only shows the event, never your booking details" while an
 * ONLINE booking's payload had started shipping the party's redacted names. A
 * privacy claim the payload contradicts is worse than making no claim at all.
 *
 * There is no RTL harness for WaiverFlow, and TypeScript can only prove the prop
 * is passed — not that the sentence is still true. So the structure is asserted
 * from source, in the same style as waiver-party.theme.test.ts: the disclosure
 * must be CONDITIONAL, and its condition must be the same field the preload
 * itself gates on (`ctx.roster`). When one of these goes red, re-read the copy
 * against what /api/waiver/context actually returns — don't relax the assertion.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "WaiverFlow.tsx"), "utf8");

/**
 * The body of a top-level `function <name>(` declaration, to its closing brace.
 *
 * Terminates on `\n}` followed by a NEWLINE — a closing brace alone on its line.
 * Plain `indexOf("\n}")` also matched the `\n}: {` inside a multi-line destructured
 * parameter list, which silently truncated the extraction to the signature and made
 * every assertion below fail as "the copy was reworded" when the copy was untouched.
 * A helper that can quietly return a fragment turns a contract test into a liar.
 */
function functionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in WaiverFlow.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  // A signature-only slice is never a real function body — fail loudly rather than
  // let a short extraction masquerade as missing copy.
  expect(
    body.length,
    `extracted only ${body.length} chars for ${name} — the extractor stopped early`,
  ).toBeGreaterThan(400);
  return body;
}

describe("ShareBlock privacy disclosure", () => {
  it("no longer claims the link shows only the event", () => {
    // The exact sentence that shipped false. Its absence is the whole point.
    expect(source).not.toContain("it only shows the event, never your booking details");
  });

  it("makes every claim about what the link shows conditional", () => {
    const shareBlock = functionSource("ShareBlock");
    expect(shareBlock).toContain("showsNames");
    const claims = shareBlock.match(/It shows the event[^"]*/g) ?? [];
    expect(
      claims.length,
      "found no 'It shows the event…' claim — the copy was reworded, so this test " +
        "is no longer checking anything. Re-point it at the new sentence.",
    ).toBeGreaterThan(0);
    // Each phrase that describes the payload has to sit on a branch. An
    // unconditional "It shows the event only" is the regression this catches.
    for (const claim of claims) {
      const at = shareBlock.indexOf(claim);
      const beforeClaim = shareBlock.slice(Math.max(0, at - 200), at);
      expect(beforeClaim, `unconditional payload claim: "${claim}"`).toMatch(
        /showsNames\s*\n?\s*\?/,
      );
    }
  });

  it("conditions the disclosure on the same field the preload gates on", () => {
    // `ctx.roster` is the discriminator: present ⇒ names are on the link (online
    // booking), absent ⇒ they are not (group function, or a sweep miss). If the
    // disclosure ever derives from something else — `signed`, the local party
    // length — it can claim less than the payload delivers.
    expect(source).toMatch(/const linkShowsNames\s*=\s*!!ctx\?\.roster/);
    expect(source).toMatch(/showsNames=\{linkShowsNames\}/);
  });

  it("still promises the things the payload really does withhold", () => {
    // /api/waiver/context drops pricing, deposit, payments and the confirmation.
    // That half of the sentence is true and load-bearing — it is why the link is
    // forwardable at all.
    expect(functionSource("ShareBlock")).toContain("never your confirmation number");
  });
});
