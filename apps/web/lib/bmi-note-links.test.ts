/**
 * The sticky link header inside a project's `── FastTrax Web ──` private note.
 *
 * Staff read these links off the reservation in BMI: the contract, the signed PDF,
 * and (owner request 2026-07-30) the two waiver links — the ORGANIZER one, which
 * shows the roster and can remove a guest, and a SIGN-ONLY one to hand a guest.
 *
 * The whole risk in this file is loss. A private memo is read-modify-WRITE-ALL
 * (Pandora replaces the memo rather than appending), so anything the merge drops is
 * gone from BMI — including notes staff typed themselves. Every case below is a way
 * something disappears.
 */
import { describe, it, expect } from "vitest";
import { _mergePrivateMemo, type _SectionLinks } from "./bmi-office-actions";

const NONE: _SectionLinks = {
  contractUrl: null,
  pdfUrl: null,
  waiverOrganizerUrl: null,
  waiverSignUrl: null,
};

const CONTRACT = "https://headpinz.com/contract/AB12CD";
const PDF = "https://headpinz.com/contract/AB12CD/pdf";
const ORGANIZER = "https://headpinz.com/w/ORGcode1234567890";
const SIGN = "https://headpinz.com/w/SIGNcode123456789";

describe("BMI private-note link header", () => {
  it("writes all four links, labelled, above the log", () => {
    const memo = _mergePrivateMemo("", "[t1] Contract sent", {
      contractUrl: CONTRACT,
      pdfUrl: PDF,
      waiverOrganizerUrl: ORGANIZER,
      waiverSignUrl: SIGN,
    });
    expect(memo).toContain(`Contract: ${CONTRACT}`);
    expect(memo).toContain(`Signed PDF: ${PDF}`);
    expect(memo).toContain(`Waiver Organizer: ${ORGANIZER}`);
    expect(memo).toContain(`Waiver Sign Only: ${SIGN}`);
    expect(memo).toContain("[t1] Contract sent");
    // Links above the divider, log below it.
    expect(memo.indexOf("Waiver Sign Only:")).toBeLessThan(memo.indexOf("[t1] Contract sent"));
  });

  it("keeps waiver links when a LATER append knows only the contract", () => {
    // THE case this file exists for. The balance-charge and reminder crons append
    // notes and pass no waiver links; if that blanked them, the desk would lose the
    // links the moment any other cron touched the reservation.
    const first = _mergePrivateMemo("", "[t1] Contract sent", {
      ...NONE,
      contractUrl: CONTRACT,
      waiverOrganizerUrl: ORGANIZER,
      waiverSignUrl: SIGN,
    });
    const second = _mergePrivateMemo(first, "[t2] Balance charged", NONE);
    expect(second).toContain(`Waiver Organizer: ${ORGANIZER}`);
    expect(second).toContain(`Waiver Sign Only: ${SIGN}`);
    expect(second).toContain(`Contract: ${CONTRACT}`);
    expect(second).toContain("[t1] Contract sent");
    expect(second).toContain("[t2] Balance charged");
  });

  it("lets a later append FILL IN links the first one lacked", () => {
    // Contract sent for a bowling-only party (no waiver links), then activities
    // change and the signed-contract append supplies them.
    const first = _mergePrivateMemo("", "[t1] Contract sent", {
      ...NONE,
      contractUrl: CONTRACT,
    });
    expect(first).not.toContain("Waiver Organizer:");
    const second = _mergePrivateMemo(first, "[t2] Contract signed", {
      ...NONE,
      pdfUrl: PDF,
      waiverOrganizerUrl: ORGANIZER,
      waiverSignUrl: SIGN,
    });
    expect(second).toContain(`Waiver Organizer: ${ORGANIZER}`);
    expect(second).toContain(`Signed PDF: ${PDF}`);
    // …without losing the contract URL only the FIRST append knew.
    expect(second).toContain(`Contract: ${CONTRACT}`);
  });

  it("never swaps the organizer link into the sign-only slot", () => {
    // If these two ever crossed, staff would hand a guest the link that can delete
    // other guests from the booking.
    const memo = _mergePrivateMemo("", "[t1] x", {
      ...NONE,
      waiverOrganizerUrl: ORGANIZER,
      waiverSignUrl: SIGN,
    });
    const organizerLine = /^Waiver Organizer:\s*(.+)$/m.exec(memo)?.[1];
    const signLine = /^Waiver Sign Only:\s*(.+)$/m.exec(memo)?.[1];
    expect(organizerLine).toBe(ORGANIZER);
    expect(signLine).toBe(SIGN);
    expect(organizerLine).not.toBe(signLine);

    // And they survive a round trip in the same order.
    const again = _mergePrivateMemo(memo, "[t2] y", NONE);
    expect(/^Waiver Organizer:\s*(.+)$/m.exec(again)?.[1]).toBe(ORGANIZER);
    expect(/^Waiver Sign Only:\s*(.+)$/m.exec(again)?.[1]).toBe(SIGN);
  });

  it("preserves staff-typed text outside the section", () => {
    const staff = "Guest wants the cake at 5:30.\nAllergy: peanuts.";
    const memo = _mergePrivateMemo(staff, "[t1] Contract sent", {
      ...NONE,
      contractUrl: CONTRACT,
      waiverOrganizerUrl: ORGANIZER,
    });
    expect(memo).toContain("Allergy: peanuts.");
    const after = _mergePrivateMemo(memo, "[t2] Balance charged", NONE);
    expect(after).toContain("Allergy: peanuts.");
    expect(after).toContain(`Waiver Organizer: ${ORGANIZER}`);
  });

  it("suppresses an exact duplicate note without dropping links", () => {
    const first = _mergePrivateMemo("", "[t1] Contract sent", {
      ...NONE,
      waiverOrganizerUrl: ORGANIZER,
    });
    const retry = _mergePrivateMemo(first, "[t1] Contract sent", NONE);
    expect(retry).toBe(first);
    expect(retry).toContain(`Waiver Organizer: ${ORGANIZER}`);
  });

  it("does not let 'Signed PDF' be captured by a looser prefix", () => {
    // Labels share words ("Waiver …", "… PDF"). Parsing is line-anchored so a
    // partial match can't pull the wrong URL into a slot.
    const memo = _mergePrivateMemo("", "[t1] x", {
      contractUrl: CONTRACT,
      pdfUrl: PDF,
      waiverOrganizerUrl: ORGANIZER,
      waiverSignUrl: SIGN,
    });
    const round = _mergePrivateMemo(memo, "[t2] y", NONE);
    expect(/^Contract:\s*(.+)$/m.exec(round)?.[1]).toBe(CONTRACT);
    expect(/^Signed PDF:\s*(.+)$/m.exec(round)?.[1]).toBe(PDF);
  });

  it("emits no link header at all when there are no links", () => {
    const memo = _mergePrivateMemo("", "[t1] State changed", NONE);
    expect(memo).toContain("[t1] State changed");
    expect(memo).not.toContain("Contract:");
    expect(memo).not.toContain("Waiver");
  });
});
