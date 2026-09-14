import type { CrmRep } from "../core/types";

/**
 * WHICH OFFICE USER ID TO SEND, for this rep, on this tenant.
 *
 * Office user ids are per SERVER. Measured off the mirror on 2026-09-14 — the
 * same five people, two tenants, ten different ids:
 *
 *              headpinzftmyers      headpinznaples
 *   Kelsea         28267036             6338800
 *   Lori             465247               41096
 *   Stephanie        465242             1559644
 *   Eric              75262               25228
 *   Guest Services 30080112             6400642   ← named "CallCenter" there
 *
 * `crm_reps.bmi_user_id` holds ONE of those, so every Office write on a Naples
 * lead was sending a Fort Myers id and being refused:
 * `400 violation of FOREIGN KEY constraint "FK_PRJ_US_ID" … F_US_ID =
 * 30080112`. It looked like a Guest Services bug only because kids' birthdays
 * route there; it was every rep.
 *
 * THE FALLBACK IS DELIBERATE AND IT IS A RISK WORTH NAMING. With no entry for
 * a tenant this returns `bmiUserId`, which is what shipped before and is right
 * for Fort Myers and wrong for Naples. The alternative — refusing to write
 * without a mapping — would stop every hand-off at a centre whose map has not
 * been filled in yet. So the write still goes, and `isPermanentOfficeRefusal`
 * now parks the failure instead of retrying it twenty times. Fill the map in
 * and the guess stops being needed.
 */
export function bmiUserIdFor(
  rep: Pick<CrmRep, "bmiUserId" | "bmiUserIds">,
  clientKey: string,
): string | null {
  const mapped = rep.bmiUserIds?.[clientKey];
  if (mapped) return mapped;
  return rep.bmiUserId ?? null;
}

/** True when this rep has an id KNOWN to be right for that tenant. */
export function hasTenantUserId(rep: Pick<CrmRep, "bmiUserIds">, clientKey: string): boolean {
  return Boolean(rep.bmiUserIds?.[clientKey]);
}
