/**
 * BMI Office id arithmetic — PURE and isomorphic, importable from client
 * components (lib/bmi-office-actions.ts re-exports these but is server-only:
 * it pulls in node `https`/`crypto` at module top, so a "use client" page that
 * needs the projectId derivation imports from here instead).
 */

/**
 * A STABLE `x-session-id` for BMI Office READS: `{tag}-{clientKey}`.
 *
 * BMI Office holds server-side state per `x-session-id`. A caller that derives
 * the header from a clock (`scan-${Date.now()}`) or a fresh `randomUUID()` mints
 * a brand-new session on every tick, so a 60-second poll leaves ~1,440 of them
 * behind per tenant per day. BMI Office reported connection exhaustion on
 * 2026-08-25 and named `sweep-headpinzftmyers` — the one poller whose id was
 * already stable, and therefore the only one they could see. The unstable
 * pollers were the volume.
 *
 * Keyed by clientKey because a session is per-tenant: one id shared across both
 * centers would attribute Naples reads to the Fort Myers session.
 *
 * READS ONLY. A write round-trip (GET → mutate → PUT) keeps its own
 * per-operation id — see `apiHeaders` in lib/bmi-office-actions.ts. The Office
 * UI holds one session across a single edit, so a per-operation id mirrors it;
 * a process-wide id shared by concurrent writes would not, and a write path is
 * not where we find out what BMI does with that.
 */
export function officeReadSessionId(tag: string, clientKey: string): string {
  return `${tag}-${clientKey}`;
}

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
