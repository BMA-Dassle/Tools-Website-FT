/**
 * Client shim for the on-prem game-card bridge (game-card-bridge/) running on the
 * kiosk PC. It loads Intercard tokens through the LOCAL EIS server (raw TCP), the
 * immediate path SWFLPassport uses — the cloud SOAP endpoint propagates to the
 * centers too slowly (owner 2026-07-19).
 *
 * The kiosk browser can reach http://127.0.0.1:<port> even from an HTTPS page
 * (localhost is a secure context — Chrome allows it), and the bridge (on the
 * center LAN) reaches 10.x.x.x:3044 that Vercel never could. If the bridge isn't
 * reachable (not a kiosk PC, service down), callers fall back to the cloud path.
 */

const BRIDGE_URL =
  process.env.NEXT_PUBLIC_GAME_CARD_BRIDGE_URL?.replace(/\/$/, "") || "http://127.0.0.1:4599";

/**
 * Local bridge liveness for the GZ status chip: true = the bridge answers on
 * this PC (loads go through the LOCAL card system, instant), false =
 * unreachable (loads ride the cloud path and take longer to hit the floor).
 * Never throws.
 */
export async function bridgeHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Credit tokens onto a card via the on-prem bridge. Returns true ONLY on a
 * confirmed load (bridge → EIS ResponseCode 0). Any failure/unreachable returns
 * false so the caller does the cloud-SOAP fallback — never throws.
 */
export async function creditTokensViaBridge(args: {
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
}): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/credit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return data?.ok === true;
  } catch {
    return false;
  }
}
