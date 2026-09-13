/**
 * "Create lead from event" — a CRM row for a booking that already exists in
 * BMI (every group function taken before the CRM shipped, and anything booked
 * straight into Office since).
 *
 * THE WHOLE POINT IS THAT IT DOES NOT MINT. `createLead` normally sends the
 * enquiry to Pandora, which creates a project; here the project is the thing
 * we are attaching to, so a mint would put a SECOND event on the same day for
 * the same guest. `mint: false` and the existing ids are written onto the row
 * afterwards, with `mint_status: 'minted'` because it genuinely is.
 *
 * It does not auto-assign either: `assignLead` writes `responsible` onto the
 * Office project, and silently reassigning a booked guest's event because
 * somebody pressed a button on a board would be a write to live data nobody
 * asked for. The lead lands in the queue and a human hands it over — which
 * also records `crm_assignments.actor_email`.
 */

import { createLead, getLead, updateLeadFields } from "~/features/crm/leads";
import type { LeadView } from "~/features/crm/leads/contracts";
import { recordActivity } from "~/features/crm/activities";
import { writeAudit } from "../../core/data/audit-db";
import type { CentreCode, EventType } from "../../core/types";
import { eventDetail } from "./event-detail";

export interface CreateFromEventInput {
  centre: CentreCode;
  projectId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  company: string | null;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  type: EventType;
  notes: string | null;
  actor: string;
}

export interface CreateFromEventDeps {
  detail: typeof eventDetail;
  create: typeof createLead;
  update: typeof updateLeadFields;
  read: typeof getLead;
  record: typeof recordActivity;
  audit: typeof writeAudit;
}

export function defaultCreateFromEventDeps(): CreateFromEventDeps {
  return {
    detail: eventDetail,
    create: createLead,
    update: updateLeadFields,
    read: getLead,
    record: recordActivity,
    audit: writeAudit,
  };
}

export interface CreateFromEventResult {
  lead: LeadView;
  created: boolean;
}

export async function createLeadFromEvent(
  input: CreateFromEventInput,
  deps: CreateFromEventDeps = defaultCreateFromEventDeps(),
): Promise<CreateFromEventResult> {
  // Read the project FIRST: the number, state and contact person go onto the
  // row, and reading it is also the check that the id is real before we make a
  // lead that claims to own it.
  const event = await deps.detail(input.centre, input.projectId);

  const result = await deps.create(
    {
      centre: input.centre,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      company: input.company,
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      guests: input.guests,
      type: input.type,
      kids: false,
      notes: input.notes,
      capturePayload: {
        from: "events-board",
        projectId: input.projectId,
        number: event.number,
        stateName: event.stateName,
        responsible: event.responsible,
      },
      createdBy: input.actor,
    },
    { source: "phone", actorEmail: input.actor, mint: false, notify: false, autoAssign: false },
  );

  const linked =
    (await deps.update(result.lead.id, {
      bmiProjectId: input.projectId,
      bmiProjectNumber: event.number || null,
      bmiStateId: null,
      bmiStateName: event.stateName || null,
      bmiPersonId: event.contact?.id || null,
      bmiSyncedAt: new Date().toISOString(),
      mintStatus: "minted",
      mintError: null,
    })) ?? result.lead;

  await deps.record({
    leadId: linked.id,
    actorEmail: input.actor,
    kind: "bmi",
    outcome: "linked_existing_project",
    subject: `Linked to the existing BMI project ${event.number || input.projectId}`,
    meta: { projectId: input.projectId, from: "events-board" },
  });

  await deps.audit({
    entity: "lead",
    entityId: linked.id,
    action: "create:from-event",
    actorEmail: input.actor,
    after: { publicId: linked.publicId, projectId: input.projectId, number: event.number },
  });

  return { lead: linked, created: result.created };
}
