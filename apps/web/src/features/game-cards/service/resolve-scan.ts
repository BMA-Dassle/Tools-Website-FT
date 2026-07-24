/**
 * Resolve a scanned QR/barcode value to a game-card account number, following
 * the Intercard shortlink redirect when the raw payload doesn't carry the id.
 *
 * The 1D barcode (a bare number) and the `swflpassport.com/?id=<n>` QR both
 * decode locally via `cardNumberFromScan`. The current printed-card QR, though,
 * is an Intercard shortlink — `https://icardinc.net/<code>` — that 301s to
 * `https://swflpassport.com/?id=<n>` (→ our middleware → `/reload?id=<n>`). The
 * BROWSER gets the account "for free" by NAVIGATING the QR and landing on the
 * reload page; the in-app camera scanner only ever sees the raw pre-redirect
 * string, so it has to follow that redirect itself. We do it here (server-side —
 * no CORS) and, because a scanned URL is attacker-controllable, only ever fetch
 * a small allowlist of known card hosts and enforce it at EVERY hop (SSRF
 * guard). We also parse each hop before fetching the next, so the id is pulled
 * off `swflpassport.com/?id=` without ever needing to hit the final page.
 */
import { cardNumberFromScan } from "../scan";

/** Hosts we are willing to FETCH while chasing a card redirect (registrable
 *  domain match, incl. subdomains). Anything else is a dead end. */
const RESOLVABLE_HOSTS = ["icardinc.net", "swflpassport.com", "headpinz.com"];

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return RESOLVABLE_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

const MAX_HOPS = 5;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Turn a raw scanned code into an account number, or null if it can't be
 * resolved. `fetchImpl` is injectable for tests; production uses global fetch.
 */
export async function resolveScanToAccount(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  // Fast path: bare number, or a URL that already carries `?id=` (no network).
  const direct = cardNumberFromScan(raw);
  if (direct) return direct;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // not a URL and not a number — nothing to resolve
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.protocol !== "https:" || !hostAllowed(url.hostname)) return null;

    // Parse the CURRENT hop first — `swflpassport.com/?id=<n>` resolves here
    // without needing to fetch the final `/reload` page.
    const parsed = cardNumberFromScan(url.toString());
    if (parsed) return parsed;

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "text/html" },
      });
    } catch {
      return null;
    }

    // Only a redirect carries us forward; anything else is a dead end.
    const loc = res.headers.get("location");
    if (!loc) return null;
    try {
      url = new URL(loc, url); // relative Location resolves against the hop
    } catch {
      return null;
    }
  }
  return null;
}
