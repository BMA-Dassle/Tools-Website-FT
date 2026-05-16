import { describe, expect, it } from "vitest";
import { stringifyWithRawIds } from "./raw-ids";

/**
 * Snapshot tests against the hand-rolled raw-injection pattern in
 * `bookRaceHeat()` (apps/web/app/book/race/data.ts lines 1099-1108).
 *
 * Both implementations must produce byte-identical JSON so the
 * downstream BMI API receives the same payload bit-for-bit. If a
 * change here breaks parity, BMI may parse the body differently.
 */

/** Reference implementation, copied verbatim from bookRaceHeat. */
function bookRaceHeatReference(
  payload: Record<string, unknown>,
  existingOrderId?: string | null,
  personId?: string | null,
): string {
  let bodyJson = JSON.stringify(payload);
  if (existingOrderId) {
    bodyJson = `{"orderId":${existingOrderId},` + bodyJson.slice(1);
  }
  if (personId) {
    bodyJson = bodyJson.slice(0, -1) + `,"personId":${personId}}`;
  }
  return bodyJson;
}

const SAMPLE_PAYLOAD = {
  productId: "P-123",
  quantity: 2,
  resourceId: 7,
  proposal: {
    blocks: [{ productLineIds: [1, 2], block: { resourceId: 7, slotId: "s_42" } }],
    productLineId: null,
  },
};

// Real 17-digit BMI shapes — these are the values that break Number().
const ORDER_ID = "63000000000021716";
const PERSON_ID = "63000000000099999";

describe("stringifyWithRawIds", () => {
  it("with no raw ids returns the same shape as JSON.stringify", () => {
    expect(stringifyWithRawIds(SAMPLE_PAYLOAD, { rawIds: {} })).toBe(
      JSON.stringify(SAMPLE_PAYLOAD),
    );
  });

  it("orderId-only output matches bookRaceHeat reference", () => {
    const ours = stringifyWithRawIds(SAMPLE_PAYLOAD, { rawIds: { orderId: ORDER_ID } });
    const ref = bookRaceHeatReference(SAMPLE_PAYLOAD, ORDER_ID, null);
    expect(ours).toBe(ref);
  });

  it("personId-only output matches bookRaceHeat reference", () => {
    const ours = stringifyWithRawIds(SAMPLE_PAYLOAD, { rawIds: { personId: PERSON_ID } });
    const ref = bookRaceHeatReference(SAMPLE_PAYLOAD, null, PERSON_ID);
    expect(ours).toBe(ref);
  });

  it("orderId + personId output matches bookRaceHeat reference", () => {
    const ours = stringifyWithRawIds(SAMPLE_PAYLOAD, {
      rawIds: { orderId: ORDER_ID, personId: PERSON_ID },
    });
    const ref = bookRaceHeatReference(SAMPLE_PAYLOAD, ORDER_ID, PERSON_ID);
    expect(ours).toBe(ref);
  });

  it("preserves precision of 17-digit BMI IDs (no rounding)", () => {
    const out = stringifyWithRawIds(SAMPLE_PAYLOAD, {
      rawIds: { orderId: ORDER_ID, personId: PERSON_ID },
    });
    // Both IDs must appear unchanged in the output as raw numeric literals.
    expect(out).toContain(`"orderId":${ORDER_ID}`);
    expect(out).toContain(`"personId":${PERSON_ID}`);
    // And the round-trip through Number() (which would corrupt them) must
    // NOT appear — proves we never let the IDs through JSON.stringify.
    expect(out).not.toContain(String(Number(ORDER_ID)));
    expect(out).not.toContain(String(Number(PERSON_ID)));
  });

  it("rejects non-digit raw ids (defense against injection)", () => {
    expect(() =>
      stringifyWithRawIds(SAMPLE_PAYLOAD, {
        rawIds: { personId: '123,"injected":true' },
      }),
    ).toThrow(/must be a string of digits/);

    expect(() =>
      stringifyWithRawIds(SAMPLE_PAYLOAD, {
        rawIds: { personId: "" },
      }),
    ).toThrow(/must be a string of digits/);

    expect(() =>
      stringifyWithRawIds(SAMPLE_PAYLOAD, {
        rawIds: { personId: "abc" },
      }),
    ).toThrow(/must be a string of digits/);
  });

  it("appends multiple non-orderId raw ids in iteration order", () => {
    const out = stringifyWithRawIds(SAMPLE_PAYLOAD, {
      rawIds: { personId: PERSON_ID, contactId: "12345" },
    });
    // Both must be present, both raw, after the payload.
    expect(out).toContain(`"personId":${PERSON_ID}`);
    expect(out).toContain(`"contactId":12345`);
    // Must still end with a closing brace (single object, not malformed).
    expect(out.endsWith("}")).toBe(true);
    expect(out.startsWith("{")).toBe(true);
  });
});
