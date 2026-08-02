/**
 * Entry-screen scan → destination hand-off (pov-confirmation.ts's sibling).
 *
 * A scan detected on the attract screen or the category chooser has to survive
 * a route change (`/kiosk` → `/kiosk/checkin`, or `/kiosk` → `/kiosk/flow`)
 * before the destination screen can act on it.
 *
 * WHY NOT A QUERY PARAM. A scanned code is possession-proof — the check-in
 * lookup treats a `/s` short code or a signed URL as sufficient to open a
 * booking with no OTP. Putting one in the URL writes it into history and onto
 * a screen a guest could photograph, which is the same reasoning the waiver
 * short-link work applied to its bearer codes. The route only ever carries a
 * `?goto=` marker naming the DESTINATION; the payload rides here.
 *
 * READ-ONCE by design. `consumeEntryScan` clears the key as it reads, so a
 * back-navigation, a StrictMode double-mount, or an idle reset can't replay a
 * stale scan into a fresh session. Losing the stash costs the guest one
 * re-scan — never money, never a double action.
 */

export const KIOSK_ENTRY_SCAN_KEY = "kiosk:entry-scan";

/** Where the entry screen decided this scan should land. */
export type EntryScanTarget = "checkin" | "code-entry" | "game-card";

export interface EntryScanHandoff {
  target: EntryScanTarget;
  /** The RAW scanned payload. Destination screens re-classify it themselves
   *  (`KioskCodeEntry.handleRaw`, the check-in `onScan` path), so handing over
   *  the raw text keeps exactly one classifier per destination. */
  raw: string;
  /** The normalized handle pulled out by `classifyEntryScan` — a game-card
   *  account number, a voucher code, a W-number. */
  value: string;
}

function isTarget(v: unknown): v is EntryScanTarget {
  return v === "checkin" || v === "code-entry" || v === "game-card";
}

export function stashEntryScan(handoff: EntryScanHandoff): void {
  if (!handoff.raw) return;
  try {
    sessionStorage.setItem(KIOSK_ENTRY_SCAN_KEY, JSON.stringify(handoff));
  } catch {
    /* storage unavailable — the guest re-scans at the destination */
  }
}

/**
 * Read and CLEAR the pending hand-off. Pass `target` to take it only when it
 * was meant for you — two destinations can be mounted in the same tree
 * (`KioskFlow` renders both the code screen and Game Zone), and neither should
 * swallow the other's payload.
 */
export function consumeEntryScan(target?: EntryScanTarget): EntryScanHandoff | null {
  let parsed: EntryScanHandoff | null = null;
  try {
    const raw = sessionStorage.getItem(KIOSK_ENTRY_SCAN_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<EntryScanHandoff>;
    if (!isTarget(obj.target) || typeof obj.raw !== "string" || !obj.raw) return null;
    parsed = { target: obj.target, raw: obj.raw, value: obj.value ?? obj.raw };
  } catch {
    // Unparseable — fall through and clear it so it can't wedge the screen.
  }
  if (parsed && target && parsed.target !== target) return null;
  clearEntryScan();
  return parsed;
}

export function clearEntryScan(): void {
  try {
    sessionStorage.removeItem(KIOSK_ENTRY_SCAN_KEY);
  } catch {
    /* nothing to clear */
  }
}
