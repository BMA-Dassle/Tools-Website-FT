/**
 * Which wallet does this device actually have? Pure, so both callers share one
 * answer: the `/v/{code}` page (which button to render) and
 * `/v/{code}/wallet` (which file to redirect to when no platform was stated).
 *
 * Two callers, one function, on purpose. If the page offered an Apple button and
 * the route's own sniffing disagreed, the guest would tap "Apple Wallet" and be
 * handed a `.gpay` file.
 *
 * ── Resolution is deliberately three-valued ─────────────────────────────────
 * `null` means "we don't know", not "neither". A desktop browser gets BOTH
 * buttons and PassKit's landing page, which renders a QR to hop to a phone —
 * guessing a platform there would be worse than offering the choice.
 *
 * ── Sniffing is a CONVENIENCE, never an authority ───────────────────────────
 * An explicit `?platform=` always wins in the route. UA strings are spoofed,
 * frozen (Chrome's reduced-UA), and wrong on tablets that lie about themselves;
 * treating a guess as authoritative is how you hand someone the wrong file with
 * no way to correct it. The page keeps both links reachable for exactly that
 * reason — see WALLETS in VoucherRedeemView.
 */

export type WalletPlatform = "apple" | "google";

/**
 * Apple Wallet exists on iPhone, iPad and iPod. `Macintosh` is deliberately NOT
 * here even though desktop Safari can download a `.pkpass`: a Mac has no Wallet
 * app, so the pass would land in Downloads and do nothing. Macs fall through to
 * `null` and get the QR, which is the useful outcome.
 *
 * iPadOS 13+ reports itself as `Macintosh` with touch support, which no server
 * can distinguish from a real Mac by UA alone. That mis-detection costs an iPad
 * user one extra tap on the landing page, which is the right way to be wrong.
 */
const APPLE_RE = /\b(iPhone|iPad|iPod)\b/i;

/**
 * Android covers Google Wallet. Checked SECOND because some Android browsers put
 * "like Mac OS X" or Safari tokens in their UA — but no iOS device claims
 * "Android", so testing Apple first is the safe order.
 */
const ANDROID_RE = /\bAndroid\b/i;

/**
 * `null` = unknown or desktop → offer both and let the guest choose.
 *
 * Bots and empty UAs land on `null` too, which is correct: a crawler that
 * followed the link should not be served a platform-specific pass file.
 */
export function walletPlatformFromUserAgent(
  userAgent: string | null | undefined,
): WalletPlatform | null {
  const ua = userAgent ?? "";
  if (APPLE_RE.test(ua)) return "apple";
  if (ANDROID_RE.test(ua)) return "google";
  return null;
}
