import { describe, expect, it } from "vitest";
import {
  FASTTRAX_CENTER_CODE,
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_CODE,
} from "@/lib/qamf-centers";
import { REVIEW_TARGETS, googleReviewUrl, reviewUrlFromTarget } from "./review-links";

describe("reviewUrlFromTarget", () => {
  it("builds the writereview form URL from a place id", () => {
    expect(reviewUrlFromTarget({ placeId: "ChIJabc123" })).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJabc123",
    );
  });

  it("passes a full URL override through verbatim", () => {
    const url = "https://www.google.com/search?q=x&si=BLOB%3D%3D&dpr=1.25";
    expect(reviewUrlFromTarget({ url })).toBe(url);
  });
});

describe("googleReviewUrl", () => {
  it("sends HeadPinz Fort Myers to its own star form", () => {
    // Same place id the /review redirect has always used — asserting it here
    // guards the middleware dedupe against a silent behavior change.
    expect(googleReviewUrl(HEADPINZ_FM_CENTER_CODE)).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJw7rUvBSl3YgRZnV1tR0aK9s",
    );
  });

  it("sends HeadPinz Naples to its own star form", () => {
    expect(googleReviewUrl(HEADPINZ_NAPLES_CENTER_CODE)).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJq6qqNOSi3YgREP2LHBrr1g4",
    );
  });

  it("resolves FastTrax to an absolute Google URL", () => {
    const url = googleReviewUrl(FASTTRAX_CENTER_CODE);
    expect(url).toMatch(/^https:\/\/www\.google\.com\//);
  });

  it("never points two centers at the same destination", () => {
    const urls = Object.keys(REVIEW_TARGETS).map((code) => googleReviewUrl(code));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("fail-closes on an unknown, empty, null, or undefined center code", () => {
    expect(googleReviewUrl("NOT_A_CENTER")).toBeNull();
    expect(googleReviewUrl("")).toBeNull();
    expect(googleReviewUrl(null)).toBeNull();
    expect(googleReviewUrl(undefined)).toBeNull();
  });
});
