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
 * The rail registry C1/C2/C3/B4 each flip one line of: the prototype's five
 * buttons in order (crm-shared.js:245). All five are now wired — Call and
 * Email open their own sheets, Text routes to the guest's conversation, and
 * B4's Note and Snooze open sheets too, all through the `{kind:"sheet"}` half
 * of this registry rather than a mechanism of their own.
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

  it("Call, Email, Note and Snooze open their sheets; Text routes in-app", () => {
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
      // C3 flipped the `call` line: the rail rings the guest on the rep's 3CX
      // extension and logs the disposition, rather than handing the number to
      // the device's dialer where the CRM never learns the call happened.
      ["call", { kind: "sheet", id: "call" }],
      // C1 flipped the `text` line: it now opens the guest's CRM conversation,
      // where the rep's own DID, the consent check and the message log live.
      // Handing the phone's SMS app the number would send a text the CRM never
      // sees, from a number the guest cannot reply to in the thread.
      //
      // And it uses the CONTACT key, because that is how `foldConversations`
      // keys a person we know (`sms/service/threads.ts`). A `p-<digits>` link
      // would leave the matching `c-<id>` row unhighlighted and give one
      // conversation two URLs.
      ["text", { kind: "route", href: "/admin/crm/conversations/c-95001" }],
      // C2: a `mailto:` send never reaches Neon, never records first touch and
      // never carries the X-HP-Lead header a reply is matched by.
      ["email", { kind: "sheet", id: "email" }],
      // B4 flipped both of its lines: Note and Snooze are in-drawer sheets,
      // registered in QUICK_ACTION_SHEETS like Call and Email, not a second
      // dispatch mechanism beside them.
      ["note", { kind: "sheet", id: "note" }],
      ["snooze", { kind: "sheet", id: "snooze" }],
    ]);
  });

  it("THE TEXT SLOT IS A ROUTE, NOT AN HREF — an in-app path must not reload the app", () => {
    // `QuickActions` navigates an `href` with `window.location.assign`, which is
    // right for `tel:` / `sms:` / `mailto:` and wrong for a CRM path: it throws
    // away the TanStack cache, re-mints the admin API token, re-runs the SSO
    // gate and re-mounts the shell, and on a phone the rep loses the drawer.
    const lead = makeLead({ id: "5003" });
    const rail = quickActionsFor(lead);
    const kindOf = (id: string) => rail.find((a) => a.slot.id === id)?.target?.kind ?? null;

    expect(kindOf("text")).toBe("route");
    // C2 and C3 landed after C1: Email and Call are no longer device hand-offs
    // but in-drawer sheets. Neither is a `route` — the point of this test is
    // that `text` alone goes through the router.
    expect(kindOf("call")).toBe("sheet");
    expect(kindOf("email")).toBe("sheet");
  });

  it("falls back to the number when the lead has no contact row yet", () => {
    const lead = makeLead({
      id: "5004",
      contactId: null,
      guest: {
        first: "Walk",
        last: "In",
        phone: "+12395551234",
        email: null,
        company: null,
        prefers: null,
      },
    });
    const text = quickActionsFor(lead).find((a) => a.slot.id === "text");
    expect(text?.target).toEqual({
      kind: "route",
      href: "/admin/crm/conversations/p-12395551234",
    });
  });

  it("every slot that resolves to a sheet HAS one registered, and a title for it", () => {
    // A `{kind:"sheet"}` slot with no entry renders permanently disabled, which
    // would be a bug wearing a state's clothes.
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
    // C3's `call`, C2's `email` and B4's two — each exactly one key of its own.
    expect(Object.keys(QUICK_ACTION_SHEETS)).toEqual(["call", "email", "note", "snooze"]);
    expect(
      QUICK_ACTION_SHEETS.call!.title(
        makeLead({
          id: "5005",
          guest: {
            first: "Lee",
            last: "Health",
            phone: "+12395551234",
            email: null,
            company: null,
            prefers: null,
          },
        }),
      ),
    ).toBe("Calling Lee Health");
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
    // A registered sheet is loadable and titled — the sheet the rail opens is
    // a module that exists, not a name nobody resolved.
    for (const id of ["call", "email", "note", "snooze"] as const) {
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
