import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin } from "./public-origin";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ADMIN_PUBLIC_ORIGIN;
});

describe("publicOrigin", () => {
  it("is the identity function when the var is unset (main project)", () => {
    expect(publicOrigin("https://fasttraxent.com")).toBe("https://fasttraxent.com");
    expect(publicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("overrides with the public site origin when set (admin project)", () => {
    process.env.NEXT_PUBLIC_ADMIN_PUBLIC_ORIGIN = "https://headpinz.com";
    expect(publicOrigin("https://ft-admin.vercel.app")).toBe("https://headpinz.com");
  });

  it("treats an empty var as unset", () => {
    process.env.NEXT_PUBLIC_ADMIN_PUBLIC_ORIGIN = "";
    expect(publicOrigin("https://fasttraxent.com")).toBe("https://fasttraxent.com");
  });
});
