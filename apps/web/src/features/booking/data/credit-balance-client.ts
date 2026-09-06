"use client";

/**
 * Live credit-balance fetch — LOCAL server first, cloud Office fallback.
 *
 * Credits are WRITTEN to the center's on-site BMI server (staff-page comps,
 * race-pack grants — all via Pandora `addDeposit`), and the charge path
 * validates against that same on-site ledger. The cloud Office
 * `deposit/history` read every lookup surface used to rely on only sees a
 * deposit after BMI's on-site → cloud sync, measured at 1.5–12 MINUTES
 * (2026-09-05: staff granted comps at 9:14pm, the sheet + checkout showed
 * nothing, staff re-granted at 9:16 — every guest got doubles). So the
 * display must read where the write landed:
 *
 *   1. `/api/pandora/deposits/{personId}` → on-site DPS_OVERVIEW (fresh)
 *   2. `/api/bmi-office?action=deposits`  → cloud history (fallback only —
 *      Pandora unreachable, or the person isn't on the on-site server yet)
 *
 * Race credits live on the FastTrax location ledger (the deposits route's
 * default), matching what `validateCreditRedemptions` checks at charge time.
 *
 * Returns null when BOTH reads fail — callers keep whatever snapshot they
 * already hold (fail open, same as today).
 */
import { creditBalancesFromDeposits, creditBalancesFromOverview } from "./race-credits";

export async function fetchLiveCreditBalances(
  personId: string,
  opts?: {
    /** Extra query string for the Office fallback (verification proof),
     *  starting with "&" — e.g. `&verify=…`. The Pandora route needs none. */
    officeQs?: string;
  },
): Promise<Array<{ kind: string; balance: number }> | null> {
  try {
    const res = await fetch(`/api/pandora/deposits/${encodeURIComponent(personId)}`);
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown };
      if (Array.isArray(body?.data)) return creditBalancesFromOverview(body.data);
    }
  } catch {
    /* fall through to the cloud read */
  }
  try {
    const res = await fetch(
      `/api/bmi-office?action=deposits&personId=${encodeURIComponent(personId)}${opts?.officeQs ?? ""}`,
    );
    if (res.ok) return creditBalancesFromDeposits(await res.json());
  } catch {
    /* both sources down */
  }
  return null;
}
