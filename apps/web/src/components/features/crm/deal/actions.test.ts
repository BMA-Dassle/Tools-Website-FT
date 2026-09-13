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
 * The rail registry C1/C2/C3/B4 flip one line of: the prototype's five
 * buttons in order (crm-shared.js:245), Call and Text handing off to the
 * device today, Email opening C2's composer, Note and Snooze disabled with a
 * reason rather than faked.
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

  it("a guest with a phone gets tel: / sms:, an email opens the composer, Note and Snooze stay disabled", () => {
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
      // C2: a `mailto:` send never reaches Neon, never records first touch and
      // never carries the X-HP-Lead header a reply is matched by.
      ["email", { kind: "sheet", id: "email" }],
      ["note", null],
      ["snooze", null],
    ]);
  });

  it("every sheet target has a registered sheet behind it", () => {
    for (const id of QUICK_ACTION_IDS) {
      const target = QUICK_ACTIONS[id].resolve(
        makeLead({
          id: "5003",
          guest: {
            first: "CRM",
            last: "Test",
            phone: "+12395551234",
            email: "crm-test@example.com",
            company: null,
            prefers: null,
          },
        }),
      );
      if (target?.kind === "sheet") expect(sheetSlotFor(target.id), id).not.toBeNull();
    }
    expect(Object.keys(QUICK_ACTION_SHEETS)).toEqual(["email"]);
    expect(
      QUICK_ACTION_SHEETS.email!.title(
        makeLead({
          id: "5004",
          guest: {
            first: "Dana",
            last: "Acme",
            phone: null,
            email: "dana@example.com",
            company: null,
            prefers: null,
          },
        }),
      ),
    ).toBe("Email Dana");
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
