import { describe, expect, it } from "vitest";
import { makeLead } from "~/features/crm/leads/test-support";
import {
  QUICK_ACTIONS,
  QUICK_ACTION_IDS,
  QUICK_ACTION_SHEETS,
  quickActionsFor,
  sheetSlotFor,
} from "./actions";

/**
 * The rail registry C1/C2/C3 flip one line of: the prototype's five buttons in
 * order (crm-shared.js:245). Call / Text / Email hand off to the device until
 * their channel PR lands; B4's Note and Snooze open their own sheets, through
 * the `{kind:"sheet"}` half of this registry rather than a mechanism of their
 * own.
 *
 * A slot is EITHER wired (a target) or disabled WITH A REASON — never a dead
 * button that silently does nothing, and never a sheet target with no sheet
 * behind it.
 */
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
      expect(QUICK_ACTIONS[id].disabledTitle.length, id).toBeGreaterThan(5);
      expect(typeof QUICK_ACTIONS[id].Icon, id).toBe("object");
    }
    expect(QUICK_ACTIONS.call.owner).toBe("C3");
    expect(QUICK_ACTIONS.text.owner).toBe("C1");
    expect(QUICK_ACTIONS.email.owner).toBe("C2");
    expect(QUICK_ACTIONS.note.owner).toBe("B4");
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
    expect(quickActionsFor(lead).map((a) => [a.slot.id, a.target])).toEqual([
      ["call", { kind: "href", href: "tel:+12395551234" }],
      ["text", { kind: "href", href: "sms:+12395551234" }],
      ["email", { kind: "href", href: "mailto:crm-test@example.com" }],
      ["note", { kind: "sheet", id: "note" }],
      ["snooze", { kind: "sheet", id: "snooze" }],
    ]);
  });

  /**
   * The half that stops C1/C2/C3 shipping a button that opens nothing: every
   * sheet target a slot can produce must have a sheet behind it. B4 registers
   * two — and the ids match the slot ids, so `open(target.id)` cannot miss.
   */
  it("every sheet target has a sheet behind it, and B4's two are the ones registered", () => {
    expect(Object.keys(QUICK_ACTION_SHEETS).sort()).toEqual(["note", "snooze"]);
    const lead = makeLead({
      id: "5003",
      guest: {
        first: "CRM",
        last: "Test",
        phone: "+12395551234",
        email: "crm-test@example.com",
        company: null,
        prefers: null,
      },
    });
    for (const id of QUICK_ACTION_IDS) {
      const target = QUICK_ACTIONS[id].resolve(lead);
      if (target?.kind === "sheet") {
        expect(target.id, id).toBe(id);
        expect(sheetSlotFor(target.id), id).not.toBeNull();
      }
    }
    // A registered sheet is loadable and titled — the sheet the rail opens is
    // a module that exists, not a name nobody resolved.
    for (const id of ["note", "snooze"] as const) {
      const slot = sheetSlotFor(id)!;
      expect(typeof slot.load, id).toBe("function");
      expect(slot.title(lead).length, id).toBeGreaterThan(3);
      expect(slot.testId, id).toBeTruthy();
    }
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
    // Note and Snooze need nothing from the guest's record — they are ours.
    expect(rail[3]!.target).toEqual({ kind: "sheet", id: "note" });
    expect(rail[4]!.target).toEqual({ kind: "sheet", id: "snooze" });
  });
});
