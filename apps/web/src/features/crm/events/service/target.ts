/**
 * lead → BMI project, resolved once.
 *
 * Every Event/Notes/Food-out/Waiver route starts the same way: a lead id from
 * the path, a `crm_leads` row, and the project that row is joined to. A lead
 * that was never minted has no project, and that is a 409 with a reason the
 * deal can render ("Create it in BMI first") — never a 500 and never a write
 * against a guessed id.
 */

import { getLead } from "~/features/crm/leads";
import type { LeadView } from "~/features/crm/leads/contracts";
import { isCentreCode } from "../../core/centres";
import type { CentreCode } from "../../core/types";

export class LeadNotFoundError extends Error {
  constructor(id: string) {
    super(`lead ${id} not found`);
    this.name = "LeadNotFoundError";
  }
}

export class NoBmiProjectError extends Error {
  constructor(publicId: string) {
    super(`lead ${publicId} has no BMI project`);
    this.name = "NoBmiProjectError";
  }
}

export interface LeadEventTarget {
  lead: LeadView;
  centre: CentreCode;
  projectId: string;
  /** The lead's event date — `event_metadata` is keyed by it. */
  date: string;
}

export async function leadEventTarget(
  idOrPublic: string,
  read: typeof getLead = getLead,
): Promise<LeadEventTarget> {
  const lead = await read(idOrPublic);
  if (!lead) throw new LeadNotFoundError(idOrPublic);
  if (!lead.bmi.projectId) throw new NoBmiProjectError(lead.publicId);
  const centre: CentreCode = isCentreCode(lead.centre) ? lead.centre : "HPFM";
  return { lead, centre, projectId: lead.bmi.projectId, date: lead.eventDate };
}
