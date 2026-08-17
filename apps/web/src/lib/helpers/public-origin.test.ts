import { describe, expect, it } from "vitest";
import { publicOrigin } from "./public-origin";

describe("publicOrigin", () => {
  it("keeps brand-domain origins (behavior identical to pre-helper code)", () => {
    for (const o of [
      "https://fasttraxent.com",
      "https://www.fasttraxent.com",
      "https://headpinz.com",
      "https://www.headpinz.com",
    ]) {
      expect(publicOrigin(o), o).toBe(o);
    }
  });

  it("keeps localhost so dev QRs scan against the dev server", () => {
    expect(publicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(publicOrigin("http://127.0.0.1:3111")).toBe("http://127.0.0.1:3111");
  });

  it("falls back to the public site on any auth-walled or unknown host", () => {
    for (const o of ["https://ft-admin.vercel.app", "https://tools-website-ft-abc123.vercel.app"]) {
      expect(publicOrigin(o), o).toBe("https://headpinz.com");
    }
    // Lookalike domains don't count as brand domains.
    expect(publicOrigin("https://notfasttraxent.com")).toBe("https://headpinz.com");
  });

  it("passes through the SSR empty-string placeholder", () => {
    expect(publicOrigin("")).toBe("");
  });
});
