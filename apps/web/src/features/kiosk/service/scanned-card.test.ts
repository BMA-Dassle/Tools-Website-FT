import { afterEach, describe, expect, it, vi } from "vitest";
import { accountFromScan } from "./scanned-card";

/** A fetch that answers /api/game-cards/resolve-scan with a fixed body. */
function resolver(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("accountFromScan", () => {
  it("decodes the 1D barcode locally — no network", async () => {
    // The barcode on the card IS the account, zero-padded to 16.
    const f = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);
    expect(await accountFromScan("0000000001038115")).toBe("1038115");
    expect(f).not.toHaveBeenCalled();
  });

  it("decodes an ?id= QR locally — no network", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);
    expect(await accountFromScan("https://swflpassport.com/?id=1038115")).toBe("1038115");
    expect(f).not.toHaveBeenCalled();
  });

  it("follows an Intercard SHORTLINK through the server (the reported bug)", async () => {
    // `icardinc.net/<code>` carries no number at all. Before this, the whole
    // URL was used as the account and /verify refused it, so a good card read
    // as "we couldn't check that card".
    const f = resolver({ accountNumber: "1038115" });
    vi.stubGlobal("fetch", f);
    expect(await accountFromScan("https://icardinc.net/0U7H0XFY8MS58J3UZM")).toBe("1038115");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns null for a payload that is not a card, without calling the server", async () => {
    // A voucher code or a promo scanned here is simply not ours — the caller
    // leaves it to whoever else is listening.
    const f = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);
    expect(await accountFromScan("HPW4K7M9PQR")).toBeNull();
    expect(await accountFromScan("https://evil.example.com/x")).toBeNull();
    expect(await accountFromScan("")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null when the server cannot resolve the shortlink", async () => {
    vi.stubGlobal("fetch", resolver({ accountNumber: null }));
    expect(await accountFromScan("https://icardinc.net/abc")).toBeNull();
  });

  it("returns null on a non-numeric account and on a transport failure", async () => {
    vi.stubGlobal("fetch", resolver({ accountNumber: "not-a-number" }));
    expect(await accountFromScan("https://icardinc.net/abc")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    expect(await accountFromScan("https://icardinc.net/abc")).toBeNull();
  });
});
