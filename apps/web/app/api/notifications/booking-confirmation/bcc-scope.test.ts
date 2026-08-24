/**
 * WHO GETS COPIED on a booking confirmation — a source scan, not a unit test.
 *
 * This route is the highest-volume mailer we own: every race, every bowling
 * lane, every kiosk walk-up sends one. A name added to the BCC inside
 * `sendEmail` is therefore a name added to ALL of them, and it fails silently —
 * nothing errors, no guest notices, the only symptom is a staff inbox filling
 * with hundreds of confirmations a week. That is exactly what happened when
 * tyler@ was added here to watch VIP combo bookings: the address went into the
 * transport helper rather than a VIP-specific alert, so he was copied on every
 * race booked instead of the handful of VIP ones.
 *
 * The rule that came out of it: a guest's confirmation copies ONE shared,
 * auditable mailbox and nobody else. Staff who need to watch a booking type get
 * a purpose-built alert (world-cup/notify.server.ts, combos/combo-notify.ts)
 * addressed to them — never a carbon of the guest's own mail.
 *
 * A unit test cannot catch a violation, because the send is "correct" either
 * way. So the invariants are asserted against the source:
 *
 *   1. `sendEmail`'s SendGrid personalization names no mailbox at all — it
 *      references AUDIT_BCC, the one shared address.
 *   2. AUDIT_BCC is that shared mailbox, and the route carries no second
 *      recipient constant smuggled in beside it.
 *   3. No individual's address appears anywhere in the route.
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
  it("hardcodes no address in the shared send path", () => {
    const literals = personalizationBlock().match(/["'][\w.+-]+@[\w.-]+["']/g) ?? [];
    expect(
      literals,
      "no address literal belongs in sendEmail — the audit mailbox is the only " +
        "standing copy, and it is named once as AUDIT_BCC",
    ).toEqual([]);
  });

  it("copies the shared audit mailbox and nothing else", () => {
    expect(personalizationBlock()).toContain("AUDIT_BCC");
    expect(src).toMatch(/const AUDIT_BCC = "vendorcases@dassle\.us"/);
    // One recipient constant in the whole route. A second one is how a person
    // gets back onto every confirmation we send.
    const recipientConsts = src.match(/^const [A-Z_]*(BCC|CC|RECIPIENTS?)\b/gm) ?? [];
    expect(recipientConsts).toEqual(["const AUDIT_BCC"]);
  });

  it("names no individual anywhere in the route", () => {
    // Shared/role mailboxes are fine (noreply@, vendorcases@, guestservices@);
    // a person's mailbox is not, however it is gated. Staff alerts live in their
    // own feature modules, addressed to staff — not bolted onto guest mail.
    const ROLE_MAILBOXES = /^(noreply|no-reply|vendorcases|guestservices|unsubscribe|ops|support)@/;
    const people = (src.match(/["'][\w.+-]+@[\w.-]+\.\w+["']/g) ?? [])
      .map((m) => m.slice(1, -1))
      .filter((addr) => !ROLE_MAILBOXES.test(addr));
    expect(people, "route addresses an individual — send them a staff alert instead").toEqual([]);
  });
});
