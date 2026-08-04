/**
 * SMS-Timing member QR — the personal QR in the BMI/SMS-Timing app. Scans as
 * ONE line shaped like:
 *
 *   https://smstim.in?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]
 *
 * (clientKey + the member's unique code). Searching the BMI Office
 * `search/person` with that code as the token returns exactly the member's
 * record (verified live 2026-07-24, ~0.7 s) — the kiosk signs them in with
 * it, same trust class as the login-code path (possession of the QR is
 * possession of their app). Pure parse — no transport, no React.
 */

export interface MemberQr {
  /** SMS-Timing client key the QR was issued under (e.g. "headpinzftmyers"). */
  clientKey: string;
  /** The member's unique code — the Office search token. */
  code: string;
}

const HOST_RE = /^https?:\/\/smstim\.in\/?\?(.+)$/i;
/**
 * TWO code shapes ride this same wrapper, and both are real BMI tags:
 *
 *   36-char UUID  what the SMS-Timing APP emits (`3f59bc35-0548-…`)
 *   6–32 alnum    the typed login code (`mgrm2g8o42wxc`, `973273`)
 *
 * Accepting only the UUID was wrong: a `person.tags[]` entry is a tag whatever
 * its shape, and every one of them resolves uniquely and forever through
 * `search/person?token=` (measured across 20 racers 2026-08-04 — tags come in
 * 6, 13 and 36-char shapes, so nothing can key off length).
 *
 * Still deliberately narrow. The code becomes an Office search TOKEN, and that
 * search answers other token shapes too — a `LastName M/D/YYYY` token finds
 * people by name and birthday — so alphanumeric-only is what keeps this from
 * being a person-search oracle on an unauthenticated kiosk route. It also
 * excludes the slashes and spaces that make the upstream 500 under undici.
 */
const CODE_RE = /^(?:[0-9a-f][0-9a-f-]{15,63}|[A-Za-z0-9]{6,32})$/i;
const KEY_RE = /^[a-z0-9_-]{3,40}$/i;

/** Parse one scan payload; null = not an SMS-Timing member QR. */
export function parseMemberQr(payload: string): MemberQr | null {
  const m = payload.trim().match(HOST_RE);
  if (!m) return null;
  let rest = m[1];
  // Scanner delivers raw brackets/quotes, but tolerate URL-encoded QRs too.
  if (!rest.startsWith("[")) {
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return null;
    }
  }
  try {
    const arr = JSON.parse(rest) as unknown;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const clientKey = String(arr[0] ?? "").trim();
    const code = String(arr[1] ?? "").trim();
    if (!KEY_RE.test(clientKey) || !CODE_RE.test(code)) return null;
    return { clientKey, code };
  } catch {
    return null;
  }
}
