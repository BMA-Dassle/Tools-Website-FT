import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("kiosk bridge shim — NEXT_PUBLIC_INTERCARD_LOAD_MODE", () => {
  it("cloud mode: bridgeHealth returns false and never dials the bridge", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_INTERCARD_LOAD_MODE", "cloud");
    const { bridgeHealth } = await import("./game-card-bridge");
    expect(await bridgeHealth()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cloud mode: creditTokensViaBridge returns false (→ server SOAP) without dialing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_INTERCARD_LOAD_MODE", "CLOUD"); // case-insensitive
    const { creditTokensViaBridge } = await import("./game-card-bridge");
    expect(
      await creditTokensViaBridge({ accountNumber: "1062056", tokens: 500, bonusTokens: 0 }),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unset/local mode: still attempts the on-prem bridge", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_INTERCARD_LOAD_MODE", "");
    const { bridgeHealth } = await import("./game-card-bridge");
    expect(await bridgeHealth()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
