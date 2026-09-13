import { describe, expect, it } from "vitest";
import { makeLead } from "~/features/crm/leads/test-support";
import {
  QUICK_ACTIONS,
  QUICK_ACTION_IDS,
  quickActionsFor,
  type QuickActionTarget,
} from "./actions";

/**
 * The rail registry C1/C2/C3 flip one line of: the prototype's five buttons in
 * order (crm-shared.js:245). Call / Text / Email hand off to the device until
 * their channel PR lands; Note and Snooze open B4's own sheets.
 *
 * A slot is EITHER wired (a target) or disabled WITH A REASON — never a dead
 * button that silently does nothing. That is what the `disabledTitle`
 * assertions below protect as each channel is swapped in.
 */

/** A target as a comparable pair, whichever kind it is. */
function describeTarget(t: QuickActionTarget | null): [string, string] | null {
  if (!t) return null;
  return t.kind === "href" ? ["href", t.href] : ["sheet", t.sheet];
}

describe("quick-action slot registry", () => {
  it("is the prototype's five buttons, in order, each labelled and owned", () => {
    expect(QUICK_ACTION_IDS).toEqual(["call", "text", "email", "note", "snooze"]);
    expect(QUICK_ACTION_IDS.map((id) => QUICK_ACTIONS[id].label)).toEqual([
      "Call",
      "Text",
      "Email",
      "Note",
      "Snooze",
    ]);
    for (const id of QUICK_ACTION_IDS) {
      expect(QUICK_ACTIONS[id].id, id).toBe(id);
      expect(typeof QUICK_ACTIONS[id].Icon, id).toBe("object");
    }
    expect(QUICK_ACTIONS.call.owner).toBe("C3");
    expect(QUICK_ACTIONS.text.owner).toBe("C1");
    expect(QUICK_ACTIONS.email.owner).toBe("C2");
    expect(QUICK_ACTIONS.note.owner).toBe("B4");
    expect(QUICK_ACTIONS.snooze.owner).toBe("B4");
  });

  it("every slot that CAN be disabled says why", () => {
    // Note and Snooze always have a target (their own sheets), so they need no
    // reason; the three device hand-offs depend on the guest's contact details.
    for (const id of ["call", "text", "email"] as const) {
      expect(QUICK_ACTIONS[id].disabledTitle.length, id).toBeGreaterThan(5);
    }
  });

  it("a guest with a phone and an email gets tel: / sms: / mailto:; Note and Snooze open sheets", () => {
    const lead = makeLead({
      id: "5001",
      guest: {
        first: "CRM",
        last: "Test",
        phone: "+12395551234",
        email: "crm-test@example.com",
        company: null,
        prefers: null,
      },
    });
    expect(quickActionsFor(lead).map((a) => [a.slot.id, describeTarget(a.target)])).toEqual([
      ["call", ["href", "tel:+12395551234"]],
      ["text", ["href", "sms:+12395551234"]],
      ["email", ["href", "mailto:crm-test@example.com"]],
      ["note", ["sheet", "note"]],
      ["snooze", ["sheet", "snooze"]],
    ]);
  });

  it("no phone, no email → the three device buttons are disabled with the reason, never a dead link", () => {
    const lead = makeLead({
      id: "5002",
      guest: {
        first: "No",
        last: "Contact",
        phone: null,
        email: null,
        company: null,
        prefers: null,
      },
    });
    const rail = quickActionsFor(lead);
    expect(rail.slice(0, 3).every((a) => a.target === null)).toBe(true);
    expect(rail[0]!.slot.disabledTitle).toBe("No phone on file");
    expect(rail[2]!.slot.disabledTitle).toBe("No email on file");
    // Note and Snooze do not need the guest's details — they are ours.
    expect(describeTarget(rail[3]!.target)).toEqual(["sheet", "note"]);
    expect(describeTarget(rail[4]!.target)).toEqual(["sheet", "snooze"]);
  });
});
