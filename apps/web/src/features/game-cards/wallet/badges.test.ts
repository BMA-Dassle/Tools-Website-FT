import { describe, expect, it } from "vitest";
import { BADGE_HEIGHT, WALLET_BADGES, walletBadgeHref, walletBadgesEmailHtml } from "./badges";

const ORIGIN = "https://headpinz.com";
const REDEEM = "https://headpinz.com/v/HPW4K7M9PQR";

describe("WALLET_BADGES", () => {
  it("ships both platforms exactly once, Apple first", () => {
    expect(WALLET_BADGES.map((b) => b.platform)).toEqual(["apple", "google"]);
  });

  it("keeps the vendors' natural widths — a matched set is 158 beside 181, never equalised", () => {
    // Stretching one badge to match the other is the specific thing both vendors'
    // guidelines forbid, and the widths are what silently drift when this data is
    // copied per-surface. Pinned.
    expect(WALLET_BADGES.find((b) => b.platform === "apple")?.width).toBe(158);
    expect(WALLET_BADGES.find((b) => b.platform === "google")?.width).toBe(181);
    expect(BADGE_HEIGHT).toBe(50);
  });

  it("clears Google's stated 48dp minimum height", () => {
    expect(BADGE_HEIGHT).toBeGreaterThanOrEqual(48);
  });

  it("carries an SVG for pages and a @2x PNG for email — the formats are not interchangeable", () => {
    // Gmail and Outlook do not render SVG in mail; a page that used the raster
    // would ship a blurry badge. Both must exist on every entry.
    for (const b of WALLET_BADGES) {
      expect(b.svg).toMatch(/^\/brand\/wallet\/.+\.svg$/);
      expect(b.png).toMatch(/^\/brand\/wallet\/.+@2x\.png$/);
      expect(b.label).toMatch(/^Add to (Apple|Google) Wallet$/);
    }
  });
});

describe("walletBadgeHref", () => {
  it("points at OUR route with the platform stated, never at PassKit", () => {
    // The route re-checks Neon at tap time and creates the pass on first ask;
    // a PassKit distribution link could do neither.
    expect(walletBadgeHref(REDEEM, "apple")).toBe(`${REDEEM}/wallet?platform=apple`);
    expect(walletBadgeHref(REDEEM, "google")).toBe(`${REDEEM}/wallet?platform=google`);
  });

  it("works for a root-relative redeem URL, as the /v page passes", () => {
    expect(walletBadgeHref("/v/HPW4K7M9PQR", "apple")).toBe("/v/HPW4K7M9PQR/wallet?platform=apple");
  });

  it("does not double the slash when the redeem URL has a trailing one", () => {
    expect(walletBadgeHref(`${REDEEM}/`, "google")).toBe(`${REDEEM}/wallet?platform=google`);
  });
});

describe("walletBadgesEmailHtml", () => {
  const html = walletBadgesEmailHtml({ redeemUrl: REDEEM, origin: ORIGIN });

  it("uses ABSOLUTE image URLs — a mail client has no origin to resolve against", () => {
    expect(html).toContain(`src="${ORIGIN}/brand/wallet/apple-wallet-en@2x.png"`);
    expect(html).toContain(`src="${ORIGIN}/brand/wallet/google-wallet-en@2x.png"`);
    expect(html).not.toMatch(/src="\//);
  });

  it("never emits an SVG into email", () => {
    expect(html).not.toContain(".svg");
  });

  it("links both platforms through our wallet route", () => {
    expect(html).toContain(`href="${REDEEM}/wallet?platform=apple"`);
    expect(html).toContain(`href="${REDEEM}/wallet?platform=google"`);
  });

  it("sets explicit width and height so the @2x raster renders at half size", () => {
    expect(html).toContain('width="158" height="50"');
    expect(html).toContain('width="181" height="50"');
    expect(html).toContain("width:158px;height:50px");
  });

  it("carries the full label in alt, since most clients block images until asked", () => {
    expect(html).toContain('alt="Add to Apple Wallet"');
    expect(html).toContain('alt="Add to Google Wallet"');
  });

  it("wraps the pair in a white table plate by default, for dark cards", () => {
    // A div would work everywhere except Outlook, which ignores padding and
    // border-radius on one — collapsing the plate onto the badges' own edges.
    expect(html).toContain("<table");
    expect(html).toContain("background:#ffffff");
  });

  it("drops the plate on request, for cards that are already light", () => {
    const bare = walletBadgesEmailHtml({ redeemUrl: REDEEM, origin: ORIGIN, panel: false });
    expect(bare).not.toContain("<table");
    expect(bare).not.toContain("background:#ffffff");
    expect(bare).toContain('href="https://headpinz.com/v/HPW4K7M9PQR/wallet?platform=apple"');
  });

  it("centres on request without changing the links", () => {
    const centred = walletBadgesEmailHtml({ redeemUrl: REDEEM, origin: ORIGIN, align: "center" });
    expect(centred).toContain("margin:0 auto");
    expect(centred).toContain(`href="${REDEEM}/wallet?platform=apple"`);
  });

  it("tolerates a trailing slash on the origin without doubling it", () => {
    const out = walletBadgesEmailHtml({ redeemUrl: REDEEM, origin: `${ORIGIN}/` });
    expect(out).toContain(`src="${ORIGIN}/brand/wallet/apple-wallet-en@2x.png"`);
    expect(out).not.toContain("//brand/");
  });

  it("escapes the redeem URL rather than letting it break out of the href attribute", () => {
    const out = walletBadgesEmailHtml({
      redeemUrl: 'https://x.test/v/A"onmouseover="alert(1)',
      origin: ORIGIN,
    });
    expect(out).not.toContain('"onmouseover="');
    expect(out).toContain("&quot;");
  });

  it("emits zero font-size on the container so mail clients add no phantom gap", () => {
    // An inline-block image inherits line-height; without this the white plate
    // grows a few stray pixels under the badges in Gmail.
    expect(html).toContain("font-size:0");
  });
});
