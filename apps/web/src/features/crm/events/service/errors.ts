/**
 * The three refusals the events routes must answer with a CODE rather than a
 * 500 — the deal renders each one as its own message, so `withCrmRoute`'s
 * fixed "unexpected" would lose the only information the rep needs.
 *
 *   lead_not_found   404 — the path named a lead that is not there
 *   no_bmi_project   409 — the lead was never minted; nothing to read or write
 *   bmi_writes_paused 409 — the director's kill switch, or CRM_BMI_WRITES=false
 *
 * Everything else keeps the fixed 500: Office and Pandora errors carry
 * hostnames and body snippets and never belong in a toast.
 */

import { CrmHttpError } from "../../core/http";
import { BmiWritesPausedError } from "../notes/service";
import { LeadNotFoundError, NoBmiProjectError } from "./target";

export function eventsHttpError(err: unknown): CrmHttpError | null {
  if (err instanceof LeadNotFoundError) return new CrmHttpError(404, "lead_not_found");
  if (err instanceof NoBmiProjectError) return new CrmHttpError(409, "no_bmi_project");
  if (err instanceof BmiWritesPausedError) return new CrmHttpError(409, "bmi_writes_paused");
  return null;
}

/** Run a handler body, re-throwing the three known refusals as CrmHttpErrors. */
export async function withEventsErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = eventsHttpError(err);
    if (mapped) throw mapped;
    throw err;
  }
}
