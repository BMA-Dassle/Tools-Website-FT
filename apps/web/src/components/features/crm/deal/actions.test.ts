import { describe, expect, it } from "vitest";
import { makeLead } from "~/features/crm/leads/test-support";
import { QUICK_ACTIONS, QUICK_ACTION_IDS, quickActionsFor } from "./actions";

/**
 * The rail registry C1/C2/C3/B4 flip one line of: the prototype's five
 * buttons in order (crm-shared.js:245), Call/Text/Email handing off to the
 * device today, Note and Snooze disabled with a reason rather than faked.
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

  it("a guest with a phone and an email gets tel: / sms: / mailto:; Note and Snooze stay disabled", () => {
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
    // C1 flipped the `text` line: it now opens the guest's CRM conversation,
    // where the rep's own DID, the consent check and the message log live.
    // Handing the phone's SMS app the number would send a text the CRM never
    // sees, from a number the guest cannot reply to in the thread.
    expect(quickActionsFor(lead).map((a) => [a.slot.id, a.target?.href ?? null])).toEqual([
      ["call", "tel:+12395551234"],
      ["text", "/admin/crm/conversations/p-12395551234"],
      ["email", "mailto:crm-test@example.com"],
      ["note", null],
      ["snooze", null],
    ]);
  });

  it("no phone, no email → those three are disabled with the reason, never a dead link", () => {
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
    expect(rail.every((a) => a.target === null)).toBe(true);
    expect(rail[0]!.slot.disabledTitle).toBe("No phone on file");
    expect(rail[2]!.slot.disabledTitle).toBe("No email on file");
  });
});
