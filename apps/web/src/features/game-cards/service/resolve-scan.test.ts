import { describe, expect, it, vi } from "vitest";
import { resolveScanToAccount } from "./resolve-scan";

/** Build a fake fetch that returns a 301 → Location for each mapped URL. */
function redirector(map: Record<string, string>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const location = map[url];
    const headers = new Headers();
    if (location) headers.set("location", location);
    return new Response(null, { status: location ? 301 : 404, headers });
  }) as unknown as typeof fetch;
}

describe("resolveScanToAccount", () => {
  it("returns the account directly for a bare number (no network)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await resolveScanToAccount("0000000001038115", fetchImpl)).toBe("1038115");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the account directly for a ?id= URL (no network)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await resolveScanToAccount("https://swflpassport.com/?id=1038115", fetchImpl)).toBe(
      "1038115",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows an icardinc.net shortlink to swflpassport.com/?id=", async () => {
    const fetchImpl = redirector({
      "https://icardinc.net/0U7H0XFY8MS58J3UZM": "https://swflpassport.com/?id=1038115",
    });
    expect(await resolveScanToAccount("https://icardinc.net/0U7H0XFY8MS58J3UZM", fetchImpl)).toBe(
      "1038115",
    );
    // Only the shortlink hop is fetched — the id is parsed off swflpassport.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a multi-hop chain that ends at headpinz.com/reload?id=", async () => {
    const fetchImpl = redirector({
      "https://icardinc.net/abc": "https://swflpassport.com/go/9",
      "https://swflpassport.com/go/9": "https://headpinz.com/reload?id=1038115",
    });
    expect(await resolveScanToAccount("https://icardinc.net/abc", fetchImpl)).toBe("1038115");
  });

  it("refuses to fetch a non-allowlisted host (SSRF guard)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await resolveScanToAccount("https://evil.example.com/x", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops if a redirect leaves the allowlist mid-chain", async () => {
    const fetchImpl = redirector({
      "https://icardinc.net/x": "https://169.254.169.254/latest/meta-data",
    });
    expect(await resolveScanToAccount("https://icardinc.net/x", fetchImpl)).toBeNull();
    // The shortlink is fetched once; the internal-IP target is never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-https and non-URL payloads", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await resolveScanToAccount("http://icardinc.net/x", fetchImpl)).toBeNull();
    expect(await resolveScanToAccount("hello", fetchImpl)).toBeNull();
    expect(await resolveScanToAccount("", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a redirect loop without hanging", async () => {
    const fetchImpl = redirector({
      "https://icardinc.net/a": "https://icardinc.net/b",
      "https://icardinc.net/b": "https://icardinc.net/a",
    });
    expect(await resolveScanToAccount("https://icardinc.net/a", fetchImpl)).toBeNull();
  });
});
