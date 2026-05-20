import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getActiveQuestionsForTags: vi.fn(),
}));

import { getActiveQuestionsForTags } from "@/lib/guest-survey-db";
import { aQuestion } from "~/test/builders/survey";
import { MAX_TAGS_PER_SURVEY, pickQuestions, pickTags } from "./questions";

const mockedGetActive = vi.mocked(getActiveQuestionsForTags);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickTags", () => {
  describe("bowling origin", () => {
    it("returns [baseline, bowling, fnb_service, closing] regardless of purchases", () => {
      expect(pickTags({ origin: "bowling" })).toEqual([
        "baseline",
        "bowling",
        "fnb_service",
        "closing",
      ]);
    });

    it("ignores purchaseTags for bowling visits (fnb_service wins per policy)", () => {
      expect(
        pickTags({
          origin: "bowling",
          purchaseTags: ["food_drink", "arcade", "gel_blaster"],
        }),
      ).toEqual(["baseline", "bowling", "fnb_service", "closing"]);
    });

    it("never exceeds the MAX_TAGS_PER_SURVEY cap", () => {
      const tags = pickTags({ origin: "bowling" });
      expect(tags.length).toBeLessThanOrEqual(MAX_TAGS_PER_SURVEY);
    });
  });

  describe("racing origin", () => {
    it("returns [baseline, racing, closing] when no purchases", () => {
      expect(pickTags({ origin: "racing" })).toEqual(["baseline", "racing", "closing"]);
    });

    it("appends the single highest-priority cross-sell tag BEFORE closing", () => {
      // priority order: food_drink > arcade > gel_blaster
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["arcade", "gel_blaster"],
        }),
      ).toEqual(["baseline", "racing", "arcade", "closing"]);
    });

    it("picks food_drink over arcade when both purchased", () => {
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["arcade", "food_drink"],
        }),
      ).toEqual(["baseline", "racing", "food_drink", "closing"]);
    });

    it("never exceeds 4 tags even with all cross-sells purchased", () => {
      const tags = pickTags({
        origin: "racing",
        purchaseTags: ["food_drink", "arcade", "gel_blaster"],
      });
      expect(tags).toHaveLength(4);
      expect(tags).toEqual(["baseline", "racing", "food_drink", "closing"]);
    });

    it("ignores non-cross-sell tags in purchaseTags (bowling, fnb_service)", () => {
      // Defensive — these shouldn't appear in racing context, but if they
      // somehow do, they must not displace a legitimate cross-sell tag.
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["bowling", "fnb_service", "arcade"],
        }),
      ).toEqual(["baseline", "racing", "arcade", "closing"]);
    });

    it("baseline always comes first, closing always comes last", () => {
      const tags = pickTags({ origin: "racing", purchaseTags: ["food_drink"] });
      expect(tags[0]).toBe("baseline");
      expect(tags[tags.length - 1]).toBe("closing");
    });
  });
});

describe("pickQuestions", () => {
  it("returns an empty array for an empty tag list without hitting the DB", async () => {
    await expect(pickQuestions([])).resolves.toEqual([]);
    expect(mockedGetActive).not.toHaveBeenCalled();
  });

  it("delegates to getActiveQuestionsForTags with the supplied tags", async () => {
    const q1 = aQuestion({ tag: "baseline", ordinal: 1 });
    const q2 = aQuestion({ tag: "bowling", ordinal: 1 });
    mockedGetActive.mockResolvedValue([q1, q2]);

    const result = await pickQuestions(["baseline", "bowling"]);

    expect(mockedGetActive).toHaveBeenCalledWith(["baseline", "bowling"]);
    // Both fall within TAG_PRIORITY (baseline=1, bowling=2) so the natural
    // order is preserved.
    expect(result).toEqual([q1, q2]);
  });

  it("re-sorts so closing renders LAST even when the DB returns it first", async () => {
    // Simulate the DB returning rows in alphabetical tag order (default
    // SQL ORDER BY). 'closing' would sort BEFORE 'racing' alphabetically;
    // the picker must override that.
    const closing1 = aQuestion({ id: 100, tag: "closing", ordinal: 1 });
    const racing1 = aQuestion({ id: 200, tag: "racing", ordinal: 1 });
    const baseline1 = aQuestion({ id: 300, tag: "baseline", ordinal: 1 });
    mockedGetActive.mockResolvedValue([baseline1, closing1, racing1]);

    const result = await pickQuestions(["baseline", "racing", "closing"]);
    expect(result.map((q) => q.tag)).toEqual(["baseline", "racing", "closing"]);
  });

  it("orders fnb_service before food_drink for bowling visits", async () => {
    // fnb_service priority=3, food_drink priority=4 — fnb wins.
    const fd = aQuestion({ id: 1, tag: "food_drink", ordinal: 1 });
    const fnb = aQuestion({ id: 2, tag: "fnb_service", ordinal: 1 });
    mockedGetActive.mockResolvedValue([fd, fnb]);
    const result = await pickQuestions(["food_drink", "fnb_service"]);
    expect(result.map((q) => q.tag)).toEqual(["fnb_service", "food_drink"]);
  });

  it("sorts within a tag by ordinal then id", async () => {
    const a = aQuestion({ id: 30, tag: "baseline", ordinal: 1 });
    const b = aQuestion({ id: 20, tag: "baseline", ordinal: 1 });
    const c = aQuestion({ id: 10, tag: "baseline", ordinal: 2 });
    mockedGetActive.mockResolvedValue([c, a, b]);
    const result = await pickQuestions(["baseline"]);
    expect(result.map((q) => q.id)).toEqual([20, 30, 10]);
  });
});
