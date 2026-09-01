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
 * Global load-path override — client mirror of the server INTERCARD_LOAD_MODE
 * (bridge-queue.ts). Only 'cloud' changes client behavior: the kiosk stops
 * dialing the on-prem bridge entirely, so every load rides the cloud SOAP path
 * server-side and the GZ / device checks report Cloud. 'local'/'auto'/unset keep
 * the bridge-first behavior. Keep this value identical to the server var.
 */
function forceCloud(): boolean {
  return (process.env.NEXT_PUBLIC_INTERCARD_LOAD_MODE || "").trim().toLowerCase() === "cloud";
}

/** What the ONSITE proxy reports for a center (mirror of the server's OnsiteStatus). */
export type OnsiteChipStatus = "onsite" | "offline" | "unlicensed" | "error" | "disabled";

/**
 * Onsite card-system liveness for the GZ status chip.
 *
 * Asks OUR server (which holds the Intercard client token — a credential that
 * must never reach the browser), not the on-prem bridge on 127.0.0.1. The old
 * `bridgeHealth` below answers for a DIFFERENT path — the EIS socket, which
 * cannot consolidate or clear — so it says nothing about whether the onsite
 * proxy is serving this center. Never throws: the chip must render something
 * for every failure.
 */
export async function onsiteHealth(locationCode: number): Promise<OnsiteChipStatus> {
  try {
    const res = await fetch(`/api/game-cards/onsite-status?locationCode=${locationCode}`, {
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return "error";
    const data = (await res.json().catch(() => ({}))) as { status?: OnsiteChipStatus };
    return data?.status ?? "error";
  } catch {
    return "error";
  }
}

/**
 * Local bridge liveness for the GZ status chip: true = the bridge answers on
 * this PC (loads go through the LOCAL card system, instant), false =
 * unreachable (loads ride the cloud path and take longer to hit the floor).
 * Never throws.
 */
export async function bridgeHealth(): Promise<boolean> {
  if (forceCloud()) return false; // cloud mode: never claim the local bridge is up
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
  if (forceCloud()) return false; // cloud mode: force the server-side SOAP path (preLoaded:false)
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
