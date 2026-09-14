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

import { isDbConfigured, sql } from "@ft/db";
import {
  ADOPTABLE_STATES,
  OFFICE_ID_ALIASES,
  OFFICE_NAME_ALIASES,
} from "~/features/crm/leads/service/adopt-bmi";
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

/**
 * Who owns this project in Office, and what stage it is at, read from the
 * mirror rather than decided by us.
 *
 * Shares the alias tables with `adoptOpenBmiDeals` deliberately: the same
 * per-centre Office ids and the same "CallCenter means Guest Services" quirk
 * apply here, and having two matchers drift apart is how one screen ends up
 * disagreeing with another about who owns a deal.
 */
async function resolveProjectOwner(projectId: string): Promise<{
  repId: string | null;
  statusId: string | null;
  stateId: string | null;
}> {
  const none = { repId: null, statusId: null, stateId: null };
  if (!isDbConfigured()) return none;
  const q = sql();
  const rows = (await q`
    SELECT p.client_key, p.state_id, p.responsible_user_id, p.responsible_name
      FROM crm_bmi_projects p WHERE p.project_id = ${projectId} LIMIT 1
  `) as {
    client_key: string;
    state_id: string | null;
    responsible_user_id: string | null;
    responsible_name: string | null;
  }[];
  const p = rows[0];
  if (!p) return none;

  const reps = (await q`
    SELECT id::text AS id, slug, bmi_user_id, lower(bmi_username) AS uname, lower(first_name) AS fname
      FROM crm_reps WHERE active IS TRUE
  `) as {
    id: string;
    slug: string;
    bmi_user_id: string | null;
    uname: string | null;
    fname: string | null;
  }[];
  const name = (p.responsible_name ?? "").trim().toLowerCase();
  const alias =
    (p.responsible_user_id ? OFFICE_ID_ALIASES[p.responsible_user_id] : undefined) ??
    OFFICE_NAME_ALIASES[name];
  const repId =
    reps.find((r) => r.bmi_user_id && r.bmi_user_id === p.responsible_user_id)?.id ??
    (alias ? (reps.find((r) => r.slug === alias)?.id ?? null) : null) ??
    reps.find((r) => r.uname === name)?.id ??
    // First TOKEN, not the whole string: Office writes "Lori Coates-Lehman"
    // where the roster holds "Lori Lehman", so a whole-string compare misses a
    // planner who is plainly there.
    reps.find((r) => r.fname && r.fname === name.split(/\s+/)[0])?.id ??
    null;

  return {
    repId,
    statusId: ADOPTABLE_STATES[p.client_key]?.[String(p.state_id)] ?? null,
    stateId: p.state_id,
  };
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

  // IT ARRIVES ALREADY OWNED, because the event already has an owner.
  //
  // Owner, looking at one of these in the assignment queue: "I don't think this
  // one should be there." Right. A row created because somebody CLICKED an
  // event is not an unanswered enquiry — Office has had a planner on it for
  // months. Left at `new` with nobody on it, it sat in the director's queue
  // beside a first-touch timer, and the queue helpfully offered to hand a
  // 200-guest booked event to the Marketing Director.
  //
  // So the planner and the stage come from the PROJECT, the same way
  // `adoptOpenBmiDeals` takes them, and by the same rule: assignment follows
  // BMI's own `responsible`, never our rules engine, because re-deciding it
  // would hand one planner's live work to another.
  //
  // Written straight onto the row rather than through `assignLead`, which
  // would PUT `responsible` back to Office. Nothing here writes to Office.
  const owner = await resolveProjectOwner(input.projectId);
  const linked =
    (await deps.update(result.lead.id, {
      bmiProjectId: input.projectId,
      bmiProjectNumber: event.number || null,
      bmiStateId: owner.stateId,
      bmiStateName: event.stateName || null,
      bmiPersonId: event.contact?.id || null,
      bmiSyncedAt: new Date().toISOString(),
      mintStatus: "minted",
      mintError: null,
      ...(owner.repId ? { assignedRepId: owner.repId, assignedAt: new Date().toISOString() } : {}),
      ...(owner.statusId ? { statusId: owner.statusId } : {}),
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
