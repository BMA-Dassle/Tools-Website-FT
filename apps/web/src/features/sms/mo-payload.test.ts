import { describe, it, expect } from "vitest";
import { parseMoPayload } from "./mo-payload";

/** The literal first inbound payload we ever captured, verbatim from the
 *  ring buffer on 2026-08-19. Every parser assertion is anchored to this
 *  rather than to a shape someone imagined. */
const REAL_CAPTURE = {
  channel: "messaging",
  type: "mo",
  api_version: "2025-02-01",
  id: "6a8654c7ff2145b4ffe2f2c6",
  to: "+12394412867",
  from: "+12397762044",
  body: "Start ",
  received_at: "2026-08-20T01:13:42.000Z",
};

const OUR_DID = "+12394412867";

/** Drop one key — clearer than a destructure-and-discard, and it does not
 *  leave an unused binding behind for the linter to grumble about. */
function without<K extends string>(obj: Record<string, unknown>, key: K) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

describe("parseMoPayload — the real captured payload", () => {
  it("parses it", () => {
    const r = parseMoPayload(REAL_CAPTURE, [OUR_DID]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.id).toBe("6a8654c7ff2145b4ffe2f2c6");
    expect(r.payload.from).toBe("+12397762044");
    expect(r.payload.to).toBe(OUR_DID);
    expect(r.payload.apiVersion).toBe("2025-02-01");
  });

  it("preserves the body byte-for-byte, trailing space included", () => {
    // Normalization is the classifier's job. If the parser trimmed here,
    // we would lose the ability to reason about T-Mobile CoC 2.11's
    // "no leading spaces" wording at all.
    const r = parseMoPayload(REAL_CAPTURE, [OUR_DID]);
    if (!r.ok) throw new Error("expected ok");
    expect(r.payload.body).toBe("Start ");
  });
});

describe("parseMoPayload — recipient guard", () => {
  it("rejects a payload addressed to a DID that is not ours", () => {
    const r = parseMoPayload({ ...REAL_CAPTURE, to: "+12395550000" }, [OUR_DID]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not one of our DIDs");
  });

  it("accepts any recipient when no allowlist is supplied (bring-up)", () => {
    const r = parseMoPayload({ ...REAL_CAPTURE, to: "+12395550000" }, []);
    expect(r.ok).toBe(true);
  });

  it("compares canonically, not by string equality", () => {
    // A vendor formatting change must not silently fail the guard.
    const r = parseMoPayload({ ...REAL_CAPTURE, to: "2394412867" }, ["+1 (239) 441-2867"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.to).toBe(OUR_DID);
  });
});

describe("parseMoPayload — refuses to guess", () => {
  it("rejects a delivery receipt that reaches the inbound route", () => {
    // Crossed webhook URLs in the portal. Better named than ignored.
    const dlr = {
      message_id: "abc123",
      status: "delivered",
      to: "+12397762044",
      from: OUR_DID,
    };
    const r = parseMoPayload(dlr, [OUR_DID]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("delivery receipt");
  });

  it("rejects a payload whose type is not mo", () => {
    const r = parseMoPayload({ ...REAL_CAPTURE, type: "dlr" }, [OUR_DID]);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing sender", () => {
    const r = parseMoPayload(without(REAL_CAPTURE, "from"), [OUR_DID]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("sender");
  });

  it("rejects an unparseable sender rather than inventing one", () => {
    const r = parseMoPayload({ ...REAL_CAPTURE, from: "unknown" }, [OUR_DID]);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing message id — it is the idempotency key", () => {
    const r = parseMoPayload(without(REAL_CAPTURE, "id"), [OUR_DID]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("message id");
  });

  it("rejects non-objects", () => {
    expect(parseMoPayload(null).ok).toBe(false);
    expect(parseMoPayload("STOP").ok).toBe(false);
    expect(parseMoPayload(42).ok).toBe(false);
  });
});

describe("parseMoPayload — tolerates renames we have already been burned by", () => {
  it("accepts message_id as well as id", () => {
    const r = parseMoPayload({ ...without(REAL_CAPTURE, "id"), message_id: "xyz" }, [OUR_DID]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.id).toBe("xyz");
  });

  it("accepts text as well as body", () => {
    const r = parseMoPayload({ ...without(REAL_CAPTURE, "body"), text: "STOP" }, [OUR_DID]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.body).toBe("STOP");
  });

  it("treats an absent body as empty, not as a parse failure", () => {
    // A whitespace-only or media-only message is legitimate inbound.
    const r = parseMoPayload(without(REAL_CAPTURE, "body"), [OUR_DID]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.body).toBe("");
  });
});
