/**
 * Wire types for the kiosk license lookup — shared by the server service
 * (license-lookup.server.ts), the API route, and the client fetch. Kept free
 * of server imports so client components can use them.
 */

/**
 * A BMI login code as accepted from a scan or a wallet-licence barcode —
 * `person.tags[].tag` on the Office record (e.g. `mgrm2g8o42wxc`, `973273`).
 *
 * DELIBERATELY NARROW. The code is handed straight to the Office token search,
 * which will happily answer other token shapes too (`LastName M/D/YYYY` finds
 * people by name and birthday), so an unbounded value would be a person-search
 * oracle on an unauthenticated route. Alphanumeric-only also keeps out the
 * slashes and spaces that make that upstream 500 under undici.
 *
 * Length is bounded, not pinned: tags come in 6, 13 and 36-char shapes
 * (measured across 20 racers), so nothing may key off length.
 */
export const RACER_LOGIN_CODE_RE = /^[A-Za-z0-9]{6,32}$/;

/**
 * The same code, but for a code that arrived in a URL we PUBLISHED rather than
 * off a barcode someone physically presented.
 *
 * TWO TRUST CONTEXTS, DELIBERATELY DIFFERENT. A scan is handed to us by a
 * person standing at a kiosk, a desk or a register, so it must keep accepting
 * every tag shape BMI mints — that is what RACER_LOGIN_CODE_RE above is for and
 * nothing there may key off length. A URL is typed, shared, crawled and
 * ENUMERATED, and the routes behind these ones answer with a racer's name,
 * their sign-in barcode, and (for the wallet hop) a newly minted, billed pass.
 *
 * SIX-CHARACTER TAGS ARE REAL AND THEY LOOK LIKE COUNTERS: `781136`, `973273`,
 * measured on a live record 2026-08-06. That is a 10^6 space — walkable in
 * minutes — so accepting them in a URL turns an unauthenticated route into a
 * racer-directory scrape plus a pass-minting amplifier.
 *
 * 13-char alphanumeric (~10^20) and 36-char UUID shapes only. This costs us
 * nothing: `codeForPersonId` already PREFERS the 13-char tag, so every code we
 * put in a link already qualifies — the short ones are only ever scanned.
 */
export const RACER_PUBLIC_CODE_RE = /^(?:[A-Za-z0-9]{13,32}|[0-9a-f][0-9a-f-]{15,63})$/i;

/** A person tag as the Office API returns it — the minimal slice every
 *  `person.tags[]` reader actually uses. */
export interface PersonTagLike {
  tag?: string | null;
  lastSeen?: string | null;
  kind?: number | null;
}

/** The canonical racing login code: 13 chars, letters and digits mixed. The
 *  letter requirement is load-bearing — a 13-digit run could be an Intercard
 *  card number, and no login code observed is all digits. */
const LOGIN_CODE_SHAPE = /^(?=.*[A-Za-z])[A-Za-z0-9]{13}$/;
/** The SMS-Timing app's personal QR (a UUID). */
const APP_QR_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The login code to PUBLISH for a person, from their tags[].
 *
 * NOT `tags[0]`. A person's tags are not all login codes — measured live
 * 2026-09-05 across ~70 records, `kind` separates them:
 *
 *   9  = racing login code (13-char alnum)  ← the only thing we may publish
 *   10 = SMS-Timing app QR (UUID)           ← publishable fallback
 *   2  = the guest's Intercard CARD NUMBER  ← never a login code
 *   5  = legacy 6-digit registration code   ← enumerable, never published
 *
 * and every tag's `lastSeen` refreshes when it is USED — including a game-card
 * or staff-card scan. So "most recently seen tag" is whichever handle the
 * guest touched last, not their login code: on 2026-09-05 a card scanned on
 * the crew page put kind-2 `597195` at tags[0], the wallet QR encoded
 * `/r/597195/wallet`, and the route's shape gate (correctly) bounced every
 * scan to /book/race. Only racers whose kind-9 tag happened to be newest —
 * i.e. almost nobody who holds a game card — ever reached their pass.
 *
 * Most-recent kind-9 first (so the code stays stable per record), then
 * most-recent kind-10. `kind` absent (older cached shapes) falls back to the
 * shape tests. Returns "" when the person has no publishable code at all —
 * callers must treat that as "no code", never fall back to a raw tag.
 */
export function pickPublishableLoginCode(
  tags: readonly PersonTagLike[] | null | undefined,
): string {
  const sorted = [...(tags ?? [])].sort((a, b) =>
    String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")),
  );
  const first = (ok: (t: PersonTagLike, s: string) => boolean): string => {
    for (const t of sorted) {
      const s = String(t.tag ?? "").trim();
      if (s && ok(t, s)) return s;
    }
    return "";
  };
  const code =
    first((t, s) => t.kind === 9 || (t.kind == null && LOGIN_CODE_SHAPE.test(s))) ||
    first((t, s) => t.kind === 10 || (t.kind == null && APP_QR_SHAPE.test(s)));
  // Belt and braces: whatever won must still be a shape the published routes
  // accept — a kind mislabelled upstream must not mint a dead QR.
  return RACER_PUBLIC_CODE_RE.test(code) ? code : "";
}

/**
 * One matched account. Mirrors ReturningRacerLookup's FoundAccount (so the
 * existing AccountCard renders it structurally) plus the contact + waiver
 * status the lookup's Pandora probe already established.
 */
export interface LicenseMatch {
  personId: string;
  fullName: string;
  email: string;
  phone: string;
  loginCode: string;
  lastSeen: string;
  lastSeenAt: number;
  races: number;
  memberships: string[];
  /** Verified: an UNEXPIRED licence membership is on file (service/license.ts). */
  licenseActive?: boolean;
  birthDate: string | null;
  /** Always [] since the Office-search rewrite (latency) — the qualification
   *  refresh fills real balances at the people-step exit. */
  creditBalances: Array<{ kind: string; balance: number }>;
  /** Absent by design since the Office-search rewrite (2026-07-23): like the
   *  phone OTP sign-in, waiver status resolves right AFTER sign-in via
   *  importLinked (the roster card shows "Checking waiver…" briefly). */
  waiverValid?: boolean;
}
