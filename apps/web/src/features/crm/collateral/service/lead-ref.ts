/**
 * Resolve the lead a share is attributed to — through the LEADS SUB, which now
 * owns the only reader of `crm_leads` (B3 landed `getLead` / `leadNumericId`).
 *
 * THIS REPLACES C6'S OWN SQL, AND THE REASON MATTERS. The first cut of this
 * seam kept a two-column read of its own (`collateral/data/lead-lookup-db.ts`)
 * because the leads sub shipped DDL only at the time. It bound one parameter
 * as BOTH a bigint and text (`l.id = $1::bigint OR l.public_id = $1`), which
 * Postgres cannot plan at all — so every share carrying a lead threw before a
 * link was minted, and no recording-SQL stub could see it. The lesson is not
 * "cast more carefully": it is that a second reader of another sub's table is
 * a second place for that class of bug to live. `public_id` is `'L-' || id`
 * (`leads/data/leads-db.ts`), so `leadNumericId` turns either form a UI holds
 * — `L-1042` or `4211` — into the row id, and `getLead` does the read.
 *
 * Cross-sub import through the barrel only (brief §3.2), and this module is
 * SERVER-side: nothing in a browser bundle imports it.
 *
 * THE IMPORT IS LAZY, and it has to be. `~/features/crm/leads` re-exports its
 * job handlers, which import `~/features/crm/jobs`, whose `registry.ts` reads
 * `shareLinkExpireHandler` off THIS sub's barrel — so a static import here
 * closes the ring collateral → leads → jobs → collateral, and whichever module
 * the request happens to enter first gets a half-initialised partner (proved
 * by a live probe: "Cannot read properties of undefined (reading
 * 'shareLinkExpireHandler')"). Deferring the import to call time breaks the
 * cycle without deep-importing another sub's data file, exactly as
 * `service/share.ts` defers the activities writer.
 */

export interface ShareLeadRef {
  /** `crm_leads.id` as text. */
  id: string;
  /** `crm_leads.public_id` — the `L-1042` style id the URLs use. */
  publicId: string;
  /** What the sheet prints: "L-1042 · Lee Health" style, best effort. */
  label: string;
}

function labelFor(
  publicId: string,
  guest: { first: string; last: string; company: string | null },
) {
  const who = guest.company?.trim() || [guest.first, guest.last].join(" ").trim();
  return who ? `${publicId} · ${who}` : publicId;
}

/**
 * Accepts either form the UI can hold: the numeric row id (what a deal drawer
 * has) or the public id (what a URL has). Anything else returns null WITHOUT
 * touching the database — a share is never worth a query on a hand-typed
 * string. A lead that is not there is null too, never an invented id:
 * `crm_activities.lead_id` has an FK, so an unresolvable lead must be caught
 * here or the timeline insert fails with a constraint error instead of a
 * sentence.
 */
export async function findShareLead(
  input: string | null | undefined,
): Promise<ShareLeadRef | null> {
  const value = (input ?? "").trim();
  if (!value) return null;
  const { getLead } = await import("~/features/crm/leads");
  const lead = await getLead(value);
  if (!lead) return null;
  return {
    id: lead.id,
    publicId: lead.publicId,
    label: labelFor(lead.publicId, lead.guest),
  };
}
