/**
 * Entry-screen scan router — pure, no DB / no network.
 *
 * The attract screen and the category chooser/shelves are the first things a
 * guest sees, and the QR reader is always listening there. Unlike every other
 * scan surface, these screens have NO context: the guest could be holding a
 * reservation QR, a voucher, or a game card, and we have to work out which
 * before we know where to send them.
 *
 * TWO classifiers already exist and this module owns the ORDER they run in:
 *
 *   classifyScan       (checkin/scan.ts)      reservation handles
 *   classifyKioskCode  (code-entry/classify.ts) vouchers / cards / promos
 *
 * Neither can be used alone, because BOTH end in a greedy catch-all —
 * `classifyScan` calls anything left over a reservation `code`, and
 * `classifyKioskCode` calls anything left over a `promo`. Run either one first
 * and it swallows the other's payloads:
 *
 *   0000000001063464  game card → classifyScan alone says "shortcode" (16 alnum)
 *   SUMMER26          promo     → classifyScan alone says "shortcode" (8 alnum)
 *   C2D8…R9           BMI vch   → classifyScan alone says "code"      (24 chars)
 *   W56444            booking   → classifyKioskCode alone says "promo"
 *
 * So: MOST-SPECIFIC SHAPE FIRST, greedy catch-alls last. The code-shape
 * classifier runs first but only its *structural* verdicts are honoured
 * (game-card / gift-card / the two voucher shapes); its `promo` catch-all is
 * ignored and the payload falls through to the reservation classifier, whose
 * own catch-all then lands on the ambiguous path.
 *
 * WHY AN `HPW` VOUCHER GOES STRAIGHT TO REDEMPTION. It is meaningful two ways
 * — one minted at booking carries `vouchers.bill_id` and so also identifies a
 * reservation (the VIP combo QR), while a standalone comp is purely redeemable
 * — and it used to be `resolve-then-code-entry` so the server could decide by
 * `bill_id` (owner 2026-08-02). That routed the booking-minted ones to CHECK-IN,
 * which is wrong for the payload: `/v/{code}` is the REDEMPTION link, and the
 * booking already has its own reservation QR in the same email for checking in.
 * Every VIP grant carries a `bill_id`, so the divert fired on 100% of them and
 * the redemption screen — the only surface that names the game-card and
 * laser-tag legs, and the only one that seeds the party onto the PERSISTED
 * kiosk session — was unreachable by scanning the QR printed for it.
 * (Check-in's own roster auto-load writes to a local, non-persisted reducer, so
 * the divert did not seed the booking flow either.) Measured before changing
 * it: 340 completed kiosk check-ins, exactly ONE ever reached via a scanned
 * code — so the diverted path was carrying no traffic worth preserving. Owner
 * approved the reversal 2026-08-31. Bare 6–16-char tokens stay ambiguous for a
 * genuinely structural reason and keep the resolve-first path.
 *
 * WHY A RACER HANDLE IS A URL AND NEVER A BARE CODE. A BMI login code is ~13
 * alphanumeric characters (`3tn4d694p6z94`), which is exactly `SHORT_CODE_RE`
 * and also a perfectly legal promo code — there is no shape that separates
 * them, so a bare code CANNOT get a verdict here without stealing payloads
 * from both neighbours. Both racer handles we accept are therefore URLs with a
 * distinct host or path: the SMS-Timing app's own personal QR, and our
 * `/r/{code}` barcode (the shape the wallet racing licence carries). That
 * makes `racer` a structural verdict with zero collision surface — the same
 * reasoning that lets `/v/{code}` be decided here while a bare `HPW` cannot.
 */

import { classifyKioskCode } from "../code-entry/classify";
import { classifyScan, shortCodeFromPath } from "../checkin/scan";
// Direct import, not the `../qr-scanner` barrel: that re-exports React hooks
// and this module is pure (imported by route handlers and by node tests).
import { parseMemberQr } from "../qr-scanner/member-qr";

export type EntryScanRoute =
  /** A reservation handle that carries its own structure (signed URL, /s link,
   *  W-number). A miss is a real miss — never falls back to the code screen. */
  | { kind: "reservation"; value: string; raw: string }
  /** A voucher or coupon. `KioskCodeEntry` re-classifies the raw payload, so
   *  BMI vouchers, native vouchers and promos all share this destination —
   *  which also auto-links a booking-minted voucher's party onto the session. */
  | { kind: "code-entry"; value: string; raw: string }
  /** An Intercard game card → Game Zone. `value` is the account number, kept a
   *  STRING (Intercard accounts exceed float-safe ranges upstream). */
  | { kind: "game-card"; value: string; raw: string }
  /** Could be either. Try the reservation lookup; on a miss, open the code
   *  screen with `raw`. Bare 6–16-char tokens only — a reservation short code
   *  and a promo code share that shape exactly. (HPW vouchers used to ride
   *  this too; they now go straight to `code-entry` — see the header.) */
  | { kind: "resolve-then-code-entry"; value: string; raw: string }
  /** A racer identifying themselves — the SMS-Timing app QR or our `/r/{code}`
   *  wallet-licence barcode. `value` is the Office search token. Resolves to a
   *  PERSON, not a booking, so the caller decides between check-in (they have
   *  a reservation today) and sign-in (they don't). */
  | { kind: "racer"; value: string; clientKey?: string; raw: string }
  /** Nothing an entry screen routes. The caller shows a brief toast. */
  | { kind: "unsupported"; reason: UnsupportedReason; raw: string };

/** Why a scan went nowhere — picks the toast copy. */
export type UnsupportedReason =
  /** Square gift card. Out of scope until it has a screen to land on. */
  | "gift-card"
  /** A driver's licence under the scanner. */
  | "license"
  /** Empty, or a payload no classifier recognises. */
  | "unknown";

/**
 * A driver's licence PDF417 — `@\x1e\rANSI 636…`. Same heuristic as
 * gift-card-qr.ts, deliberately: a licence normally arrives as a MULTI-LINE
 * burst that the listener rejects before it ever gets here, so this only
 * catches the single-line case.
 */
function looksLikeLicense(raw: string): boolean {
  return raw.startsWith("@") || raw.includes("ANSI ");
}

/** A racer identity lifted out of a scan. `code` is the Office search token —
 *  `search/person?token=` resolves it to exactly one racer. */
export interface RacerHandle {
  code: string;
  /** Only the SMS-Timing QR carries one; a foreign key yields no matches. */
  clientKey?: string;
}

/**
 * Our own racing-licence barcode: `https://headpinz.com/r/{loginCode}`. Shaped
 * on `/v/{code}` in code-entry/classify.ts, for the same reason — a distinct
 * path makes the payload decidable without a lookup.
 *
 * Alphanumeric only. The code becomes an Office search TOKEN, and that search
 * is a general person-search oracle for anyone who can shape the token; the
 * character class is what keeps this to code-shaped inputs (it rejects the
 * `LastName M/D/YYYY` form, and the slashes/spaces that make the upstream 500
 * under undici — see lookup.server.ts).
 */
const RACER_PATH_RE = /\/r\/([A-Za-z0-9]{4,32})(?:[/?#]|$)/;

/**
 * The racer handle in a scan, or null. Exported because three surfaces need
 * the SAME answer from the SAME string: this classifier, the check-in lookup
 * route (which must recognise a racer payload before it tries to resolve a
 * billId), and the people step (which re-derives it from the hand-off).
 */
export function racerHandleFromRaw(input: string): RacerHandle | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const qr = parseMemberQr(raw);
  if (qr) return { code: qr.code, clientKey: qr.clientKey };
  if (!/^https?:\/\//i.test(raw)) return null;
  const m = RACER_PATH_RE.exec(raw);
  return m ? { code: m[1] } : null;
}

export function classifyEntryScan(input: string): EntryScanRoute {
  const raw = (input || "").trim();
  if (!raw) return { kind: "unsupported", reason: "unknown", raw };
  if (looksLikeLicense(raw)) return { kind: "unsupported", reason: "license", raw };

  // ── Pass 0: racer identity. Ahead of both classifiers because neither knows
  // these shapes — `classifyKioskCode` calls an smstim.in URL `unknown` and a
  // `/r/` URL `unknown` too, and both then fall through to `classifyScan`,
  // which calls them `unknown` as well. Today that combination is a toast.
  const racer = racerHandleFromRaw(raw);
  if (racer) {
    return {
      kind: "racer",
      value: racer.code,
      ...(racer.clientKey ? { clientKey: racer.clientKey } : {}),
      raw,
    };
  }

  const isUrl = /^(?:https?:\/\/|sqgc:\/\/)/i.test(raw);

  // ── Pass 1: code shapes. Only STRUCTURAL verdicts are honoured here; the
  // `promo` catch-all deliberately falls through to pass 2 so a W-number or a
  // /s link isn't swallowed as a discount code.
  const code = classifyKioskCode(raw);
  switch (code.kind) {
    case "game-card":
      // A card scan goes to Game Zone, full stop. It briefly diverted an
      // ambiguous digit run to the code screen so Groupon could be tried
      // first; that is gone with scanning-checks-Groupon (owner 2026-08-28 —
      // Groupon is typed for now), and keeping it would send padded CARD scans
      // on a detour for a lookup that no longer happens.
      return { kind: "game-card", value: code.value, raw };
    case "gift-card":
      return { kind: "unsupported", reason: "gift-card", raw };
    case "bmi-voucher":
      // 24 chars of strict letter/digit alternation — cannot be anything else.
      return { kind: "code-entry", value: code.value, raw };
    case "native-voucher":
      // HPW is OURS and unmistakable, so it needs no lookup to place: the
      // voucher screen redeems it AND auto-links its booking's party. A
      // booking-minted one also identifies a reservation, but check-in is
      // reached by that booking's own QR — see the header.
      return { kind: "code-entry", value: code.value, raw };
    case "promo":
    case "unknown":
      break; // fall through — pass 2 owns these
  }

  // ── Pass 2: reservation handles.
  //
  // Which string to examine matters. Pass 1 UNWRAPS coupon URLs (`?code=X`)
  // and re-classifies the inner code, so for a URL that came back `promo` the
  // meaningful payload is `code.value`, not the outer URL — feeding the URL to
  // classifyScan would just yield "unknown" and lose the code. For everything
  // else, examine `raw`: classifyKioskCode UPPERCASES its promo output, and
  // the reservationCode index is keyed on the code exactly as issued, so a
  // lowercase `r{billId}` must not be case-folded on the way through.
  const scanInput = isUrl && code.kind === "promo" ? code.value : raw;
  const scan = classifyScan(scanInput);
  switch (scan.kind) {
    case "signed-url":
    case "wnumber":
      return { kind: "reservation", value: scan.value, raw };
    case "shortcode":
      // A code lifted out of a `/s/{code}` PATH is unmistakably one of ours.
      // A BARE 6–16-char token that merely LOOKS like one is not — that shape
      // also fits a promo code, so it has to be resolved before we commit.
      return shortCodeFromPath(scanInput)
        ? { kind: "reservation", value: scan.value, raw }
        : { kind: "resolve-then-code-entry", value: scan.value, raw };
    case "voucher":
      // Pass 1 already caught every HPW form; defensive only. Same destination
      // as pass 1's, so the two classifiers cannot disagree about a voucher.
      return { kind: "code-entry", value: scan.value, raw };
    case "code":
      // The opaque-reservationCode catch-all. Try the booking index, but let a
      // long coupon code that landed here still reach the code screen.
      return { kind: "resolve-then-code-entry", value: scan.value, raw };
    case "unknown":
      return { kind: "unsupported", reason: "unknown", raw };
  }
}
