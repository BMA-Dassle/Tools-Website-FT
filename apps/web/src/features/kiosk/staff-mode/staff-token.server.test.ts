import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STAFF_TOKEN_TTL_MS, mintStaffToken, verifyStaffToken } from "./staff-token.server";

const sam = { id: "465243", name: "Sam Ortiz", role: "Manager", cardTail: "3464" };

describe("staff token", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.KIOSK_STAFF_SIGNING_SECRET = "test-secret";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("round-trips the employee", () => {
    const tok = mintStaffToken(sam, STAFF_TOKEN_TTL_MS, 1_000_000);
    expect(tok.split(".")).toHaveLength(3);
    expect(verifyStaffToken(tok, 1_000_001)).toEqual(sam);
  });

  it("expires", () => {
    const tok = mintStaffToken(sam, 1_000, 1_000_000);
    expect(verifyStaffToken(tok, 1_000_999)).toEqual(sam);
    expect(verifyStaffToken(tok, 1_001_000)).toBeNull();
  });

  it("rejects a moved expiry, a tampered payload and a bad signature", () => {
    const tok = mintStaffToken(sam, 1_000, 1_000_000);
    const [exp, payload, sig] = tok.split(".");
    expect(verifyStaffToken(`${Number(exp) + 60_000}.${payload}.${sig}`, 1_000_001)).toBeNull();
    const other = Buffer.from(JSON.stringify({ ...sam, id: "1" })).toString("base64url");
    expect(verifyStaffToken(`${exp}.${other}.${sig}`, 1_000_001)).toBeNull();
    expect(verifyStaffToken(`${exp}.${payload}.${"0".repeat(sig.length)}`, 1_000_001)).toBeNull();
    expect(verifyStaffToken("garbage", 1_000_001)).toBeNull();
    expect(verifyStaffToken("", 1_000_001)).toBeNull();
  });

  it("with no secret there are no tokens, in either direction", () => {
    delete process.env.KIOSK_STAFF_SIGNING_SECRET;
    delete process.env.ADMIN_API_SIGNING_SECRET;
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect(mintStaffToken(sam)).toBe("");
    process.env.KIOSK_STAFF_SIGNING_SECRET = "test-secret";
    const tok = mintStaffToken(sam);
    delete process.env.KIOSK_STAFF_SIGNING_SECRET;
    expect(verifyStaffToken(tok)).toBeNull();
  });
});
