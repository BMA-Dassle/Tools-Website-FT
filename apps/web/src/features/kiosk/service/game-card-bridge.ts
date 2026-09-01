/**
 * Kiosk client shim for ONSITE card-system status.
 *
 * This file used to be the on-prem "game-card bridge" client: a Node process on
 * the kiosk PC that loaded Intercard tokens over a raw EIS TCP socket, with the
 * cloud SOAP path as its fallback. That whole rail is retired — the onsite REST
 * proxy reaches the same site card system and, unlike the EIS socket, also
 * handles bonus cash, clear and consolidate. Loads now go through the server
 * (/api/game-cards/load-card → the Intercard router: onsite first, cloud SOAP
 * fallback), so the kiosk no longer credits anything directly.
 *
 * What remains is the status probe behind the staff chip.
 */

/** What the ONSITE proxy reports for a center (mirror of the server's OnsiteStatus). */
export type OnsiteChipStatus = "onsite" | "offline" | "unlicensed" | "error" | "disabled";

/**
 * Onsite card-system liveness for the GZ status chip.
 *
 * Asks OUR server, which holds the Intercard client token — a credential that
 * must never reach the browser. Never throws: the chip must render something
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
