import { describe, expect, it } from "vitest";
import {
  bodyHash,
  canonicalParamString,
  percentEncode,
  signRequest,
} from "./sign";

// Ground truth is Groupon's own worked example (developers/1-integration-technical-setup-2),
// reproduced here so a refactor can't quietly change the canonicalisation.
const GROUPON_DOC_BASE =
  "POST&2e9724ca18a74b349ffa65d17611e5b0&https%3A%2F%2Fgroupon.example.com%2Fgroupon%2Fv1%2Fproducts%2F00000000-0000-00ff-ffff-ffffffffffff%2Favailability&foo%3DHello%252BWorld%26locale%3Den-US&891e8dc452cd14702978d1ededb4445c18974bfae0c027ec8a1ade96d3a64395";

describe("percentEncode", () => {
  it("encodes the RFC 3986 characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("a!b*c'd(e)f")).toBe("a%21b%2Ac%27d%28e%29f");
  });

  it("encodes + and = so they survive the round trip", () => {
    expect(percentEncode("Hello+World")).toBe("Hello%2BWorld");
    expect(percentEncode("a=b")).toBe("a%3Db");
  });
});

describe("canonicalParamString", () => {
  it("sorts by key, not by insertion order", () => {
    expect(canonicalParamString({ locale: "en-US", foo: "bar" })).toBe("foo=bar&locale=en-US");
  });

  it("encodes each key and value individually", () => {
    // Encoded ONCE here; signRequest encodes the whole string a second time.
    expect(canonicalParamString({ foo: "Hello+World", locale: "en-US" })).toBe(
      "foo=Hello%2BWorld&locale=en-US",
    );
  });

  it("is empty for no params", () => {
    expect(canonicalParamString({})).toBe("");
  });
});

describe("bodyHash", () => {
  it("hashes an empty body to the documented digest", () => {
    expect(bodyHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("trims before hashing (whitespace must not change the signature)", () => {
    expect(bodyHash('  {"a":1}  ')).toBe(bodyHash('{"a":1}'));
  });
});

describe("signRequest", () => {
  // THE regression test. A param value containing `+` is the only thing that
  // distinguishes single from double encoding — `foo=Hello%252BWorld` in the
  // base string is one encoding for the value and a second for the whole
  // param string. Drop the second and Groupon answers INVALID_REQUEST_SIGNATURE.
  it("reproduces Groupon's documented base string exactly", () => {
    const { baseString } = signRequest({
      method: "POST",
      baseUrl:
        "https://groupon.example.com/groupon/v1/products/00000000-0000-00ff-ffff-ffffffffffff/availability",
      params: { foo: "Hello+World", locale: "en-US" },
      body: "",
      signingKey: "irrelevant-to-the-base-string",
      nonce: "2e9724ca18a74b349ffa65d17611e5b0",
    });
    // The doc's example pairs a non-empty body hash with this base; ours is the
    // empty-body digest, so compare everything up to the final component.
    const upToBody = (s: string) => s.slice(0, s.lastIndexOf("&"));
    expect(upToBody(baseString)).toBe(upToBody(GROUPON_DOC_BASE));
  });

  it("uses the signing key RAW — a base64-decoded key must not match", () => {
    const key = "E9Ts+EOucdqRffJVlw7xZEZApP2gKSgGHsK3J3Tp";
    const raw = signRequest({
      method: "GET",
      baseUrl: "https://offer-api.groupon.com/partners/p/v1/units",
      params: { redemptionCodes: "WNDXH4DJ" },
      signingKey: key,
      nonce: "0".repeat(32),
    });
    const decoded = signRequest({
      method: "GET",
      baseUrl: "https://offer-api.groupon.com/partners/p/v1/units",
      params: { redemptionCodes: "WNDXH4DJ" },
      signingKey: Buffer.from(key, "base64").toString("binary"),
      nonce: "0".repeat(32),
    });
    expect(raw.authorization).not.toBe(decoded.authorization);
  });

  it("emits the groupon-third-party authorization header shape", () => {
    const { authorization } = signRequest({
      method: "GET",
      baseUrl: "https://offer-api.groupon.com/partners/p/v1/units",
      signingKey: "k",
      nonce: "abc123",
    });
    expect(authorization).toMatch(
      /^groupon-third-party version="1\.1",digest="HMAC-SHA1",nonce="abc123",signature="[^"]+"$/,
    );
  });

  it("changes the signature when the body changes", () => {
    const base = {
      method: "PATCH",
      baseUrl: "https://offer-api.groupon.com/partners/p/v1/units",
      params: { client_id: "cid" },
      signingKey: "k",
      nonce: "n".repeat(32),
    };
    const a = signRequest({ ...base, body: '{"data":[{"id":"1"}]}' });
    const b = signRequest({ ...base, body: '{"data":[{"id":"2"}]}' });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("changes the signature when the method changes", () => {
    const base = {
      baseUrl: "https://offer-api.groupon.com/partners/p/v1/units",
      signingKey: "k",
      nonce: "n".repeat(32),
    };
    expect(signRequest({ ...base, method: "GET" }).authorization).not.toBe(
      signRequest({ ...base, method: "PATCH" }).authorization,
    );
  });
});
