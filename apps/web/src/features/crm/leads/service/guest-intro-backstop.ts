/**
 * The backstop on a HELD welcome.
 *
 * A lead nobody owns holds the guest's welcome text and email rather than
 * sending a generic one, so the guest hears once, from the planner who will
 * actually run their event (owner, 2026-09-13: "Do we just hold the emails,
 * texts and who owns it till it gets assigned?"). `assignLead` sends it the
 * moment somebody picks the lead up, which is the path every lead is meant to
 * take — the Assignment Pending card lands in Jacob's chat the second the lead
 * arrives.
 *
 * This job exists for the case where that does not happen. Holding turns a bad
 * first impression into NO first impression, and a guest who filled in a form
 * and heard nothing for half a day is the worse outcome of the two. So after
 * `GUEST_INTRO_BACKSTOP_MINUTES` the wait ends: the generic Guest Services
 * welcome goes out, naming no individual, and `guest_intro_at` is stamped so a
 * planner who picks the lead up afterwards does not introduce themselves as a
 * second person.
 *
 * DELIBERATELY NOT A SETTING YET. Two hours is a judgement, not a measurement
 * — it is long enough that a director assigning over lunch still beats it, and
 * short enough that nobody who enquires in the morning is still waiting in the
 * afternoon. If the owner wants a different number it becomes a
 * `crm_settings` row; until somebody actually wants to change it, a constant
 * with this comment beside it is the honest version.
 *
 * Only web leads are in scope (nothing else gets an automated welcome), only
 * minted ones (the copy quotes the enquiry number), and only leads with
 * nobody on them — the moment a lead has an owner this job has no business
 * with it, because `assignLead` already did the work.
 */

import { etHourOfDay, todayEasternYmd } from "~/features/crm/core/dates";
import type { LeadView } from "../contracts";
import { listOverdueGuestIntros } from "../data/leads-db";
import {
  centerConfigFor,
  resolveGuestServicesPlanner,
  sendGuestIntro,
  summarizeGuestIntro,
  type GuestIntroOutcome,
  type NotifyDeps,
} from "./notify";
import { recordActivity } from "~/features/crm/activities";

/** How long a held welcome waits for a planner before the generic one goes out. */
export const GUEST_INTRO_BACKSTOP_MINUTES = 120;

/** `crm_activities.actor_email` for a welcome nobody asked for by hand. */
export const BACKSTOP_ACTOR = "guest-intro-backstop";

/** `guest-intro-backstop:<ET date>T<HH>` — one run per ET hour. */
export function guestIntroBackstopKey(now: Date): string {
  const hh = String(Math.floor(etHourOfDay(now))).padStart(2, "0");
  return `guest-intro-backstop:${todayEasternYmd(now)}T${hh}`;
}

export interface BackstopDeps {
  listOverdue: (olderThan: Date, limit: number) => Promise<LeadView[]>;
  sendGuestIntro: typeof sendGuestIntro;
  recordActivity: typeof recordActivity;
  notifyDeps?: NotifyDeps;
  now: () => Date;
}

export function defaultBackstopDeps(): BackstopDeps {
  return {
    listOverdue: listOverdueGuestIntros,
    sendGuestIntro,
    recordActivity,
    now: () => new Date(),
  };
}

export interface BackstopResult {
  /** How many leads were past the deadline this run. */
  overdue: number;
  /** How many welcomes actually went out. */
  sent: number;
  leads: Array<{ publicId: string; summary: string }>;
}

export async function runGuestIntroBackstop(
  deps: BackstopDeps = defaultBackstopDeps(),
): Promise<BackstopResult> {
  const now = deps.now();
  const deadline = new Date(now.getTime() - GUEST_INTRO_BACKSTOP_MINUTES * 60_000);
  const overdue = await deps.listOverdue(deadline, 50);
  const leads: BackstopResult["leads"] = [];
  let sent = 0;

  for (const lead of overdue) {
    const { projectId, projectNumber } = lead.bmi;
    if (!projectId || !projectNumber) continue;
    const center = centerConfigFor(lead.centre);
    try {
      const intro: GuestIntroOutcome = await deps.sendGuestIntro(
        {
          lead,
          // Nobody owns it, so nobody is named. `resolveGuestServicesPlanner`
          // is the one definition of the un-named welcome.
          planner: resolveGuestServicesPlanner(center),
          center,
          projectId,
          projectNumber,
        },
        deps.notifyDeps,
      );
      sent++;
      const summary = summarizeGuestIntro(intro);
      leads.push({ publicId: lead.publicId, summary });
      await deps.recordActivity({
        leadId: lead.id,
        contactId: lead.contactId,
        actorEmail: BACKSTOP_ACTOR,
        kind: "system",
        occurredAt: deps.now(),
        body:
          `Still unassigned after ${GUEST_INTRO_BACKSTOP_MINUTES} minutes — ` +
          `sent the Guest Services welcome so the guest is not left in silence · ${summary}`,
        meta: { backstop: true, ...(intro as unknown as Record<string, unknown>) },
      });
    } catch (err) {
      // One lead must never cost the rest their welcome.
      console.error("[crm] guest-intro backstop failed for a lead", {
        lead_id: lead.id,
        public_id: lead.publicId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (overdue.length) console.log("[crm] guest-intro backstop", { overdue: overdue.length, sent });
  return { overdue: overdue.length, sent, leads };
}
