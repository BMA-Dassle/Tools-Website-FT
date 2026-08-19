import { describe, it, expect, afterEach } from "vitest";
import { pageIsHidden, setDocumentNeverHidden } from "./use-visible-interval";

/**
 * WHO IS ALLOWED TO STOP POLLING.
 *
 * `document.hidden` is the right signal on a page a person is looking at — a
 * ticket in a background tab has no business polling Pandora. It is the WRONG
 * signal on a TV player: Edge reports a fullscreen wall panel as hidden
 * whenever Windows decides its window is occluded, and the panel goes on
 * hanging in front of guests showing whatever it last painted while every poll
 * on the page — including the heartbeat that tells admin the screen is alive —
 * quietly stops.
 *
 * Observed 2026-08-19: HPFM:2/4/5 had written no heartbeat inside its
 * 15-minute TTL, and HPFM:3/HPFM:6 had written exactly one each, a second
 * apart, then stopped. Owner: "they're online and working."
 *
 * The hook itself needs a DOM and a React renderer, neither of which this
 * suite has (a root-hoisted react 18 shadows apps/web's react 19 — see
 * scenes/checkin-feed.test.tsx). The decision is the part worth locking down,
 * so it lives in its own function and is asserted here directly.
 */
const withDocument = (hidden: boolean | undefined) => {
  const g = globalThis as { document?: unknown };
  if (hidden === undefined) delete g.document;
  else g.document = { hidden };
};

afterEach(() => {
  setDocumentNeverHidden(false);
  withDocument(undefined);
});

describe("pageIsHidden", () => {
  it("reports a hidden tab as hidden, so an ordinary page still pauses", () => {
    withDocument(true);
    expect(pageIsHidden()).toBe(true);
  });

  it("reports a visible tab as visible", () => {
    withDocument(false);
    expect(pageIsHidden()).toBe(false);
  });

  it("NEVER reports hidden once the document has been marked — the TV case", () => {
    // The wall panel Edge called occluded. It is on a wall, being read.
    withDocument(true);
    setDocumentNeverHidden(true);
    expect(pageIsHidden()).toBe(false);
  });

  it("goes back to trusting the browser when the mark is cleared", () => {
    // The mark is page-wide and set at module scope by the TV app; nothing else
    // in the app sets it, and clearing it must restore the pausing behaviour
    // every other long-lived page depends on.
    withDocument(true);
    setDocumentNeverHidden(true);
    setDocumentNeverHidden(false);
    expect(pageIsHidden()).toBe(true);
  });

  it("survives having no document at all, which is SSR and this suite", () => {
    withDocument(undefined);
    expect(pageIsHidden()).toBe(false);
  });
});
