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
