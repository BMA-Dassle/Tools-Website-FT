import { describe, expect, it } from "vitest";
import { extractGanCandidate } from "./gift-card-qr";

describe("extractGanCandidate", () => {
  describe("bare GANs", () => {
    it("accepts a raw GAN with spaces (printed grouping)", () => {
      expect(extractGanCandidate("7783 3200 0000 1234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
    });

    it("accepts dash-grouped and alphanumeric GANs at the 8/20 bounds", () => {
      expect(extractGanCandidate("7783-3200-0000-1234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
      expect(extractGanCandidate("AB12CD34")).toEqual({ kind: "candidate", gan: "AB12CD34" });
      expect(extractGanCandidate("A".repeat(20))).toEqual({
        kind: "candidate",
        gan: "A".repeat(20),
      });
    });

    it("rejects too-short / too-long / non-alnum runs", () => {
      expect(extractGanCandidate("1234567")).toEqual({ kind: "unrecognized" });
      expect(extractGanCandidate("1".repeat(21))).toEqual({ kind: "unrecognized" });
      expect(extractGanCandidate("7783=3200?0000")).toEqual({ kind: "unrecognized" });
    });

    it("accepts the sqgc:// app-QR scheme", () => {
      expect(extractGanCandidate("sqgc://7783320000001234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
    });
  });

  describe("URLs", () => {
    it("takes the lone gan-plausible segment of a squareup.com/gift/... URL", () => {
      expect(extractGanCandidate("https://squareup.com/gift/7783320000001234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
    });

    it("prefers an explicit gan-like query param (gan / gan_id / card)", () => {
      expect(extractGanCandidate("https://square.link/u/abc123?gan=7783320000001234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
      expect(extractGanCandidate("https://squareup.com/gift?gan_id=7783-3200-0000-1234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
      expect(extractGanCandidate("https://example.com/redeem?card=AB12CD34EF56")).toEqual({
        kind: "candidate",
        gan: "AB12CD34EF56",
      });
    });

    it("parses a scheme-less square.link / squareup.com payload", () => {
      expect(extractGanCandidate("square.link/7783320000001234")).toEqual({
        kind: "candidate",
        gan: "7783320000001234",
      });
    });

    it("returns url-unknown when no segment is plausible", () => {
      // "balance" is under 8 chars, the token is over 20 — nothing qualifies.
      expect(
        extractGanCandidate("https://squareup.com/gift/balance/AbCdEfGhIjKlMnOpQrStUvWx"),
      ).toEqual({ kind: "url-unknown" });
      expect(extractGanCandidate("https://squareup.com/giftcards")).toEqual({
        kind: "url-unknown",
      });
    });

    it("returns url-unknown when the segment guess is ambiguous or a param is unreadable", () => {
      expect(extractGanCandidate("https://example.com/AB12CD34EF/7783320000001234")).toEqual({
        kind: "url-unknown",
      });
      expect(extractGanCandidate("https://squareup.com/gift?gan=oops")).toEqual({
        kind: "url-unknown",
      });
    });
  });

  describe("licenses", () => {
    it("flags an AAMVA header line", () => {
      expect(extractGanCandidate("@")).toEqual({ kind: "license" });
      expect(extractGanCandidate("@ANSI 636010090002DL00410269ZF03100075DLDAQ")).toEqual({
        kind: "license",
      });
    });

    it("flags a clipped ANSI line that would otherwise strip to a fake GAN", () => {
      expect(extractGanCandidate("ANSI 636010090002")).toEqual({ kind: "license" });
    });
  });

  describe("everything else", () => {
    it("rejects junk without guessing", () => {
      expect(extractGanCandidate("")).toEqual({ kind: "unrecognized" });
      expect(extractGanCandidate("   ")).toEqual({ kind: "unrecognized" });
      expect(extractGanCandidate("hello")).toEqual({ kind: "unrecognized" });
      expect(extractGanCandidate("sqgc://nope!")).toEqual({ kind: "unrecognized" });
    });
  });
});
