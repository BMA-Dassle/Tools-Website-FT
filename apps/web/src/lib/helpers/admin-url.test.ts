import { afterEach, describe, expect, it } from "vitest";
import { adminPublicOrigin, adminToolUrl } from "./admin-url";

const TOKEN = "c".repeat(32);

afterEach(() => {
  delete process.env.ADMIN_PUBLIC_URL;
  delete process.env.ADMIN_CAMERA_TOKEN;
});

describe("adminToolUrl", () => {
  it("builds a clean, credential-free shell URL", () => {
    expect(adminToolUrl("deals")).toBe("https://admin.fasttraxent.com/deals");
    expect(adminToolUrl("camera-assign/blue")).toBe(
      "https://admin.fasttraxent.com/camera-assign/blue",
    );
  });

  it("appends a query and drops empty values", () => {
    expect(adminToolUrl("reservations", { view: "vip" })).toBe(
      "https://admin.fasttraxent.com/reservations?view=vip",
    );
    expect(adminToolUrl("web-sales", { source: "deals", date: "", event: null })).toBe(
      "https://admin.fasttraxent.com/web-sales?source=deals",
    );
    expect(adminToolUrl("pit", {})).toBe("https://admin.fasttraxent.com/pit");
  });

  it("forgives stray slashes on the slug and the origin override", () => {
    process.env.ADMIN_PUBLIC_URL = "http://localhost:3001/";
    expect(adminToolUrl("/pit/")).toBe("http://localhost:3001/pit");
    expect(adminPublicOrigin()).toBe("http://localhost:3001");
  });

  it("NEVER contains the admin token, whatever the env says", () => {
    process.env.ADMIN_CAMERA_TOKEN = TOKEN;
    for (const url of [
      adminToolUrl("deals"),
      adminToolUrl("reservations", { view: "vip" }),
      adminToolUrl(""),
    ]) {
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain("/admin/");
    }
  });

  it("cannot return null — an alert can always render its button", () => {
    // adminBoardUrl() returned null without the token env, so every caller had
    // to handle a missing CTA. This one has nothing to be missing.
    expect(adminToolUrl("deals")).toBeTypeOf("string");
    expect(adminToolUrl("")).toBe("https://admin.fasttraxent.com");
  });
});
