/**
 * BMI Office id arithmetic — PURE and isomorphic, importable from client
 * components (lib/bmi-office-actions.ts re-exports these but is server-only:
 * it pulls in node `https`/`crypto` at module top, so a "use client" page that
 * needs the projectId derivation imports from here instead).
 */

/** BMI Office project id = bill id + 1. Both are 17-digit strings beyond
 *  Number.MAX_SAFE_INTEGER — the increment runs on the last 10 digits only
 *  (safe as a Number) and the prefix stays raw text. Same computation
 *  unified-reserve does inline; never Number()/JSON-round-trip the whole id. */
export function officeProjectIdFromBillId(billId: string): string {
  const tail = (Number(billId.slice(-10)) + 1).toString();
  return billId.slice(0, -tail.length) + tail;
}

/**
 * The INVERSE: projectId → billId. Same last-10-digits arithmetic, same raw-text
 * prefix, so a 17-digit id never touches Number() as a whole.
 *
 * Needed because the two ids are NOT interchangeable at the API boundary and the
 * difference is invisible: `public-booking/person/registerProjectPerson` resolves a
 * BILL, so handing it a projectId makes it look up `billId + 1` — a different
 * booking, or none. Probed live 2026-07-30 (project 63000000006754862):
 *   http 200  {"success":false,"errorMessage":"Cannot find the reservation for bill …"}
 * It echoes the value back as a BILL, which is what settles which key it wants.
 *
 * Returns null rather than guessing when the arithmetic would borrow past the
 * 10-digit window — a wrong id here attaches a guest to someone else's booking.
 */
export function billIdFromOfficeProjectId(projectId: string): string | null {
  if (!/^\d+$/.test(projectId)) return null;
  // Group-function ids are 8 digits, online-booking ids 17 — operate on the last 10
  // (or fewer), the same window the forward function uses.
  const width = Math.min(10, projectId.length);
  const tail = Number(projectId.slice(-width));
  if (!Number.isSafeInteger(tail) || tail <= 0) return null;
  const prefix = projectId.slice(0, projectId.length - width);
  const dec = String(tail - 1);
  // Pad only when there IS a prefix to protect; padding a bare id would invent a
  // leading zero and stop it round-tripping.
  return prefix + (prefix ? dec.padStart(width, "0") : dec);
}
