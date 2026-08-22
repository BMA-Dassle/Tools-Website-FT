/**
 * WHO GETS COPIED on a booking confirmation — a source scan, not a unit test.
 *
 * This route is the highest-volume mailer we own: every race, every bowling
 * lane, every kiosk walk-up sends one. A name added to the BCC inside
 * `sendEmail` is therefore a name added to ALL of them, and it fails silently —
 * nothing errors, no guest notices, the only symptom is a staff inbox filling
 * with hundreds of confirmations a week. That is exactly what happened when
 * tyler@ was added here to watch VIP combo bookings: the address went into the
 * transport helper rather than the VIP call site, so he was copied on every
 * race booked instead of the handful of VIP ones.
 *
 * A unit test would not have caught it — the send is "correct" either way. So
 * the invariant is asserted against the source:
 *
 *   1. `sendEmail`'s SendGrid personalization names no individual mailbox — it
 *      composes AUDIT_BCC (a shared, auditable mailbox) with whatever the
 *      caller passed.
 *   2. Any personal watcher address in this file is reachable only through a
 *      booking-type gate, never as an unconditional constant in the send.
 *   3. Every sendEmail call site passes the gated list explicitly, so adding a
 *      third rail cannot silently inherit or silently drop the watcher.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = join(__dirname, "route.ts");
const src = readFileSync(ROUTE, "utf-8");

/** The `personalizations: [...]` object handed to SendGrid. */
function personalizationBlock(): string {
  const start = src.indexOf("personalizations:");
  expect(start, "route no longer builds a SendGrid personalizations block").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("from: {", start));
}

describe("booking-confirmation BCC scope", () => {
  it("puts no individual mailbox in the shared send path", () => {
    const block = personalizationBlock();
    // A first-name mailbox is a person; role addresses (noreply@, guestservices@,
    // vendorcases@) are shared and auditable, and are what belongs here.
    const literals = block.match(/["'][\w.+-]+@[\w.-]+["']/g) ?? [];
    expect(
      literals,
      "hardcode no address in sendEmail — pass it in via extraBcc from the call " +
        "site that knows what kind of booking this is",
    ).toEqual([]);
  });

  it("copies only the standing audit mailbox by default", () => {
    expect(personalizationBlock()).toContain("AUDIT_BCC");
    expect(src).toMatch(/const AUDIT_BCC = "vendorcases@dassle\.us"/);
  });

  it("gates the VIP watcher on the booking actually being a VIP combo", () => {
    // The watcher may be named exactly once (its constant) and used exactly
    // once (inside the VIP conditional) — anything else means it leaked back
    // into an unconditional path.
    const named = src.match(/VIP_WATCH_BCC/g) ?? [];
    expect(named, "VIP_WATCH_BCC should be declared once and used once").toHaveLength(2);
    expect(src).toMatch(/isVipComboBooking\([^)]*\)\s*\?\s*\[VIP_WATCH_BCC\]\s*:\s*\[\]/);
  });

  it("passes the gated list from every send rail", () => {
    const calls = src.match(/await sendEmail\(/g) ?? [];
    expect(calls.length, "expected the kiosk rail and the web rail").toBeGreaterThanOrEqual(2);
    // Each call site ends with the gated list, so a new rail has to make a
    // deliberate choice rather than inheriting a default.
    const passes = src.match(/\bextraBcc,?\s*\)/g) ?? [];
    expect(passes.length).toBeGreaterThanOrEqual(calls.length);
  });
});
