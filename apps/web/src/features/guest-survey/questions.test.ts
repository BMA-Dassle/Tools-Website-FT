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
    it("returns [baseline, bowling, fnb_service] regardless of purchases", () => {
      expect(pickTags({ origin: "bowling" })).toEqual(["baseline", "bowling", "fnb_service"]);
    });

    it("ignores purchaseTags for bowling visits (fnb_service wins per policy)", () => {
      expect(
        pickTags({
          origin: "bowling",
          purchaseTags: ["food_drink", "arcade", "gel_blaster"],
        }),
      ).toEqual(["baseline", "bowling", "fnb_service"]);
    });

    it("never exceeds the MAX_TAGS_PER_SURVEY cap", () => {
      const tags = pickTags({ origin: "bowling" });
      expect(tags.length).toBeLessThanOrEqual(MAX_TAGS_PER_SURVEY);
    });
  });

  describe("racing origin", () => {
    it("returns [baseline, racing] when no purchases", () => {
      expect(pickTags({ origin: "racing" })).toEqual(["baseline", "racing"]);
    });

    it("appends the single highest-priority cross-sell tag", () => {
      // priority order: food_drink > arcade > gel_blaster
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["arcade", "gel_blaster"],
        }),
      ).toEqual(["baseline", "racing", "arcade"]);
    });

    it("picks food_drink over arcade when both purchased", () => {
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["arcade", "food_drink"],
        }),
      ).toEqual(["baseline", "racing", "food_drink"]);
    });

    it("never exceeds 3 tags even with all cross-sells purchased", () => {
      const tags = pickTags({
        origin: "racing",
        purchaseTags: ["food_drink", "arcade", "gel_blaster"],
      });
      expect(tags).toHaveLength(3);
      expect(tags).toEqual(["baseline", "racing", "food_drink"]);
    });

    it("ignores non-cross-sell tags in purchaseTags (bowling, fnb_service)", () => {
      // Defensive — these shouldn't appear in racing context, but if they
      // somehow do, they must not displace a legitimate cross-sell tag.
      expect(
        pickTags({
          origin: "racing",
          purchaseTags: ["bowling", "fnb_service", "arcade"],
        }),
      ).toEqual(["baseline", "racing", "arcade"]);
    });

    it("baseline always comes first", () => {
      const tags = pickTags({ origin: "racing", purchaseTags: ["food_drink"] });
      expect(tags[0]).toBe("baseline");
    });
  });
});

describe("pickQuestions", () => {
  it("delegates to getActiveQuestionsForTags with the supplied tags", async () => {
    const q1 = aQuestion({ tag: "baseline", ordinal: 1 });
    const q2 = aQuestion({ tag: "bowling", ordinal: 1 });
    mockedGetActive.mockResolvedValue([q1, q2]);

    const result = await pickQuestions(["baseline", "bowling"]);

    expect(mockedGetActive).toHaveBeenCalledWith(["baseline", "bowling"]);
    expect(result).toEqual([q1, q2]);
  });

  it("returns an empty array for an empty tag list without hitting the DB", async () => {
    await expect(pickQuestions([])).resolves.toEqual([]);
    expect(mockedGetActive).not.toHaveBeenCalled();
  });
});
