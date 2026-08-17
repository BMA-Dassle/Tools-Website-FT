import { describe, expect, it } from "vitest";
import { planCacheOps, retypeForPlayback } from "./video-cache";

/**
 * The cache POLICY, tested without a browser. The Cache Storage calls themselves
 * are thin wrappers that swallow; this is the part with a decision in it.
 */
const STARTER_V1 = "https://blob.test/briefing/starter-aaa.mp4";
const STARTER_V2 = "https://blob.test/briefing/starter-bbb.mp4";
const INTER = "https://blob.test/briefing/intermediate-ccc.mp4";
const POSTER = "https://blob.test/briefing/helmet-ddd.png";

describe("planCacheOps", () => {
  it("fetches everything on a cold player", () => {
    const plan = planCacheOps([], [STARTER_V1, INTER, POSTER]);
    expect(plan.fetch.sort()).toEqual([INTER, POSTER, STARTER_V1].sort());
    expect(plan.drop).toEqual([]);
  });

  it("does nothing when the player already holds the manifest", () => {
    const plan = planCacheOps([STARTER_V1, INTER, POSTER], [STARTER_V1, INTER, POSTER]);
    expect(plan.fetch).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it("a REPLACED film is a new URL: fetch the new one, drop the old", () => {
    // This is the whole invalidation strategy — uploads carry a random suffix, so
    // "has this changed?" is string equality and no hashing is needed.
    const plan = planCacheOps([STARTER_V1, INTER], [STARTER_V2, INTER]);
    expect(plan.fetch).toEqual([STARTER_V2]);
    expect(plan.drop).toEqual([STARTER_V1]);
  });

  it("drops films the manifest no longer references at all", () => {
    // Superseded briefing videos are hundreds of megabytes each; keeping them
    // "just in case" fills a player's disk over a season of re-uploads.
    const plan = planCacheOps([STARTER_V1, INTER], [INTER]);
    expect(plan.drop).toEqual([STARTER_V1]);
    expect(plan.fetch).toEqual([]);
  });

  it("ignores empty manifest slots rather than trying to fetch them", () => {
    const plan = planCacheOps([], [STARTER_V1, null, undefined, ""]);
    expect(plan.fetch).toEqual([STARTER_V1]);
  });

  it("clears the cache when the manifest is empty", () => {
    const plan = planCacheOps([STARTER_V1, POSTER], []);
    expect(plan.drop.sort()).toEqual([POSTER, STARTER_V1].sort());
    expect(plan.fetch).toEqual([]);
  });

  it("de-duplicates a URL listed twice in the manifest", () => {
    // Both tiers pointing at the same film is legitimate (one video, two slots)
    // and must not queue two downloads of it.
    const plan = planCacheOps([], [STARTER_V1, STARTER_V1]);
    expect(plan.fetch).toEqual([STARTER_V1]);
  });

  it("names exactly the adopted object URLs safe to revoke on an idle sync", () => {
    // The adoption ledger reuses this same policy: feeding it the ADOPTED urls
    // instead of the cached ones, `drop` is precisely the set whose object URLs
    // a superseding upload has stranded — and nothing a current manifest (and
    // therefore possibly a playing briefing) still points at.
    const idle = planCacheOps([STARTER_V1, INTER, POSTER], [STARTER_V2, INTER, POSTER]);
    expect(idle.drop).toEqual([STARTER_V1]);

    const unchanged = planCacheOps([STARTER_V2, INTER, POSTER], [STARTER_V2, INTER, POSTER]);
    expect(unchanged.drop).toEqual([]);

    const emptied = planCacheOps([STARTER_V2, INTER], []);
    expect(emptied.drop.sort()).toEqual([INTER, STARTER_V2].sort());
  });
});

describe("retypeForPlayback", () => {
  it("re-types a non-mp4 video blob as video/mp4 without changing its bytes", () => {
    // The .mov rescue: Chromium refuses video/quicktime as media even though the
    // bytes are H.264 in an ISO container the MP4 demuxer reads happily.
    const mov = new Blob(["not-really-video-bytes"], { type: "video/quicktime" });
    const typed = retypeForPlayback(mov);
    expect(typed.type).toBe("video/mp4");
    expect(typed.size).toBe(mov.size);
  });

  it("returns an mp4 blob unchanged", () => {
    const mp4 = new Blob(["bytes"], { type: "video/mp4" });
    expect(retypeForPlayback(mp4)).toBe(mp4);
  });

  it("leaves non-video blobs alone (the helmet poster rides the same cache)", () => {
    const png = new Blob(["png-bytes"], { type: "image/png" });
    expect(retypeForPlayback(png)).toBe(png);
    const untyped = new Blob(["mystery"]);
    expect(retypeForPlayback(untyped)).toBe(untyped);
  });
});
