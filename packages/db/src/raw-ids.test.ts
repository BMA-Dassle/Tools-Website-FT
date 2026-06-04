import { describe, expect, it } from "vitest";
import { stringifyWithRawIds, parseWithRawIds, serializeWithRawIds } from "./raw-ids";

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

describe("parseWithRawIds", () => {
  // The exact value from the production incident. As a JS number it rounds up.
  const BIG_ID = "63000000003675359";

  it("demonstrates the bug it fixes: JSON.parse rounds the 17-digit id (+1)", () => {
    // Sanity-check the premise — standard parsing corrupts the value.
    const corrupted = JSON.parse(`{"personID":${BIG_ID}}`) as { personID: number };
    expect(corrupted.personID).toBe(63000000003675360); // off-by-one
    expect(String(corrupted.personID)).not.toBe(BIG_ID);
  });

  it("preserves a 17-digit id as an exact string (no rounding)", () => {
    const out = parseWithRawIds<{ personID: string }>(`{"personID":${BIG_ID}}`);
    expect(out.personID).toBe(BIG_ID);
    expect(typeof out.personID).toBe("string");
  });

  it("matches the Pandora person-create response shape", () => {
    const raw = `{"success":true,"data":{"personID":${BIG_ID},"firstName":"Ada"}}`;
    const out = parseWithRawIds<{ data: { personID: string; firstName: string } }>(raw);
    expect(out.data.personID).toBe(BIG_ID);
    expect(out.data.firstName).toBe("Ada");
  });

  it("leaves ids the source already quoted untouched", () => {
    const out = parseWithRawIds<{ orderId: string }>(`{"orderId":"${BIG_ID}"}`);
    expect(out.orderId).toBe(BIG_ID);
  });

  it("quotes every listed id field, including nested ones", () => {
    const raw = `{"id":${BIG_ID},"logs":[{"id":63000000003675001}],"name":"Heat"}`;
    const out = parseWithRawIds<{ id: string; logs: { id: string }[]; name: string }>(raw);
    expect(out.id).toBe(BIG_ID);
    expect(out.logs[0].id).toBe("63000000003675001");
    expect(out.name).toBe("Heat");
  });

  it("does not touch non-id numeric fields", () => {
    const raw = `{"orderId":${BIG_ID},"quantity":2,"price":54.5}`;
    const out = parseWithRawIds<{ orderId: string; quantity: number; price: number }>(raw);
    expect(out.orderId).toBe(BIG_ID);
    expect(out.quantity).toBe(2);
    expect(out.price).toBe(54.5);
  });

  it("does not match a similarly-named key (personId vs id)", () => {
    // "id" must not rewrite "personId"; both are handled, but independently.
    const raw = `{"personId":${BIG_ID}}`;
    const out = parseWithRawIds<{ personId: string }>(raw);
    expect(out.personId).toBe(BIG_ID);
  });

  it("round-trips back to a faithful outbound body via stringifyWithRawIds", () => {
    const parsed = parseWithRawIds<{ id: string; name: string }>(
      `{"id":${BIG_ID},"name":"Project"}`,
    );
    const { id, ...rest } = parsed;
    const body = stringifyWithRawIds(rest, { rawIds: { id } });
    // The id is re-emitted as a raw numeric token, exactly as BMI sent it.
    expect(body).toContain(`"id":${BIG_ID}`);
    expect(body).not.toContain("63000000003675360");
  });
});

describe("serializeWithRawIds (parse → modify → PUT round-trip)", () => {
  const BIG_ID = "63000000003675359";
  const PERSON_ID = "63000000003675401";

  it("re-emits id fields as raw numeric tokens, not quoted strings", () => {
    const obj = { id: BIG_ID, personId: PERSON_ID, name: "Heat", stateId: "-3" };
    const body = serializeWithRawIds(obj);
    expect(body).toContain(`"id":${BIG_ID}`);
    expect(body).toContain(`"personId":${PERSON_ID}`);
    expect(body).not.toContain(`"id":"${BIG_ID}"`);
    // Non-id strings stay quoted.
    expect(body).toContain(`"name":"Heat"`);
  });

  it("is a byte-faithful round-trip of a numeric-id BMI project (only the changed field differs)", () => {
    // Shape mirrors what BMI Office returns: bare numeric ids, including nested.
    const original = `{"id":${BIG_ID},"stateId":-1,"name":"Birthday","personId":${PERSON_ID},"persons":[{"id":63000000003675999,"name":"Ada"}]}`;
    const project = parseWithRawIds<Record<string, unknown>>(original);
    // Every id survived parsing as an exact string.
    expect(project.id).toBe(BIG_ID);
    expect(project.personId).toBe(PERSON_ID);
    expect((project.persons as { id: string }[])[0].id).toBe("63000000003675999");

    // Modify a non-id field, then serialize back to BMI's numeric wire format.
    project.stateId = "-3";
    const body = serializeWithRawIds(project);
    expect(body).toBe(
      `{"id":${BIG_ID},"stateId":"-3","name":"Birthday","personId":${PERSON_ID},"persons":[{"id":63000000003675999,"name":"Ada"}]}`,
    );
    // The rounded value never appears anywhere.
    expect(body).not.toContain("63000000003675360");
    expect(body).not.toContain("63000000003675400");
  });

  it("leaves null / non-digit id values untouched", () => {
    const body = serializeWithRawIds({ invoiceId: null, id: BIG_ID, name: "x" });
    expect(body).toContain(`"invoiceId":null`);
    expect(body).toContain(`"id":${BIG_ID}`);
  });
});
