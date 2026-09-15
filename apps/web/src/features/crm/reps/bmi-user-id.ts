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

/**
 * THE DISPLAY NAME PANDORA WILL RECOGNISE, for this rep on this tenant.
 *
 * Pandora's party-lead rail picks the salesperson by NAME, with
 * `name.includes(agent)`. The two servers name the same people differently:
 *
 *              headpinzftmyers        headpinznaples
 *   Kelsea     "Kelsea Kosco"         "Kelsea"
 *   Lori       "Lori Lehman"          "Lori"
 *   Stephanie  "Stephanie Wegman"     "Stephanie"
 *   Guest Svcs "Guest Services"       "CallCenter"
 *
 * "Stephanie" does not contain "Stephanie Wegman", so a Naples lead sending
 * the Fort Myers name matched nobody and Pandora answered 500 "Failed to
 * assign an agent for this lead." The mint then failed, and because the
 * guest's text, the guest's email and the planner's Teams card are ALL gated on
 * having a project, the rep was never told and the guest never heard from us.
 *
 * MEASURED 2026-09-15: every Naples non-kids web lead failed this way. The
 * kids' ones survived by accident — "Child Birthday" force-routes to Guest
 * Services inside Pandora and ignores `agent` entirely — which is why this
 * looked like an occasional glitch rather than "Naples is broken".
 *
 * FALLS BACK to the single `bmiUsername`, deliberately and with the same
 * trade-off as `bmiUserIdFor`: a tenant with no entry still sends the old
 * guess, because refusing to mint would be a worse failure than minting with
 * Pandora's own pick. Fill the map in and the guess stops being needed.
 */
export function bmiUsernameFor(
  rep: Pick<CrmRep, "bmiUsername" | "bmiUsernames">,
  clientKey: string,
): string | null {
  const mapped = rep.bmiUsernames?.[clientKey];
  if (mapped) return mapped;
  return rep.bmiUsername ?? null;
}
