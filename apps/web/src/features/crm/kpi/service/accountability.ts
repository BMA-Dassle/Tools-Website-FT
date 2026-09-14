/**
 * Accountability (`GET /api/admin/crm/accountability`) — every logged call,
 * text, email and last-year reach-out for a week, against each rep's target.
 *
 * VISIBILITY IS ENFORCED HERE, not in the component (brief C7: "A rep sees
 * their own accountability numbers; the director sees everyone's… Enforce this
 * server-side in the route, not just by hiding UI"). `forUser` narrows the
 * roster to the caller's own rep row unless they carry `sales-director`, and a
 * `?rep=` a rep is not allowed to see is ignored rather than obeyed — so a
 * hand-typed URL cannot read a colleague's numbers even though the same
 * endpoint serves both.
 *
 * `crm_activities` IS THE ONLY SOURCE for the counts (brief C7). Nothing here
 * reads Vox, Graph or 3CX: those rails write activity rows, and a channel that
 * has not shipped yet simply counts zero, which is the truth.
 *
 * Targets are WEEKLY. A four-week range multiplies them by four rather than
 * comparing a month of work against one week's target.
 */

import { listReps } from "~/features/crm/reps";
import type { CrmRep, CrmUser } from "~/features/crm/core/types";
import type {
  AccountabilityRange,
  AccountabilityResponse,
  MyWeekResponse,
  RepAccountability,
  WeeklyActual,
  WeeklyTarget,
} from "../contracts";
import { BUCKET_DEFAULT_TARGET, DEFAULT_TARGET, targetsAsOf } from "../data/targets-db";
import { callsByWeek, leadsTouched, responseMinutesByRep, touchCounts } from "../data/measure-db";
import { median } from "./pacing";
import { accountabilityWindow, mondayOf, trailingWeeks } from "./windows";

/** How far behind a rep has to be before the director's banner names them. */
const BEHIND_PCT = 60;

function scale(target: WeeklyTarget, weeks: number): WeeklyTarget {
  if (weeks <= 1) return target;
  return {
    ...target,
    calls: target.calls * weeks,
    texts: target.texts * weeks,
    emails: target.emails * weeks,
    reachouts: target.reachouts * weeks,
  };
}

function defaultFor(rep: CrmRep): WeeklyTarget {
  return rep.role === "bucket" ? { ...BUCKET_DEFAULT_TARGET } : { ...DEFAULT_TARGET };
}

/** Reps whose work this page measures: people and the Guest Services bucket. */
export function measurableRoster(reps: readonly CrmRep[]): CrmRep[] {
  return reps.filter((r) => r.active && (r.role === "rep" || r.role === "bucket"));
}

/**
 * The roster THIS person may see. A director sees everyone; anybody else sees
 * their own rep row and nothing else (an empty list when they have none, which
 * the screen renders as "no rep row yet" rather than a silent blank).
 */
export function visibleRoster(user: CrmUser, reps: readonly CrmRep[]): CrmRep[] {
  const all = measurableRoster(reps);
  if (user.role === "director") return all;
  const mine = user.rep ? all.filter((r) => r.id === user.rep!.id) : [];
  return mine;
}

export interface AccountabilityQuery {
  range?: AccountabilityRange | null;
  /** A rep slug; honoured for a director, and for a rep only when it is theirs. */
  rep?: string | null;
  now?: Date;
}

export async function accountability(
  user: CrmUser,
  query: AccountabilityQuery = {},
): Promise<Omit<AccountabilityResponse, "ok">> {
  const now = query.now ?? new Date();
  const range: AccountabilityRange =
    query.range === "last" || query.range === "4w" ? query.range : "week";
  const window = accountabilityWindow(range, now);

  const allReps = await listReps({ includeInactive: false });
  let roster = visibleRoster(user, allReps);
  if (query.rep) {
    const picked = roster.filter((r) => r.slug === query.rep);
    // A rep asking for somebody else gets their OWN row back, not a refusal and
    // not the colleague's: the screen is theirs, the filter simply does not apply.
    if (picked.length > 0) roster = picked;
  }

  const [targets, touches, touchedLeads, responses, weeklyCalls] = await Promise.all([
    targetsAsOf(mondayOf(window.from)),
    touchCounts({ from: window.from, until: window.until }),
    leadsTouched({ from: window.from, until: window.until }),
    responseMinutesByRep({ from: window.from, until: window.until }),
    callsByWeek(trailingWindow(now)),
  ]);

  const byRepChannel = new Map<string, Map<string, number>>();
  for (const t of touches) {
    const m = byRepChannel.get(t.repId) ?? new Map<string, number>();
    m.set(t.channel, (m.get(t.channel) ?? 0) + t.touches);
    byRepChannel.set(t.repId, m);
  }

  const weeks = trailingWeeks(now);
  const callsByRepWeek = new Map<string, Map<string, number>>();
  for (const row of weeklyCalls) {
    const m = callsByRepWeek.get(row.repId) ?? new Map<string, number>();
    m.set(row.weekStart, (m.get(row.weekStart) ?? 0) + row.calls);
    callsByRepWeek.set(row.repId, m);
  }

  const reps: RepAccountability[] = roster.map((rep) => {
    const channels = byRepChannel.get(rep.id) ?? new Map<string, number>();
    const target = scale(targets.get(rep.id) ?? defaultFor(rep), window.weeks);
    const actual: WeeklyActual = {
      calls: channels.get("call") ?? 0,
      texts: channels.get("sms") ?? 0,
      emails: channels.get("email") ?? 0,
      reachouts: channels.get("reachout") ?? 0,
      leadsTouched: touchedLeads.get(rep.id) ?? 0,
      medianResponseMinutes: median(responses.get(rep.id) ?? []),
      trend: weeks.map((w) => callsByRepWeek.get(rep.id)?.get(w.from) ?? 0),
    };
    return {
      repId: rep.id,
      slug: rep.slug,
      firstName: rep.firstName,
      displayName: rep.displayName,
      initials: rep.initials,
      target,
      actual,
    };
  });

  return { window, reps, behind: user.role === "director" ? worstBehind(reps) : null };
}

function trailingWindow(now: Date): { from: string; until: string } {
  const weeks = trailingWeeks(now);
  return { from: weeks[0].from, until: weeks[weeks.length - 1].until };
}

export function pctOf(actual: number, target: number): number {
  if (!target) return 0;
  return Math.round((actual / target) * 100);
}

/**
 * The one rep the director's banner names: whoever has done least of the work
 * the two headline targets ask for. Null when nobody is behind — a banner that
 * is always there is a banner nobody reads.
 *
 * THE SCORE IS COMBINED PROGRESS — `(calls + reachouts) / (their targets)` —
 * not the worse of the two percentages. The min-of-two rule looked reasonable
 * and named the wrong person: a rep at 38 of 40 calls who has not started her
 * reach-outs scores 0% on Monday morning and outranks somebody genuinely
 * adrift at 45% and 27%. One untouched column early in the week is not the
 * same thing as being behind, and a banner that cries wolf every Monday is one
 * Jacob stops reading. The per-rep cards still show each meter on its own, so
 * nothing is hidden by summing here.
 */
export function worstBehind(
  reps: readonly RepAccountability[],
): Omit<AccountabilityResponse, "ok">["behind"] {
  let worst: RepAccountability | null = null;
  let worstScore = Number.POSITIVE_INFINITY;
  for (const r of reps) {
    const done = r.actual.calls + r.actual.reachouts;
    const asked = r.target.calls + r.target.reachouts;
    // No target set at all is not "0% done" — there is nothing to be behind on.
    if (asked === 0) continue;
    const score = pctOf(done, asked);
    if (score >= BEHIND_PCT) continue;
    if (score < worstScore) {
      worstScore = score;
      worst = r;
    }
  }
  if (!worst) return null;
  return {
    slug: worst.slug,
    displayName: worst.displayName,
    callsPct: pctOf(worst.actual.calls, worst.target.calls),
    reachoutsPct: pctOf(worst.actual.reachouts, worst.target.reachouts),
    medianResponseMinutes: worst.actual.medianResponseMinutes,
    responseTargetMinutes: worst.target.responseTargetMinutes,
  };
}

/** The strip on My Day: this week, this person, nothing else. */
export async function myWeek(
  user: CrmUser,
  now: Date = new Date(),
): Promise<Omit<MyWeekResponse, "ok">> {
  const out = await accountability(user, { range: "week", now });
  const mine = user.rep ? (out.reps.find((r) => r.repId === user.rep!.id) ?? null) : null;
  return { window: out.window, rep: mine ?? out.reps[0] ?? null };
}
