import { afterEach, describe, expect, it } from "vitest";
import { adminBoardUrl, renderAdminEmail } from "./admin-email";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("adminBoardUrl", () => {
  it("builds the REAL tokenised board URL", () => {
    // The whole point: the deal-sale alert shipped with a literal
    // "/admin/<token>/deals" placeholder, which is a dead end in an inbox.
    process.env.ADMIN_CAMERA_TOKEN = "tok123";
    process.env.NEXT_PUBLIC_SITE_URL = "https://headpinz.com";
    expect(adminBoardUrl("deals")).toBe("https://headpinz.com/admin/tok123/deals");
  });

  it("points a preview deploy at ITSELF, and tolerates a trailing slash", () => {
    process.env.ADMIN_CAMERA_TOKEN = "tok123";
    process.env.NEXT_PUBLIC_SITE_URL = "https://preview.vercel.app/";
    expect(adminBoardUrl("/deals")).toBe("https://preview.vercel.app/admin/tok123/deals");
  });

  it("is null without a token, so a caller omits the button instead of faking it", () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect(adminBoardUrl("deals")).toBeNull();
  });
});

describe("renderAdminEmail", () => {
  const base = {
    title: "Deal pack sold",
    headlineValue: "$89.00",
    subtitle: "Laser Tag Pack × 2 · HeadPinz Fort Myers",
    rows: [{ label: "Buyer", value: "Ada <Lovelace>" }],
  };

  it("renders a real CTA link when there is a URL", () => {
    const { html, text } = renderAdminEmail({
      ...base,
      cta: { label: "Open the sales board", url: "https://headpinz.com/admin/tok123/deals" },
    });
    expect(html).toContain('href="https://headpinz.com/admin/tok123/deals"');
    expect(text).toContain("Open the sales board: https://headpinz.com/admin/tok123/deals");
  });

  it("omits the CTA entirely when the URL is null — never a placeholder", () => {
    const { html, text } = renderAdminEmail({ ...base, cta: { label: "Open it", url: null } });
    expect(html).not.toContain("Open it");
    expect(text).not.toContain("Open it");
  });

  it("stays inside a phone: one column, 600px cap, no 16px-under body text", () => {
    const { html } = renderAdminEmail({ ...base, cta: null });
    expect(html).toContain("max-width:600px");
    // A fixed pixel width on the outer table is what forces a sideways drag.
    expect(html).toContain('width="100%"');
    expect(html).toContain("font-size:16px");
  });

  it("escapes values — a buyer name is untrusted input", () => {
    const { html } = renderAdminEmail({ ...base, cta: null });
    expect(html).toContain("Ada &lt;Lovelace&gt;");
    expect(html).not.toContain("Ada <Lovelace>");
  });

  it("ships a text alternative carrying the same facts", () => {
    const { text } = renderAdminEmail({ ...base, cta: null });
    expect(text).toContain("Deal pack sold — $89.00");
    expect(text).toContain("Buyer: Ada <Lovelace>");
  });
});
