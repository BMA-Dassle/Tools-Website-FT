/**
 * What happens when the rep hangs up, and what happens when the prospect says
 * yes.
 *
 * DISPOSITIONS use the SAME six outcomes the Calls screen uses
 * (`calls/contracts.ts` `CALL_DISPOSITIONS`) plus "Interested", and every one
 * of them writes a `crm_activities` row with `kind:'call'` and
 * `outcome:<the disposition>` — so Accountability and the KPI screens count a
 * cold call exactly as they count any other call, with no special case for
 * this sub. The row has no lead until it converts, so `lead_id` is null on
 * that activity and `contact_id` carries the link when de-duplication found
 * one.
 *
 * CONVERSION is the moment a prospect becomes a lead. Until then there is NO
 * BMI project — a cold row is a prospect (`crm-shared.js:530`: "This is a
 * prospect (cold list or last-year reach-out). Saving converts it into a lead:
 * creates the Office project (state New Lead), attaches … as the host, and
 * assigns it by the rules"). Conversion therefore calls `createLead` with
 * `isProspect: false`, which is what runs the mint and, since the owner's
 * assign-at-capture decision (brief §5.7b, 2026-09-13 14:50), the assignment
 * rules in the same pass.
 *
 * IT IS IDEMPOTENT. A row that already has a lead returns that lead untouched:
 * a double-tapped Convert must not mint a second Office project for the same
 * business.
 */

import { recordActivity } from "~/features/crm/activities";
import { createLead, mintOutcomeView } from "~/features/crm/leads";
import type { CrmUser } from "../../core/types";
import {
  COLD_CALLBACK,
  COLD_INTERESTED,
  type ColdConvertDraft,
  type ColdDisposition,
  type ColdRowView,
} from "../contracts";
import { getColdRow, linkColdRowLead, setColdRowDisposition } from "../data/rows-db";

export class ColdRowNotFoundError extends Error {
  constructor(readonly rowId: string) {
    super("cold_row_not_found");
    this.name = "ColdRowNotFoundError";
  }
}

export interface ColdDispositionDeps {
  read: typeof getColdRow;
  write: typeof setColdRowDisposition;
  activity: typeof recordActivity;
  link: typeof linkColdRowLead;
  create: typeof createLead;
  now: () => Date;
}

export const defaultColdDispositionDeps: ColdDispositionDeps = {
  read: getColdRow,
  write: setColdRowDisposition,
  activity: recordActivity,
  link: linkColdRowLead,
  create: createLead,
  now: () => new Date(),
};

export interface ColdDispositionInput {
  rowId: string;
  disposition: ColdDisposition;
  note?: string | null;
  /** Required by "Callback scheduled"; ignored by every other outcome. */
  callbackAt?: string | null;
  user: CrmUser;
}

export interface ColdDispositionResult {
  row: ColdRowView;
  activityId: string | null;
}

/** A callback only makes sense for the outcome that promises one. */
export function callbackFor(
  disposition: ColdDisposition,
  iso: string | null | undefined,
): Date | null {
  if (disposition !== COLD_CALLBACK || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The activity's dedupe key. `touch_count` is incremented by the same
 * statement that stores the outcome, so a double-tapped button lands on the
 * same key and `recordActivity`'s `ON CONFLICT DO NOTHING` drops the second —
 * while three genuine calls a week apart get three keys and three rows.
 */
export function coldActivityRef(rowId: string, touchCount: number): string {
  return `coldrow:${rowId}:${touchCount}`;
}

export async function applyColdDisposition(
  input: ColdDispositionInput,
  deps: ColdDispositionDeps = defaultColdDispositionDeps,
): Promise<ColdDispositionResult> {
  const existing = await deps.read(input.rowId);
  if (!existing) throw new ColdRowNotFoundError(input.rowId);

  const at = deps.now();
  const note = (input.note ?? "").trim() || null;
  const row = await deps.write(input.rowId, {
    disposition: input.disposition,
    note,
    callbackAt: callbackFor(input.disposition, input.callbackAt),
    actorEmail: input.user.email,
    at,
  });
  if (!row) throw new ColdRowNotFoundError(input.rowId);

  const activityId = await deps.activity({
    leadId: row.leadId,
    contactId: row.contactId,
    repId: input.user.rep?.id ?? null,
    actorEmail: input.user.email,
    kind: "call",
    direction: "out",
    occurredAt: at,
    outcome: input.disposition,
    body: note,
    externalKind: "crm-cold-disposition",
    externalRef: coldActivityRef(row.id, row.touchCount),
    meta: {
      listId: row.listId,
      rowIndex: row.rowIndex,
      company: row.company,
      number: row.phoneE164 ?? row.phoneRaw,
      callbackAt: row.callbackAt,
    },
  });

  return { row, activityId };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ColdConvertInput {
  rowId: string;
  draft: ColdConvertDraft;
  /** Defaults to "Interested" — converting IS the interest. */
  disposition?: ColdDisposition;
  note?: string | null;
  user: CrmUser;
}

export interface ColdConvertResult {
  row: ColdRowView;
  leadId: string;
  leadPublicId: string;
  mintStatus: string;
  mintError: string | null;
  assignedRepName: string | null;
  /** False when the row already had a lead and this call changed nothing. */
  created: boolean;
}

export async function convertColdRow(
  input: ColdConvertInput,
  deps: ColdDispositionDeps = defaultColdDispositionDeps,
): Promise<ColdConvertResult> {
  const existing = await deps.read(input.rowId);
  if (!existing) throw new ColdRowNotFoundError(input.rowId);

  // Already converted: hand back what is there. Never a second Office project.
  if (existing.leadId) {
    return {
      row: existing,
      leadId: existing.leadId,
      leadPublicId: existing.leadPublicId ?? "",
      mintStatus: "existing",
      mintError: null,
      assignedRepName: null,
      created: false,
    };
  }

  const d = input.draft;
  const result = await deps.create(
    {
      centre: d.centre,
      firstName: d.firstName.trim(),
      lastName: d.lastName.trim(),
      phone: d.phone,
      email: d.email,
      company: d.company,
      eventDate: d.eventDate,
      eventTime: d.eventTime,
      guests: d.guests,
      type: d.type,
      kids: d.type === "birthday",
      notes: d.notes,
      capturePayload: {
        source: "cold",
        coldRowId: existing.id,
        coldListId: existing.listId,
        rowIndex: existing.rowIndex,
        company: existing.company,
        contactName: existing.contactName,
        phoneRaw: existing.phoneRaw,
        email: existing.email,
        city: existing.city,
        listNotes: existing.notes,
        draft: { ...d },
      },
      createdBy: input.user.email,
    },
    {
      source: "cold",
      actorEmail: input.user.email,
      // NOT a prospect any more. `createLead` defaults `cold` to prospect
      // (`PROSPECT_SOURCES`), which is right at IMPORT and wrong here: this is
      // the rep converting on real interest, which is exactly when the mint
      // and the assignment rules are supposed to run.
      isProspect: false,
    },
  );

  const lead = result.lead;
  const row = (await deps.link(existing.id, lead.id, lead.contactId, lead.accountId)) ?? existing;

  await deps.activity({
    leadId: lead.id,
    contactId: lead.contactId,
    repId: input.user.rep?.id ?? null,
    actorEmail: input.user.email,
    kind: "system",
    occurredAt: deps.now(),
    body: `Converted from the cold list · row ${existing.rowIndex}${existing.company ? ` · ${existing.company}` : ""}`,
    externalKind: "crm-cold-convert",
    externalRef: `coldrow:${existing.id}`,
    meta: { listId: existing.listId, rowId: existing.id },
  });

  // The outcome goes on the cold row too, so the list's counters move and the
  // dialling list stops offering the row.
  const disposed = await applyColdDisposition(
    {
      rowId: existing.id,
      disposition: input.disposition ?? COLD_INTERESTED,
      note: input.note ?? null,
      user: input.user,
    },
    deps,
  ).catch(() => null);

  // `MintOutcome` is a union whose `error` exists only on the unhappy
  // branches; `mintOutcomeView` is the leads sub's own flattener.
  const mint = mintOutcomeView(result.mint);
  return {
    row: disposed?.row ?? row,
    leadId: lead.id,
    leadPublicId: lead.publicId,
    mintStatus: mint.status,
    mintError: mint.error,
    assignedRepName: result.assignment?.lead.repName ?? lead.repName ?? null,
    created: true,
  };
}
