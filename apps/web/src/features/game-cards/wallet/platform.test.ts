import { describe, expect, it } from "vitest";
import { walletPlatformFromUserAgent as detect } from "./platform";

/** Real UA strings — a hand-written approximation is not a test of a sniffer. */
const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadLegacy:
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  ipadOS13Plus:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  gmailProxy: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy",
  bot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

describe("walletPlatformFromUserAgent", () => {
  it("sends iOS devices to Apple Wallet", () => {
    expect(detect(UA.iphone)).toBe("apple");
    expect(detect(UA.ipadLegacy)).toBe("apple");
  });

  it("sends Android to Google Wallet", () => {
    expect(detect(UA.androidChrome)).toBe("google");
    expect(detect(UA.androidSamsung)).toBe("google");
  });

  it("returns null for a Mac — desktop Safari can download a .pkpass but a Mac has no Wallet app", () => {
    // The pass would land in Downloads and do nothing, so offering the QR is
    // strictly more useful than guessing "apple".
    expect(detect(UA.macSafari)).toBeNull();
  });

  it("returns null for desktop, so both buttons and the QR are offered", () => {
    expect(detect(UA.windowsChrome)).toBeNull();
  });

  it("returns null for bots and email proxies rather than serving a pass file", () => {
    expect(detect(UA.bot)).toBeNull();
    expect(detect(UA.gmailProxy)).toBeNull();
  });

  it("returns null for a missing or empty UA instead of throwing", () => {
    expect(detect(null)).toBeNull();
    expect(detect(undefined)).toBeNull();
    expect(detect("")).toBeNull();
  });

  it("prefers Apple when a UA carries both tokens — no iOS device claims Android", () => {
    // Some Android browsers include "like Mac OS X"; testing Apple first is only
    // safe because the reverse never happens.
    expect(detect("Mozilla/5.0 (Linux; Android 14; iPhone-ish like Mac OS X)")).toBe("apple");
    expect(detect(UA.androidChrome)).toBe("google");
  });

  it("KNOWN LIMIT: iPadOS 13+ is indistinguishable from a Mac by UA", () => {
    // Documented, not fixed — it costs an iPad user one extra tap on the landing
    // page, which is the right way to be wrong. Asserted so the behaviour is
    // intentional rather than a surprise later.
    expect(detect(UA.ipadOS13Plus)).toBeNull();
    expect(UA.ipadOS13Plus).toBe(UA.macSafari);
  });

  it("does not match substrings inside unrelated words", () => {
    // Word-boundary anchored: a product name containing "ipad" must not win.
    expect(detect("Mozilla/5.0 (Windows NT 10.0) MyBrowser/1.0 (ipadding-engine)")).toBeNull();
  });
});
