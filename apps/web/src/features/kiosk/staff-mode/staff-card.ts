/**
 * Is this scan an Intercard card? PURE — the staff-card gate's shape test.
 *
 * A staff card IS a Game Zone card (an Intercard account linked to an employee
 * on the Pandora side), so it looks exactly like every guest card the kiosk
 * already knows: the zero-padded 16-digit 1D barcode, the icardinc.net QR, the
 * MSR track-2 burst. `classifyKioskCode` owns those shapes — this module asks
 * it "game-card?" first, so a new card format lands in one place.
 *
 * PLUS THE BARE NUMBER. The first live scan (owner 2026-09-04, card 597195)
 * did nothing: the scanner handed over the account UNPADDED, and a 6-digit run
 * is `promo` to the shape classifier (it protects short numeric coupon codes on
 * the code-entry screen). This gate only ever sees the people step's LEFTOVERS
 * — not a licence, not a member QR — where a bare digit run has no other
 * meaning, so any 4–20 digit run is taken as a card here. Worst case is one
 * "isn't linked to a staff account" notice. Accounts stay STRINGS (Intercard
 * bigint rule).
 */
import { classifyKioskCode } from "../code-entry/classify";
import { normalizeCard } from "~/features/game-cards/normalize";

const BARE_ACCOUNT_RE = /^\d{4,20}$/;

export function staffCardAccountFromScan(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let value: string | null = null;
  const code = classifyKioskCode(trimmed);
  if (code.kind === "game-card" && /^\d{1,20}$/.test(code.value)) value = code.value;
  else if (BARE_ACCOUNT_RE.test(trimmed)) value = trimmed;
  if (!value) return null;
  const account = normalizeCard(value);
  return account.length > 0 ? account : null;
}

/** Last four digits — what the bar shows so staff know whose card armed it. */
export function cardTail(account: string): string {
  return account.slice(-4);
}
