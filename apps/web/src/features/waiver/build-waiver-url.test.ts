/**
 * The waiver URL contract. Every touchpoint — nav, footers, the group-event
 * emails, the confirmation pages — builds its link through buildWaiverUrl, so a
 * defect here is a defect in all of them at once.
 *
 * Each case below is a way a waiver link has gone wrong or could go wrong:
 *   - wrong center      -> a Naples guest's waiver filed at Fort Myers, where it
 *                          is not valid (Naples has its own Pandora location AND
 *                          its own template, contentID 5958737 vs FM 19065376)
 *   - half-set pair     -> looks reservation-scoped, attaches to nothing
 *   - relative in email -> dead link in an inbox
 *   - id through Number -> BMI projectIds exceed MAX_SAFE_INTEGER
 */
import { describe, it, expect } from "vitest";
import { buildWaiverUrl } from "./build-waiver-url";

describe("buildWaiverUrl", () => {
  it("is a bare relative path when nothing is known", () => {
    // The HeadPinz footer renders on both venues and cannot know which — it must
    // land on the picker rather than guess a center.
    expect(buildWaiverUrl()).toBe("/waiver");
    expect(buildWaiverUrl({})).toBe("/waiver");
    expect(buildWaiverUrl({ center: null })).toBe("/waiver");
  });

  it("carries the center when the surface knows it", () => {
    expect(buildWaiverUrl({ center: "fort-myers" })).toBe("/waiver?c=fort-myers");
    expect(buildWaiverUrl({ center: "naples" })).toBe("/waiver?c=naples");
  });

  it("keeps Naples out of Fort Myers", () => {
    // The single most consequential property in this file.
    expect(buildWaiverUrl({ center: "naples" })).not.toContain("fort-myers");
    expect(buildWaiverUrl({ center: "fort-myers" })).not.toContain("naples");
  });

  it("adds loc+pid for a reservation-scoped link", () => {
    const url = buildWaiverUrl({
      center: "fort-myers",
      reservation: { locationId: 467486, projectId: "51383608" },
    });
    expect(url).toBe("/waiver?c=fort-myers&loc=467486&pid=51383608");
  });

  it("refuses a HALF-SET reservation rather than attaching to nothing", () => {
    // A link with loc but no pid reads as reservation-scoped to the guest and
    // attaches to nothing — worse than an honest standalone link.
    expect(
      buildWaiverUrl({ center: "naples", reservation: { locationId: 332145, projectId: "" } }),
    ).toBe("/waiver?c=naples");
    expect(
      buildWaiverUrl({ center: "naples", reservation: { locationId: "", projectId: "999" } }),
    ).toBe("/waiver?c=naples");
    expect(buildWaiverUrl({ center: "naples", reservation: null })).toBe("/waiver?c=naples");
  });

  it("preserves a 17-digit BMI id exactly (never through Number())", () => {
    // 63000000004542824 > Number.MAX_SAFE_INTEGER.
    const big = "63000000004542824";
    const url = buildWaiverUrl({ reservation: { locationId: 332160, projectId: big } });
    expect(url).toContain(`pid=${big}`);
    // Guard against a future refactor that round-trips through a number.
    expect(url).not.toContain("6300000000454282e");
    expect(new URL(url, "https://x").searchParams.get("pid")).toBe(big);
  });

  it("is absolute for email and SMS, with exactly one slash", () => {
    const url = buildWaiverUrl(
      { center: "naples" },
      { absolute: true, origin: "https://headpinz.com" },
    );
    expect(url).toBe("https://headpinz.com/waiver?c=naples");
    // A trailing slash on the origin must not produce "//waiver".
    expect(buildWaiverUrl({}, { absolute: true, origin: "https://headpinz.com/" })).toBe(
      "https://headpinz.com/waiver",
    );
  });

  it("absolute links are a real, parseable URL", () => {
    const url = buildWaiverUrl(
      { center: "fort-myers", reservation: { locationId: 467486, projectId: "51383608" } },
      { absolute: true, origin: "https://fasttraxent.com" },
    );
    const parsed = new URL(url); // throws if relative / malformed
    expect(parsed.pathname).toBe("/waiver");
    expect(parsed.searchParams.get("c")).toBe("fort-myers");
    expect(parsed.searchParams.get("loc")).toBe("467486");
    expect(parsed.searchParams.get("pid")).toBe("51383608");
  });

  it("does not emit an empty query string", () => {
    expect(buildWaiverUrl()).not.toContain("?");
  });
});
