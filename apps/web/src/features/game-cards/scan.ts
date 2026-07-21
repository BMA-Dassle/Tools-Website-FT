/**
 * Decode a scanned code from the back of a Game Zone card into an account
 * number. Cards carry BOTH printed codes:
 *  - a 1D barcode encoding the straight account number (leading zeros printed)
 *  - a QR code encoding the web redirect (`swflpassport.com/?id=<n>`)
 * Account numbers stay strings end-to-end (Intercard bigint precision).
 */
import { normalizeCard } from "./normalize";

export function cardNumberFromScan(raw: string): string | null {
  const s = raw.trim();
  // Barcode: the straight number (leading zeros printed but not significant).
  if (/^\d{1,19}$/.test(s)) {
    const n = normalizeCard(s);
    return n.length > 0 ? n : null;
  }
  // QR: the card's web redirect carrying ?id=<account>.
  try {
    const u = new URL(s);
    const id = u.searchParams.get("id")?.trim();
    if (id && /^\d{1,19}$/.test(id)) {
      const n = normalizeCard(id);
      return n.length > 0 ? n : null;
    }
  } catch {
    /* not a URL */
  }
  // Lenient fallback for slightly mangled QR payloads.
  const m = s.match(/[?&]id=(\d{1,19})(?:\D|$)/);
  if (m) {
    const n = normalizeCard(m[1]);
    return n.length > 0 ? n : null;
  }
  return null;
}
