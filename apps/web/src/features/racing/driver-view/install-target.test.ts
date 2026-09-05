import { describe, expect, it } from "vitest";
import { detectInstallTarget, mayPromptToInstall } from "./install-target";

/** Real user-agent strings — the whole point of this module is the ones that lie. */
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ claims to be a Mac. Only the touch points give it away.
  ipadOs:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  macDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("detectInstallTarget", () => {
  it("says nothing once it is already installed", () => {
    expect(detectInstallTarget({ userAgent: UA.iphoneSafari, standalone: true })).toBe("installed");
    // iOS Safari's own flag predates the media query and still ships.
    expect(
      detectInstallTarget({ userAgent: UA.iphoneSafari, standalone: false, iosStandalone: true }),
    ).toBe("installed");
    expect(detectInstallTarget({ userAgent: UA.androidChrome, standalone: true })).toBe(
      "installed",
    );
  });

  it("recognises an iPhone, whatever browser is wrapping it", () => {
    expect(detectInstallTarget({ userAgent: UA.iphoneSafari, standalone: false })).toBe("ios");
    // Chrome on iOS is Safari underneath and has the same Share-sheet flow.
    expect(detectInstallTarget({ userAgent: UA.iphoneChrome, standalone: false })).toBe("ios");
  });

  it("catches an iPad pretending to be a Mac", () => {
    expect(
      detectInstallTarget({ userAgent: UA.ipadOs, standalone: false, maxTouchPoints: 5 }),
    ).toBe("ios");
  });

  it("does not mistake a real Mac for an iPad", () => {
    expect(
      detectInstallTarget({ userAgent: UA.macDesktop, standalone: false, maxTouchPoints: 0 }),
    ).toBe("none");
    expect(detectInstallTarget({ userAgent: UA.ipadOs, standalone: false })).toBe("none");
  });

  it("recognises Android", () => {
    expect(detectInstallTarget({ userAgent: UA.androidChrome, standalone: false })).toBe("android");
    expect(detectInstallTarget({ userAgent: UA.androidFirefox, standalone: false })).toBe(
      "android",
    );
  });

  it("stays quiet on a desktop", () => {
    expect(detectInstallTarget({ userAgent: UA.windows, standalone: false })).toBe("none");
    expect(detectInstallTarget({ userAgent: "", standalone: false })).toBe("none");
  });
});

describe("mayPromptToInstall", () => {
  it("expects a real Install button only on Chromium Android", () => {
    expect(mayPromptToInstall("android", UA.androidChrome)).toBe(true);
  });

  it("does not on Firefox Android — the words have to carry it", () => {
    expect(mayPromptToInstall("android", UA.androidFirefox)).toBe(false);
  });

  it("never on iOS: Apple has never shipped the API", () => {
    expect(mayPromptToInstall("ios", UA.iphoneSafari)).toBe(false);
  });

  it("never when there is nothing to install into", () => {
    expect(mayPromptToInstall("none", UA.windows)).toBe(false);
    expect(mayPromptToInstall("installed", UA.androidChrome)).toBe(false);
  });
});
