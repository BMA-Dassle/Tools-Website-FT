import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_API_TOKEN_TTL_MS, mintAdminApiToken, verifyAdminApiToken } from "./admin-api-token";

const SECRET = "s".repeat(32);
const CAMERA = "c".repeat(32);

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({ ADMIN_API_SIGNING_SECRET: SECRET, ADMIN_CAMERA_TOKEN: undefined });
});

afterEach(() => {
  vi.useRealTimers();
  setEnv({ ADMIN_API_SIGNING_SECRET: undefined, ADMIN_CAMERA_TOKEN: undefined });
});

describe("mintAdminApiToken", () => {
  it("mints <expMs>.<64 hex> and defaults to an 8h shift", async () => {
    const before = Date.now();
    const token = await mintAdminApiToken();
    const [exp, sig] = token.split(".");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(exp)).toBeGreaterThanOrEqual(before + ADMIN_API_TOKEN_TTL_MS);
    expect(ADMIN_API_TOKEN_TTL_MS).toBe(8 * 60 * 60 * 1000);
  });

  it("honours an explicit ttl", async () => {
    const token = await mintAdminApiToken(60_000);
    expect(Number(token.split(".")[0]) - Date.now()).toBeLessThanOrEqual(60_000);
    await expect(verifyAdminApiToken(token)).resolves.toBe(true);
  });

  it("contains neither the signing secret nor the static token", async () => {
    setEnv({ ADMIN_CAMERA_TOKEN: CAMERA });
    const token = await mintAdminApiToken();
    expect(token).not.toContain(SECRET);
    expect(token).not.toContain(CAMERA);
  });

  it("returns empty when no secret is configured at all", async () => {
    setEnv({ ADMIN_API_SIGNING_SECRET: undefined });
    await expect(mintAdminApiToken()).resolves.toBe("");
  });
});

describe("verifyAdminApiToken", () => {
  it("accepts a freshly minted token", async () => {
    await expect(verifyAdminApiToken(await mintAdminApiToken())).resolves.toBe(true);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const token = await mintAdminApiToken(1000);
    vi.setSystemTime(new Date("2026-08-28T12:00:02Z"));
    await expect(verifyAdminApiToken(token)).resolves.toBe(false);
  });

  it("rejects a tampered expiry — the expiry IS the signed message", async () => {
    const token = await mintAdminApiToken(1000);
    const sig = token.split(".")[1];
    const stretched = `${Date.now() + 10 * 365 * 24 * 3600_000}.${sig}`;
    await expect(verifyAdminApiToken(stretched)).resolves.toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const [exp, sig] = (await mintAdminApiToken()).split(".");
    const flipped = sig[0] === "0" ? `1${sig.slice(1)}` : `0${sig.slice(1)}`;
    await expect(verifyAdminApiToken(`${exp}.${flipped}`)).resolves.toBe(false);
  });

  it("rejects a token minted with a different secret", async () => {
    const token = await mintAdminApiToken();
    setEnv({ ADMIN_API_SIGNING_SECRET: "other-secret" });
    await expect(verifyAdminApiToken(token)).resolves.toBe(false);
  });

  it("rejects malformed shapes and the static token itself", async () => {
    setEnv({ ADMIN_CAMERA_TOKEN: CAMERA });
    for (const bad of [
      "",
      null,
      undefined,
      CAMERA,
      "notanumber.deadbeef",
      `${Date.now() + 1000}`,
      `${Date.now() + 1000}.`,
      `.${"a".repeat(64)}`,
      `-1.${"a".repeat(64)}`,
      `${Date.now() + 1000}.NOTHEX`,
    ]) {
      await expect(
        verifyAdminApiToken(bad as string | null | undefined),
        String(bad),
      ).resolves.toBe(false);
    }
  });

  it("falls back to ADMIN_CAMERA_TOKEN as the signing key so no env change is required to ship", async () => {
    setEnv({ ADMIN_API_SIGNING_SECRET: undefined, ADMIN_CAMERA_TOKEN: CAMERA });
    const token = await mintAdminApiToken();
    expect(token).not.toBe("");
    await expect(verifyAdminApiToken(token)).resolves.toBe(true);
    // …and a dedicated secret takes precedence once it exists.
    setEnv({ ADMIN_API_SIGNING_SECRET: SECRET });
    await expect(verifyAdminApiToken(token)).resolves.toBe(false);
  });

  it("verifies false when nothing is configured", async () => {
    const token = await mintAdminApiToken();
    setEnv({ ADMIN_API_SIGNING_SECRET: undefined, ADMIN_CAMERA_TOKEN: undefined });
    await expect(verifyAdminApiToken(token)).resolves.toBe(false);
  });

  it("uses only Web Crypto so it runs in the edge middleware", async () => {
    // A regression pin: importing node:crypto here would typecheck and pass
    // locally, then fail at the edge. The module text is the cheapest proof.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./admin-api-token.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/from "node:crypto"|require\("crypto"\)/);
    expect(src).toContain("crypto.subtle");
  });
});
