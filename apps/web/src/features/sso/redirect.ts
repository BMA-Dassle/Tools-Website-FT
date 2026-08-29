/**
 * Post-sign-in redirect sanitising.
 *
 * `/sso/signin?callbackUrl=…` is a public, unauthenticated endpoint on the same
 * origin that serves the guest storefront, so the value it hands to Auth.js's
 * `redirectTo` is attacker-controlled. Anything but a plain same-origin path is
 * dropped: an open redirect out of an SSO entry point is a phishing primitive
 * (the victim starts on the real site, ends on the attacker's page having just
 * authenticated with their Microsoft account).
 *
 * Ported from `tools-marketing/src/lib/sso/redirect.ts` — same gateway, same
 * hazard, so deliberately the same rules rather than a second opinion.
 */

/**
 * Where an unusable `callbackUrl` lands instead: a board, not the guest home —
 * this endpoint only ever exists to get staff to one.
 *
 * `/admin/checkin` rather than the pit board, because the pit board is an
 * unattended display that deliberately has no SSO route
 * (`~/lib/constants/admin-tools`, DEVICE_TOKEN_TOOLS) — sending a signed-in
 * human there would 404 them. It must always name a member of
 * `SSO_ADMIN_TOOLS`; `redirect.test.ts` asserts that.
 */
export const DEFAULT_CALLBACK_PATH = "/admin/checkin";

/**
 * True for any ASCII control character (U+0000–U+001F, U+007F).
 *
 * CR/LF in a `Location:` value is header injection; the rest are stripped by
 * browsers before the URL is parsed, which would let `"/<TAB>/evil.example"`
 * become something other than the string we vetted. Written as a char-code scan
 * rather than a regex so no control byte has to live in this source file.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `value` is a path this app may redirect to after sign-in: a
 * same-origin, relative path.
 *
 * Accepted: `/`, `/admin/pit`, `/admin/checkin?board=1`, `/a/b?x=1#frag`.
 *
 * Rejected, and why:
 * - `https://evil.example/x`, `http:/x`, `javascript:…` — absolute/scheme URLs.
 * - `//evil.example/x` — protocol-relative; a browser reads it as another origin.
 * - `/\evil.example` and `\\evil.example` — browsers normalise `\` to `/`, so
 *   these are protocol-relative URLs in disguise.
 * - `admin/pit`, `../x` — relative to the *current* path, not the app root.
 * - anything holding a control character, or with surrounding whitespace
 *   (browsers trim it, so `" //evil.example"` would escape the origin).
 */
export function isSafeCallbackPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  if (hasControlChar(value)) return false;
  // Exactly one leading slash, and no backslashes anywhere.
  if (value[0] !== "/") return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  return !value.includes("\\");
}

/**
 * {@link isSafeCallbackPath} as a coercion: the path when it is safe, otherwise
 * {@link DEFAULT_CALLBACK_PATH}.
 */
export function safeCallbackPath(value: unknown, fallback: string = DEFAULT_CALLBACK_PATH): string {
  return isSafeCallbackPath(value) ? value : fallback;
}
