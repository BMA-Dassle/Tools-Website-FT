/**
 * My Day (direction-b.html `today` / `directorToday`):
 *
 *   rep       three columns, left to right — Overdue (next action past due),
 *             Due today (due before the end of the ET day), New leads
 *             (status `assigned`, nothing touched yet);
 *   director  tiles (Unassigned → queue, Overdue across team, Contracts out)
 *             and one lane per selling rep with their next five due items.
 *
 * Everything is derived from `next_action_due` and `status`, in ET (R10).
 * Pure builders are tested at the prototype's clock; `loadMyDay` wires them.
 */

import { publicRep } from "../../core/projections";
import { getCrmSettings } from "../../core/data/settings-db";
import { ET, todayEasternYmd } from "../../core/dates";
import type { CrmRep, CrmUser } from "../../core/types";
import { listReps } from "~/features/crm/reps";
import type { DirectorLane, DirectorMyDay, LeadView, RepMyDay } from "../contracts";
import {
  countLeadsInStatus,
  countUnassignedLeads,
  listAssignedAwaitingTouch,
  listDueLeads,
  listUnassignedLeads,
} from "../data/leads-db";
import { autoAssignInMinutes } from "./queue";

/** "Good morning" before noon ET, "Good afternoon" before 5 PM, else "Good evening". */
export function greetingFor(now: Date, firstName: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", hour12: false }).format(now),
  );
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${part}, ${firstName}`;
}

/** "Saturday, September 12" in ET. */
export function dateLabelFor(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}

/** The instant the ET calendar day of `now` ends (start of tomorrow ET). */
export function endOfEasternDay(now: Date): Date {
  const ymd = todayEasternYmd(now);
  const probe = new Date(`${ymd}T17:00:00Z`);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: ET, timeZoneName: "short" }).format(
    probe,
  );
  const offset = short.includes("EDT") ? "-04:00" : "-05:00";
  const start = new Date(`${ymd}T00:00:00${offset}`);
  return new Date(start.getTime() + 24 * 3_600_000);
}

export interface DueBuckets {
  overdue: LeadView[];
  dueToday: LeadView[];
}

/** `due` is already soonest-first; split at now and at the end of the ET day. */
export function bucketDue(due: readonly LeadView[], now: Date): DueBuckets {
  const end = endOfEasternDay(now).getTime();
  const t = now.getTime();
  const overdue: LeadView[] = [];
  const dueToday: LeadView[] = [];
  for (const l of due) {
    const at = l.nextAction ? new Date(l.nextAction.due).getTime() : Number.NaN;
    if (!Number.isFinite(at)) continue;
    if (at < t) overdue.push(l);
    else if (at < end) dueToday.push(l);
  }
  return { overdue, dueToday };
}

export function buildRepMyDay(
  firstName: string,
  due: readonly LeadView[],
  newLeads: readonly LeadView[],
  now: Date,
): RepMyDay {
  const { overdue, dueToday } = bucketDue(due, now);
  return {
    kind: "rep",
    greeting: greetingFor(now, firstName),
    dateLabel: dateLabelFor(now),
    overdue,
    dueToday,
    newLeads: [...newLeads],
  };
}

export function buildLanes(
  reps: readonly CrmRep[],
  teamDue: readonly LeadView[],
  now: Date,
): DirectorLane[] {
  return reps
    .filter((r) => r.active && r.role === "rep")
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id))
    .map((rep) => {
      const mine = teamDue.filter((l) => l.rep === rep.id);
      const { overdue } = bucketDue(mine, now);
      return { rep: publicRep(rep)!, overdue: overdue.length, due: mine.slice(0, 5) };
    });
}

export interface MyDayDeps {
  listDue: typeof listDueLeads;
  listNew: typeof listAssignedAwaitingTouch;
  listReps: typeof listReps;
  countUnassigned: typeof countUnassignedLeads;
  countInStatus: typeof countLeadsInStatus;
  listUnassigned: typeof listUnassignedLeads;
  settings: typeof getCrmSettings;
  now: () => Date;
}

export function defaultMyDayDeps(): MyDayDeps {
  return {
    listDue: listDueLeads,
    listNew: listAssignedAwaitingTouch,
    listReps,
    countUnassigned: countUnassignedLeads,
    countInStatus: countLeadsInStatus,
    listUnassigned: listUnassignedLeads,
    settings: getCrmSettings,
    now: () => new Date(),
  };
}

export async function loadMyDay(
  user: Pick<CrmUser, "role" | "name" | "email" | "rep">,
  deps: MyDayDeps = defaultMyDayDeps(),
): Promise<RepMyDay | DirectorMyDay> {
  const now = deps.now();
  if (user.role !== "director") {
    const first = user.rep?.firstName ?? user.name.split(/\s+/)[0] ?? user.email;
    if (!user.rep) return buildRepMyDay(first, [], [], now);
    const [due, fresh] = await Promise.all([deps.listDue(user.rep.id), deps.listNew(user.rep.id)]);
    return buildRepMyDay(first, due, fresh, now);
  }

  const first = user.rep?.firstName ?? user.name.split(/\s+/)[0] ?? user.email;
  const [teamDue, reps, unassignedCount, contractsOut, oldestUnassigned, settings] =
    await Promise.all([
      deps.listDue(null),
      deps.listReps(),
      deps.countUnassigned(),
      deps.countInStatus("contract"),
      deps.listUnassigned(1),
      deps.settings(),
    ]);
  const { overdue } = bucketDue(teamDue, now);
  return {
    kind: "director",
    greeting: greetingFor(now, first),
    dateLabel: dateLabelFor(now),
    tiles: { unassigned: unassignedCount, overdueTeam: overdue.length, contractsOut },
    autoAssignInMinutes: autoAssignInMinutes(oldestUnassigned, settings.sweep.delayMinutes, now),
    lanes: buildLanes(reps, teamDue, now),
  };
}

/** The sidebar / bottom-tab counts: my overdue (or the team's), and the queue. */
export async function loadBadges(
  user: Pick<CrmUser, "role" | "rep">,
  deps: MyDayDeps = defaultMyDayDeps(),
): Promise<{ overdue: number; unassigned: number }> {
  const now = deps.now();
  if (user.role === "director") {
    const [teamDue, unassigned] = await Promise.all([deps.listDue(null), deps.countUnassigned()]);
    return { overdue: bucketDue(teamDue, now).overdue.length, unassigned };
  }
  if (!user.rep) return { overdue: 0, unassigned: 0 };
  const due = await deps.listDue(user.rep.id);
  return { overdue: bucketDue(due, now).overdue.length, unassigned: 0 };
}
