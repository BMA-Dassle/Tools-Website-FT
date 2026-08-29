/**
 * Turn a SCANNED payload from the back of a Game Zone card into an account
 * number, on the kiosk.
 *
 * A card carries two printed codes and the kiosk's scanners can return either:
 *  - the 1D barcode — the straight account number, zero-padded to 16
 *  - the QR — a web redirect. Current stock encodes an Intercard SHORTLINK
 *    (`icardinc.net/<code>`) that reveals nothing until it is followed.
 *
 * `cardNumberFromScan` decodes everything decidable locally (bare number, an
 * `?id=` URL). The shortlink is the case it cannot do, and until now the kiosk
 * had no answer for it: the classifier hands a shortlink through as
 * `{ kind: "game-card", value: <the whole URL> }`, that URL was used as the
 * account number, and `/api/game-cards/verify` refuses it (the schema is digits
 * only) — so a scanned card read as "we couldn't check that card" (owner
 * 2026-08-28). The web CardScanner already solved this by handing the raw
 * payload to `/api/game-cards/resolve-scan`, which follows the redirect
 * server-side behind an allowlist; this is the same rail for the kiosk.
 *
 * Returns null when the payload is not a card at all — callers treat that as
 * "not for me" and leave the scan to whoever else is listening.
 */
import { cardNumberFromScan } from "~/features/game-cards/scan";
import { centerCodeFor } from "~/config/intercard-centers";
import type { Brand, CenterCode } from "~/features/booking";

/** Only these ever redirect to an account; anything else is not a card QR and
 *  must not cost a round-trip (the server enforces its own allowlist too). */
const RESOLVABLE_HOST_RE =
  /^https?:\/\/(?:www\.)?(?:icardinc\.net|swflpassport\.com|headpinz\.com)\//i;

/**
 * Does Intercard know this account? Used where a screen must not move the guest
 * on a card it cannot account for (the attract scan).
 *
 * Three answers, not two: "unsure" means the lookup itself failed or could not
 * confirm — an Intercard outage must never turn a guest with a real card away,
 * so callers route on "unsure" and let the destination own the failure copy.
 * Only a CONFIRMED absence is a "no".
 */
export async function cardIsKnown(
  accountNumber: string,
  config: { center?: string; brand?: string } | null,
): Promise<"yes" | "no" | "unsure"> {
  try {
    const res = await fetch("/api/game-cards/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountNumber,
        ...(config?.center && config?.brand
          ? { locationCode: centerCodeFor(config.center as CenterCode, config.brand as Brand) }
          : {}),
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = (await res.json().catch(() => null)) as {
      exists?: boolean;
      notFound?: "confirmed" | "ambiguous";
    } | null;
    if (!res.ok || !data) return "unsure";
    if (data.exists === true) return "yes";
    return data.notFound === "confirmed" ? "no" : "unsure";
  } catch {
    return "unsure";
  }
}

export async function accountFromScan(raw: string): Promise<string | null> {
  const s = (raw || "").trim();
  if (!s) return null;

  // Everything decidable without the network — the 1D barcode and the `?id=`
  // QR. This is the common case and stays synchronous-fast.
  const local = cardNumberFromScan(s);
  if (local) return local;

  if (!RESOLVABLE_HOST_RE.test(s)) return null;

  try {
    const res = await fetch("/api/game-cards/resolve-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: s }),
      // Above the server's own redirect-chase budget, so a slow hop is waited
      // for rather than abandoned and re-scanned by an impatient guest.
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as { accountNumber?: string } | null;
    const acct = data?.accountNumber?.trim();
    return res.ok && acct && /^\d{1,19}$/.test(acct) ? acct : null;
  } catch {
    return null;
  }
}
