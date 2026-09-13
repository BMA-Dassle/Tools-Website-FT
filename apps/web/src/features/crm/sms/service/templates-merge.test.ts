import { describe, expect, it } from "vitest";
import {
  mergeTemplate,
  mergeValues,
  normalizeForGsm7,
  renderTemplate,
  toGsm7,
} from "./templates-merge";
import type { CrmTemplate, LinkedContact, LinkedLead } from "../types";

/**
 * Merge and GSM-7. The seeded T-2 carries an em dash, so "assert and throw"
 * would make a shipped template unsendable — the rule is normalise, then
 * assert, and store what actually left.
 */

const contact: LinkedContact = {
  id: "9",
  firstName: "Dana",
  lastName: "Whitfield",
  phoneE164: "+12395551234",
  email: "dana@example.com",
  accountName: "Lee Health",
};

const lead: LinkedLead = {
  id: "1042",
  publicId: "L-1042",
  source: "web",
  isProspect: false,
  assignedRepId: "7",
  centre: "HPFM",
  eventDate: "2026-10-17",
  eventType: "corporate",
  guests: 60,
  statusId: "quote",
};

const ctx = { contact, lead, rep: { firstName: "Kelsea" } };

describe("merge fields", () => {
  it("fills the tokens we have from real rows", () => {
    const v = mergeValues(ctx);
    expect(v["guest.first"]).toBe("Dana");
    expect(v["rep.first"]).toBe("Kelsea");
    expect(v["centre.short"]).toBe("HP Fort Myers");
    expect(v["centre.name"]).toBe("HeadPinz Fort Myers");
    expect(v["event.guests"]).toBe("60");
    expect(v["event.type"]).toBe("corporate");
    expect(v["account.name"]).toBe("Lee Health");
    expect(v["event.date"]).toMatch(/Oct/);
  });

  it("leaves a token we cannot fill VISIBLE and reports it — never a silent blank", () => {
    const out = mergeTemplate("Signing link: {{contract.link}} for {{guest.first}}", ctx);
    expect(out.text).toBe("Signing link: {{contract.link}} for Dana");
    expect(out.missing).toEqual(["contract.link"]);
  });

  it("an unknown token is left alone too", () => {
    const out = mergeTemplate("{{not.a.field}}", ctx);
    expect(out.text).toBe("{{not.a.field}}");
    expect(out.missing).toEqual(["not.a.field"]);
  });

  it("with no lead and no contact, every token survives for the rep to fill", () => {
    const out = mergeTemplate("Hi {{guest.first}} at {{centre.short}}", {
      contact: null,
      lead: null,
      rep: null,
    });
    expect(out.text).toBe("Hi {{guest.first}} at {{centre.short}}");
    expect(out.missing).toEqual(["guest.first", "centre.short"]);
  });
});

describe("GSM-7", () => {
  it("normalises the characters a phone keyboard substitutes", () => {
    expect(normalizeForGsm7("Hi — it’s “us”…")).toBe(`Hi - it's "us"...`);
  });

  it("the SEEDED T-2 em dash passes after normalising — it would throw without it", () => {
    const t2 = "Hi {{guest.first}} — checking in on the {{event.date}} quote.";
    const merged = mergeTemplate(t2, ctx).text;
    expect(merged).toContain("—");
    const gsm = toGsm7(merged, "T-2");
    expect(gsm.ok).toBe(true);
    expect(gsm.body).not.toContain("—");
    expect(gsm.body).toContain("Hi Dana - checking in");
  });

  it("refuses what normalising cannot fix, and names the character", () => {
    const gsm = toGsm7("See you there 🎉");
    expect(gsm.ok).toBe(false);
    expect(gsm.offending).not.toBeNull();
  });

  it("an accented name is refused rather than mangled", () => {
    expect(toGsm7("Hola José").ok).toBe(false);
  });
});

describe("renderTemplate", () => {
  const tpl: CrmTemplate = {
    id: "2",
    kind: "sms",
    name: "Quote nudge (48 h)",
    subject: null,
    body: "Hi {{guest.first}} — holding your lanes until {{hold.until}}.",
    mergeFields: ["guest.first", "hold.until"],
    centre: null,
    position: 20,
    archivedAt: null,
  };

  it("renders GSM-7-safe text and lists what the rep must still fill in", () => {
    const out = renderTemplate(tpl, ctx);
    expect(out.rendered).toBe("Hi Dana - holding your lanes until {{hold.until}}.");
    expect(out.missing).toEqual(["hold.until"]);
    expect(out.renderedSubject).toBeNull();
  });

  it("an EMAIL template keeps its punctuation — GSM-7 is an SMS constraint", () => {
    const email: CrmTemplate = {
      ...tpl,
      id: "4",
      kind: "email",
      subject: "{{centre.name}} — hello",
    };
    const out = renderTemplate(email, ctx);
    expect(out.rendered).toContain("—");
    expect(out.renderedSubject).toBe("HeadPinz Fort Myers — hello");
  });
});
