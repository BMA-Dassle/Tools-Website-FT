import { describe, expect, it } from "vitest";
import {
  applyOskKey,
  layoutForField,
  shouldCapitalize,
  OSK_BACKSPACE,
  OSK_SPACE,
} from "./osk-core";

describe("layoutForField", () => {
  it("maps input types to layouts", () => {
    expect(layoutForField({ type: "email" })).toBe("email");
    expect(layoutForField({ type: "tel" })).toBe("phone");
    expect(layoutForField({ type: "number" })).toBe("numeric");
    expect(layoutForField({ type: "text" })).toBe("qwerty");
    expect(layoutForField({})).toBe("qwerty");
  });

  it("data-osk-layout overrides the type", () => {
    expect(layoutForField({ type: "text", oskLayout: "numeric" })).toBe("numeric");
    expect(layoutForField({ type: "email", oskLayout: "junk" })).toBe("email");
  });
});

describe("applyOskKey", () => {
  it("inserts at the caret", () => {
    expect(applyOskKey("ac", 1, 1, "b")).toEqual({ value: "abc", caret: 2 });
  });

  it("replaces a selection", () => {
    expect(applyOskKey("hello", 1, 4, "u")).toEqual({ value: "huo", caret: 2 });
  });

  it("inserts multi-char keys (.com)", () => {
    expect(applyOskKey("me@site", 7, 7, ".com")).toEqual({ value: "me@site.com", caret: 11 });
  });

  it("space key inserts a space", () => {
    expect(applyOskKey("ab", 2, 2, OSK_SPACE)).toEqual({ value: "ab ", caret: 3 });
  });

  it("backspace deletes before the caret, clamps at 0, eats selections", () => {
    expect(applyOskKey("abc", 2, 2, OSK_BACKSPACE)).toEqual({ value: "ac", caret: 1 });
    expect(applyOskKey("abc", 0, 0, OSK_BACKSPACE)).toEqual({ value: "abc", caret: 0 });
    expect(applyOskKey("abcd", 1, 3, OSK_BACKSPACE)).toEqual({ value: "ad", caret: 1 });
  });

  it("clamps out-of-range selections", () => {
    expect(applyOskKey("ab", 5, 9, "c")).toEqual({ value: "abc", caret: 3 });
  });
});

describe("shouldCapitalize", () => {
  it("caps at start, after space, and when shift is latched", () => {
    expect(shouldCapitalize("", 0, false)).toBe(true);
    expect(shouldCapitalize("sarah ", 6, false)).toBe(true);
    expect(shouldCapitalize("sarah", 5, false)).toBe(false);
    expect(shouldCapitalize("sarah", 5, true)).toBe(true);
  });
});
