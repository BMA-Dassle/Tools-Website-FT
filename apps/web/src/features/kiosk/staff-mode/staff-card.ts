/**
 * Is this scan an Intercard card? PURE — the staff-card gate's shape test.
 *
 * A staff card IS a Game Zone card (an Intercard account linked to an employee
 * on the Pandora side), so it looks exactly like every guest card the kiosk
 * already knows: the zero-padded 16-digit 1D barcode, the icardinc.net QR, the
 * MSR track-2 burst. `classifyKioskCode` owns those shapes — this module only
 * asks it "game-card?" and normalises the account, so a new card format lands
 * in one place. Accounts stay STRINGS (Intercard bigint rule).
 */
import { classifyKioskCode } from "../code-entry/classify";
import { normalizeCard } from "~/features/game-cards/normalize";

export function staffCardAccountFromScan(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const code = classifyKioskCode(trimmed);
  if (code.kind !== "game-card") return null;
  if (!/^\d{1,20}$/.test(code.value)) return null;
  const account = normalizeCard(code.value);
  return account.length > 0 ? account : null;
}

/** Last four digits — what the bar shows so staff know whose card armed it. */
export function cardTail(account: string): string {
  return account.slice(-4);
}
