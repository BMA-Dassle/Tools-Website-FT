/**
 * A grant is the ONLY thing standing between the waiver licence offer and a
 * person-lookup oracle: without a booking to check a personId against, anything
 * these functions accept is something the endpoint will resolve a login code
 * for. Every test here is about what must be REFUSED.
 */
import { describe, it, expect } from "vitest";
import {
  signLicenceGrant,
  verifyLicenceGrant,
  verifyLicenceGrants,
  GRANT_SEPARATOR,
} from "./licence-grant";

const NOW = 1_754_500_000_000;

describe("verifyLicenceGrant", () => {
  it("round-trips the person it vouches for", () => {
    const g = signLicenceGrant("409523", "Eric", NOW);
    expect(verifyLicenceGrant(g, NOW)).toEqual({ personId: "409523", name: "Eric" });
  });

  it("refuses a grant whose personId was swapped", () => {
    // THE WHOLE POINT. Editing the payload to name a stranger must not survive,
    // or the offer endpoint resolves any racer's login code for anyone.
    const g = signLicenceGrant("409523", "Eric", NOW);
    const [body, sig] = g.split(".");
    const tampered = JSON.parse(Buffer.from(body, "base64url").toString());
    tampered.p = "682832";
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${sig}`;
    expect(verifyLicenceGrant(forged, NOW)).toBeNull();
  });

  it("refuses a grant whose NAME was swapped", () => {
    // The name is rendered on the page beside a QR that adds a licence. A
    // relabelled row is how a parent taps a child's pass onto their own phone.
    const g = signLicenceGrant("409523", "Eric", NOW);
    const [body, sig] = g.split(".");
    const tampered = JSON.parse(Buffer.from(body, "base64url").toString());
    tampered.n = "Someone Else";
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${sig}`;
    expect(verifyLicenceGrant(forged, NOW)).toBeNull();
  });

  it("expires after two hours", () => {
    const g = signLicenceGrant("409523", "Eric", NOW);
    expect(verifyLicenceGrant(g, NOW + 2 * 60 * 60 * 1000 - 1000)).not.toBeNull();
    expect(verifyLicenceGrant(g, NOW + 2 * 60 * 60 * 1000 + 1000)).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    // A malformed token arrives as a query param, so it must be a null and not
    // a 500 — timingSafeEqual throws outright on a length mismatch.
    for (const junk of ["", ".", "abc", "a.b", "....", "x".repeat(400), "eyJ9.short"]) {
      expect(() => verifyLicenceGrant(junk, NOW)).not.toThrow();
      expect(verifyLicenceGrant(junk, NOW)).toBeNull();
    }
    expect(verifyLicenceGrant(null as unknown as string, NOW)).toBeNull();
  });

  it("refuses a non-numeric personId even when correctly signed", () => {
    const g = signLicenceGrant("not-a-person", "Eric", NOW);
    expect(verifyLicenceGrant(g, NOW)).toBeNull();
  });

  it("bounds the name it will vouch for", () => {
    const g = signLicenceGrant("409523", "x".repeat(500), NOW);
    expect(verifyLicenceGrant(g, NOW)!.name.length).toBe(60);
  });
});

describe("verifyLicenceGrants — a whole party in one parameter", () => {
  it("keeps the valid grants when one is expired", () => {
    // A family of four must not lose three passes because the first person
    // signed more than two hours ago.
    const fresh = signLicenceGrant("409523", "Eric", NOW);
    const stale = signLicenceGrant("682832", "Jamil", NOW - 3 * 60 * 60 * 1000);
    const out = verifyLicenceGrants([stale, fresh].join(GRANT_SEPARATOR), NOW);
    expect(out.map((g) => g.personId)).toEqual(["409523"]);
  });

  it("dedupes a person listed twice", () => {
    const g = signLicenceGrant("409523", "Eric", NOW);
    expect(verifyLicenceGrants([g, g].join(GRANT_SEPARATOR), NOW)).toHaveLength(1);
  });

  it("caps how many people one request can ask about", () => {
    // Unbounded, this is a batch lookup endpoint.
    const many = Array.from({ length: 40 }, (_, i) =>
      signLicenceGrant(String(400000 + i), `R${i}`, NOW),
    );
    expect(verifyLicenceGrants(many.join(GRANT_SEPARATOR), NOW).length).toBeLessThanOrEqual(12);
  });

  it("is empty for a missing or junk parameter", () => {
    expect(verifyLicenceGrants(null, NOW)).toEqual([]);
    expect(verifyLicenceGrants("", NOW)).toEqual([]);
    expect(verifyLicenceGrants("junk~junk", NOW)).toEqual([]);
  });
});
