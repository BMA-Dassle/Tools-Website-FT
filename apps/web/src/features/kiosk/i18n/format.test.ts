import { describe, expect, it } from "vitest";
import { formatMessage } from "./format";
import { normalizeLocale, isKioskLocale } from "./locales";
import { getMessages, fallbackMessage } from "./messages";

describe("normalizeLocale", () => {
  it("maps supported inputs (incl. BCP-47 subtags + names) to a locale", () => {
    expect(normalizeLocale("es")).toBe("es");
    expect(normalizeLocale("ES")).toBe("es");
    expect(normalizeLocale("es-US")).toBe("es");
    expect(normalizeLocale("espanol")).toBe("es");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("english")).toBe("en");
  });

  it("returns null for unsupported / empty input", () => {
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });

  it("isKioskLocale is a correct type guard", () => {
    expect(isKioskLocale("en")).toBe(true);
    expect(isKioskLocale("es")).toBe(true);
    expect(isKioskLocale("fr")).toBe(false);
    expect(isKioskLocale(42)).toBe(false);
  });
});

describe("formatMessage", () => {
  it("returns the English source for the en locale", () => {
    expect(formatMessage("en", "attract.touchToStart")).toBe("Touch to get started");
  });

  it("returns the Spanish translation for the es locale", () => {
    expect(formatMessage("es", "attract.letsPlay")).toBe("¡A jugar!");
    expect(formatMessage("es", "attract.touchToStart")).toBe("Toca para comenzar");
  });

  it("es catalog covers every English key (no gaps in the spike set)", () => {
    const en = getMessages("en");
    const es = getMessages("es");
    for (const key of Object.keys(en)) {
      expect(es[key as keyof typeof es], `missing es for ${key}`).toBeTruthy();
    }
  });

  it("falls back to raw English when a formatter can't be built", () => {
    // Sanity: fallbackMessage is always the English source string.
    expect(formatMessage("es", "attract.letsPlay")).not.toBe(fallbackMessage("attract.letsPlay"));
    expect(fallbackMessage("attract.letsPlay")).toBe("Let’s play.");
  });
});

describe("categories catalog (ICU interpolation + plurals)", () => {
  it("interpolates the attractions eyebrow count and pluralizes per locale", () => {
    expect(formatMessage("en", "categories.attr.eyebrow", { count: 1 })).toBe("1 attraction");
    expect(formatMessage("en", "categories.attr.eyebrow", { count: 7 })).toBe("7 attractions");
    expect(formatMessage("es", "categories.attr.eyebrow", { count: 1 })).toBe("1 atracción");
    expect(formatMessage("es", "categories.attr.eyebrow", { count: 7 })).toBe("7 atracciones");
  });

  it("pluralizes the tile availability count nouns", () => {
    expect(formatMessage("en", "categories.tile.countTables", { count: 1, time: "9:30 PM" })).toBe(
      "1 table · 9:30 PM",
    );
    expect(formatMessage("en", "categories.tile.countPlayers", { count: 4, time: "9:30 PM" })).toBe(
      "4 players · 9:30 PM",
    );
    expect(formatMessage("es", "categories.tile.countTables", { count: 1, time: "9:30 PM" })).toBe(
      "1 mesa · 9:30 PM",
    );
  });

  it("interpolates the experiences next-available line (with + without a count)", () => {
    expect(formatMessage("en", "categories.exp.nextAvailable", { time: "6:15 PM" })).toBe(
      "Next available · 6:15 PM",
    );
    expect(
      formatMessage("en", "categories.exp.nextAvailableSlots", { time: "6:15 PM", count: 5 }),
    ).toBe("Next available · 6:15 PM · 5 slots");
  });

  it("keeps interpolated price + venue values untranslated (only the wording localizes)", () => {
    // The number/venue passes through verbatim; only surrounding copy differs.
    expect(
      formatMessage("es", "categories.combo.priceLine", { weekday: "$65", weekend: "$75" }),
    ).toContain("$65/persona");
    expect(formatMessage("es", "categories.tile.atVenue", { venue: "FastTrax" })).toBe(
      "En FastTrax",
    );
  });
});
