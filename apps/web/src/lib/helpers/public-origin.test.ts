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

  it("never keeps an admin.* host, even under a brand domain", () => {
    // The SSO staff shell lives at admin.fasttraxent.com. Without this rule the
    // keep-list would hand a guest's phone (VIP voucher QR) or a wall TV an
    // auth-walled origin — lessons.md rule #5, now solved here instead of by
    // banning the subdomain.
    for (const o of [
      "https://admin.fasttraxent.com",
      "https://admin.headpinz.com",
      "http://admin.fasttraxent.com:3001",
    ]) {
      expect(publicOrigin(o), o).toBe("https://headpinz.com");
    }
  });

  it("only excludes an exact `admin` first label", () => {
    // A sibling host that merely starts with "admin" is not the shell.
    expect(publicOrigin("https://admin-preview.headpinz.com")).toBe(
      "https://admin-preview.headpinz.com",
    );
    expect(publicOrigin("https://fasttraxent.com/admin")).toBe("https://fasttraxent.com/admin");
  });

  it("passes through the SSR empty-string placeholder", () => {
    expect(publicOrigin("")).toBe("");
  });
});
