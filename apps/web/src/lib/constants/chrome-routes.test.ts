import { describe, it, expect } from "vitest";
import { SERVICE_NOTICE_PATH } from "~/features/maintenance";
import {
  chromeFlagsForPath,
  isAdminPath,
  isChromeFreePath,
  isHeadPinzSplashPath,
  isKioskPath,
  isMobileBarFreePath,
} from "./chrome-routes";

describe("isChromeFreePath", () => {
  it("covers the focused screens that render their own header", () => {
    for (const p of [
      "/waiver",
      "/waiver/",
      "/waiver/thanks",
      "/join",
      "/join/ABC123",
      "/july4",
      "/r/xyz789",
      "/passes/abc",
      "/kiosk",
      "/kiosk/waiver",
      "/kart",
      "/kart/15",
    ]) {
      expect(isChromeFreePath(p), p).toBe(true);
    }
  });

  it("leaves the marketing site alone", () => {
    for (const p of [
      "/",
      "/pricing",
      "/racing",
      "/rewards",
      "/reload",
      "/cards",
      "/racer",
      // A finished race report is a page someone lands on from a text and may
      // want to book from — it KEEPS the nav, unlike the live /kart screens.
      "/race/58691643",
      "/race/58691643/15",
      "/waiver-3",
      "/book",
      "/book/race",
      "/hp/fort-myers",
    ]) {
      expect(isChromeFreePath(p), p).toBe(false);
    }
  });

  it("does not let a bare prefix swallow its siblings", () => {
    // The trap the middleware comments call out: startsWith("/r") would eat
    // /racing, /rewards and /reload; startsWith("/w") would eat /waiver-3.
    expect(isChromeFreePath("/racing")).toBe(false);
    expect(isChromeFreePath("/rewards")).toBe(false);
    expect(isChromeFreePath("/waiver-3")).toBe(false);
    expect(isChromeFreePath("/joinery")).toBe(false);
    // startsWith("/kart") must not swallow the report routes, and a bare
    // startsWith("/ka") would eat nothing today but is the same trap.
    expect(isChromeFreePath("/karting")).toBe(false);
    expect(isChromeFreePath("/race/1/2")).toBe(false);
  });
});

describe("isMobileBarFreePath", () => {
  it("covers every screen the two host branches used to name separately", () => {
    for (const p of [
      "/survey/tok",
      "/contract/abc",
      "/event/summer",
      "/account",
      "/account/subscriptions",
      "/t/123",
      "/g/456",
      "/v/code",
      "/racer",
      "/racer/find",
      "/book/confirmation",
      "/book/checkout/confirmation",
      "/book/race/confirmation",
      "/book/bowling/confirmation",
      "/book/confirmation/",
    ]) {
      expect(isMobileBarFreePath(p), p).toBe(true);
    }
  });

  it("is pinned to the real outage-notice path", () => {
    expect(isMobileBarFreePath(SERVICE_NOTICE_PATH)).toBe(true);
    expect(SERVICE_NOTICE_PATH).toBe("/service-notice");
  });

  it("leaves ordinary pages with their bar", () => {
    for (const p of ["/", "/pricing", "/book", "/book/race", "/attractions", "/hp/naples"]) {
      expect(isMobileBarFreePath(p), p).toBe(false);
    }
  });

  it("does not treat a confirmation-ish word as a confirmation segment", () => {
    expect(isMobileBarFreePath("/book/bowling-confirmation")).toBe(false);
  });
});

describe("isAdminPath / isKioskPath / isHeadPinzSplashPath", () => {
  it("matches the segment, not a prefix", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/sales")).toBe(true);
    expect(isAdminPath("/administrivia")).toBe(false);
    expect(isKioskPath("/kiosk/admin")).toBe(true);
    expect(isKioskPath("/kiosks")).toBe(false);
    expect(isHeadPinzSplashPath("/")).toBe(true);
    expect(isHeadPinzSplashPath("/hp")).toBe(true);
    expect(isHeadPinzSplashPath("/hp/fort-myers")).toBe(false);
  });
});

describe("chromeFlagsForPath", () => {
  it("gives a FastTrax marketing page the full set", () => {
    expect(chromeFlagsForPath("/pricing", "fasttrax")).toEqual({
      brand: "fasttrax",
      ftChrome: true,
      hpChrome: false,
      ftMobileBar: true,
      hpMobileBar: false,
      carts: true,
    });
  });

  it("strips the nav on /waiver — the bug this registry exists for", () => {
    const flags = chromeFlagsForPath("/waiver", "fasttrax");
    expect(flags.ftChrome).toBe(false);
    expect(flags.ftMobileBar).toBe(false);
    expect(flags.hpChrome).toBe(false);
  });

  it("strips it on the HeadPinz host too", () => {
    const flags = chromeFlagsForPath("/waiver", "headpinz");
    expect(flags.hpChrome).toBe(false);
    expect(flags.hpMobileBar).toBe(false);
    expect(flags.ftChrome).toBe(false);
  });

  it("keeps the nav but drops the bar on a confirmation, on BOTH brands", () => {
    const ft = chromeFlagsForPath("/book/confirmation", "fasttrax");
    expect(ft.ftChrome).toBe(true);
    expect(ft.ftMobileBar).toBe(false);
    const hp = chromeFlagsForPath("/book/confirmation", "headpinz");
    expect(hp.hpChrome).toBe(true);
    expect(hp.hpMobileBar).toBe(false);
  });

  it("suppresses HeadPinz chrome on the location-chooser splash only", () => {
    expect(chromeFlagsForPath("/", "headpinz").hpChrome).toBe(false);
    expect(chromeFlagsForPath("/fort-myers", "headpinz").hpChrome).toBe(true);
    // The same path on the FastTrax host is the FastTrax home page.
    expect(chromeFlagsForPath("/", "fasttrax").ftChrome).toBe(true);
  });

  it("gives admin and kiosk no chrome and no carts", () => {
    const admin = chromeFlagsForPath("/admin/sales", "fasttrax");
    expect(admin.ftChrome).toBe(false);
    expect(admin.carts).toBe(false);
    const kiosk = chromeFlagsForPath("/kiosk/book", "headpinz");
    expect(kiosk.hpChrome).toBe(false);
    expect(kiosk.carts).toBe(false);
  });
});
