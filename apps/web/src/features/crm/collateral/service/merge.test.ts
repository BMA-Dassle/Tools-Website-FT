import { describe, expect, it } from "vitest";
import { TEMPLATE_SEED } from "../../core/seed";
import {
  MERGE_FIELDS,
  MERGE_FIELD_KEYS,
  PREVIEW_GAP_FIELDS,
  gsm7Verdict,
  mergeFieldsIn,
  previewValues,
  renderSegments,
  renderTemplate,
  sampleValues,
  smsSegments,
} from "./merge";

/**
 * The brief's C6 requirement for templates is one sentence: "a preview that
 * HIGHLIGHTS a missing field rather than rendering a blank". These cases are
 * the ways that goes wrong.
 *
 *   blank substitution   "Hi , it's Kelsea" reads like a typo, so a rep sends
 *                        it; the guest gets a letter addressed to nobody.
 *   silent typo          `{{guest.frist}}` is not a merge field at all. If it
 *                        rendered blank, nobody would ever learn the template
 *                        is broken — it has to be a DIFFERENT failure from a
 *                        field the lead simply has no value for.
 *   whitespace token     a director hand-types `{{ guest.first }}`. Refusing
 *                        that is user-hostile for no gain.
 *   regex state          a module-level /g regex keeps `lastIndex` between
 *                        calls and silently skips every other match — the
 *                        second preview of the same body would differ from the
 *                        first.
 *   GSM-7                a single em dash halves the segment length and
 *                        doubles the bill, and the SEEDED "Quote nudge"
 *                        template already contains one.
 */

const LEAD = {
  "guest.first": "Dana",
  "rep.first": "Kelsea",
  "centre.short": "HP Fort Myers",
  "event.date": "Sat Oct 17",
  "event.guests": 60,
};

describe("merge fields", () => {
  it("offers exactly the twelve documented fields, each with a sample", () => {
    expect(MERGE_FIELD_KEYS).toEqual([
      "guest.first",
      "rep.first",
      "centre.short",
      "centre.name",
      "event.date",
      "event.type",
      "event.guests",
      "hold.until",
      "contract.link",
      "lastYear.date",
      "account.name",
      "quote.sentAgo",
    ]);
    for (const f of MERGE_FIELDS) {
      expect(f.sample.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
    expect(Object.keys(sampleValues())).toHaveLength(12);
  });

  it("finds every token once, in order, including whitespace-padded ones", () => {
    expect(mergeFieldsIn("{{guest.first}} then {{ rep.first }} then {{guest.first}}")).toEqual([
      "guest.first",
      "rep.first",
    ]);
  });

  it("does not lose matches on a second call (no shared regex lastIndex)", () => {
    const body = "{{guest.first}} {{rep.first}} {{centre.short}}";
    const first = mergeFieldsIn(body);
    const second = mergeFieldsIn(body);
    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
  });
});

describe("renderTemplate", () => {
  it("fills what it can and leaves a missing field VISIBLE, never blank", () => {
    const out = renderTemplate("Hi {{guest.first}}, holding until {{hold.until}}.", LEAD);

    expect(out.text).toBe("Hi Dana, holding until {{hold.until}}.");
    expect(out.text).not.toContain("Hi ,");
    expect(out.missing).toEqual(["hold.until"]);
    expect(out.unknown).toEqual([]);
  });

  it("treats an empty string and whitespace as missing, not as a value", () => {
    const out = renderTemplate("Hi {{guest.first}}!", { "guest.first": "   " });
    expect(out.text).toBe("Hi {{guest.first}}!");
    expect(out.missing).toEqual(["guest.first"]);
  });

  it("separates a typo'd token from a field the lead has no value for", () => {
    const out = renderTemplate("Hi {{guest.frist}}, on {{event.date}} at {{centre.name}}.", LEAD);

    expect(out.unknown).toEqual(["guest.frist"]);
    expect(out.missing).toEqual(["centre.name"]);
    expect(out.text).toBe("Hi {{guest.frist}}, on Sat Oct 17 at {{centre.name}}.");
  });

  it("renders a number field", () => {
    expect(renderTemplate("{{event.guests}} guests", LEAD).text).toBe("60 guests");
  });

  it("fills every field from the samples when no lead is in hand", () => {
    const body = MERGE_FIELD_KEYS.map((k) => `{{${k}}}`).join(" ");
    const out = renderTemplate(body, sampleValues());
    expect(out.missing).toEqual([]);
    expect(out.unknown).toEqual([]);
    expect(out.text).not.toContain("{{");
  });
});

/**
 * THE EDITOR'S PREVIEW HAS TO BE ABLE TO HIGHLIGHT SOMETHING. Previewing
 * against `sampleValues()` — all twelve present — makes `missing` false for
 * every known token, so the `<mark>` never paints and the caption under the
 * preview promises a behaviour a director can never see. `previewValues()`
 * is the default the editor uses: a lead shaped like the prototype's own
 * (Lee Health, L-1042), which has no hold, no event with us last year and no
 * quote sent yet.
 */
describe("previewValues", () => {
  it("leaves the three optional fields empty by default, so a preview can highlight", () => {
    const values = previewValues();
    for (const key of PREVIEW_GAP_FIELDS) expect(values[key]).toBeNull();
    expect(values["guest.first"]).toBe("Dana");
  });

  it("makes exactly those fields missing in a rendered body", () => {
    const body = MERGE_FIELD_KEYS.map((k) => `{{${k}}}`).join(" ");
    const out = renderTemplate(body, previewValues());
    expect(out.missing.sort()).toEqual([...PREVIEW_GAP_FIELDS].sort());
    expect(out.unknown).toEqual([]);
    expect(out.text).toContain("{{hold.until}}");
  });

  it("fills everything when the director asks for the complete lead", () => {
    const body = MERGE_FIELD_KEYS.map((k) => `{{${k}}}`).join(" ");
    expect(renderTemplate(body, previewValues("complete")).missing).toEqual([]);
  });
});

describe("renderSegments", () => {
  it("reassembles to exactly the rendered text, with the field hits flagged", () => {
    const body = "Hi {{guest.first}} — {{hold.until}} and {{nope}}.";
    const segments = renderSegments(body, LEAD);

    expect(segments.map((s) => s.text).join("")).toBe(renderTemplate(body, LEAD).text);
    const fields = segments.filter((s) => s.kind === "field");
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({ key: "guest.first", missing: false, unknown: false });
    expect(fields[1]).toMatchObject({ key: "hold.until", missing: true, unknown: false });
    expect(fields[2]).toMatchObject({ key: "nope", missing: false, unknown: true });
  });

  it("keeps the literal text around a token", () => {
    expect(renderSegments("a{{guest.first}}b", LEAD)).toEqual([
      { kind: "text", text: "a" },
      { kind: "field", key: "guest.first", text: "Dana", missing: false, unknown: false },
      { kind: "text", text: "b" },
    ]);
  });
});

describe("gsm7Verdict", () => {
  it("passes plain ASCII and names the first offending character otherwise", () => {
    expect(gsm7Verdict("Hi Dana, see you Saturday!")).toEqual({ ok: true, offending: null });
    expect(gsm7Verdict("Hi Dana — see you")).toEqual({ ok: false, offending: "—" });
    expect(gsm7Verdict("It’s ready")).toEqual({ ok: false, offending: "’" });
  });

  it("flags the SEEDED Quote nudge template — it ships with an em dash", () => {
    const seeded = TEMPLATE_SEED.find((t) => t.name === "Quote nudge (48 h)");
    expect(seeded).toBeDefined();
    const verdict = gsm7Verdict(seeded?.body ?? "");
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toBe("—");
  });

  it("passes every other seeded SMS template", () => {
    const bad = TEMPLATE_SEED.filter(
      (t) => t.kind === "sms" && t.name !== "Quote nudge (48 h)" && !gsm7Verdict(t.body).ok,
    );
    expect(bad.map((t) => t.name)).toEqual([]);
  });
});

describe("smsSegments", () => {
  it("counts 160 for one segment and 153 per segment after that", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
  });
});
