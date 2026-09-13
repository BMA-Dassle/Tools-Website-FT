/**
 * Weekly targets — the read every screen shares and the director's write.
 *
 * "Applies from next Monday" is not decoration: writing a target with today's
 * date would rewrite the week in progress, and a rep who has already worked
 * four days would find the bar moved under them. `nextMondayEt` is the default
 * and the sheet says so.
 *
 * The write is DIRECTOR ONLY, refused here as well as in the route — the route
 * carries `{director: true}`, and this second check means a future caller
 * (a job, a script, another service) cannot get round it by not being HTTP.
 */

import { listReps } from "~/features/crm/reps";
import { publicRep } from "~/features/crm/core/projections";
import { CrmHttpError } from "~/features/crm/core/http";
import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import type { CrmUser } from "~/features/crm/core/types";
import type { TargetsPostBody, TargetsResponse, WeeklyTarget } from "../contracts";
import {
  BUCKET_DEFAULT_TARGET,
  DEFAULT_TARGET,
  targetsAsOf,
  upsertTarget,
} from "../data/targets-db";
import { measurableRoster, visibleRoster } from "./accountability";
import { dayOfWeek, mondayOf } from "./windows";

/** The Monday AFTER the ET week containing `now` — when a saved target starts. */
export function nextMondayEt(now: Date = new Date()): string {
  const today = todayEasternYmd(now);
  return shiftYmd(mondayOf(today), 7);
}

export async function listTargets(
  user: CrmUser,
  now: Date = new Date(),
): Promise<Omit<TargetsResponse, "ok">> {
  const allReps = await listReps({ includeInactive: false });
  const visible = visibleRoster(user, allReps);
  const rows = await targetsAsOf(mondayOf(todayEasternYmd(now)));
  return {
    targets: visible.map((rep) => ({
      repSlug: rep.slug,
      target:
        rows.get(rep.id) ??
        ({ ...(rep.role === "bucket" ? BUCKET_DEFAULT_TARGET : DEFAULT_TARGET) } as WeeklyTarget),
    })),
    reps: visible.map((r) => publicRep(r)!).filter(Boolean),
  };
}

const MAX_PER_WEEK = 2000;

function bounded(n: number, field: string): number {
  if (!Number.isFinite(n) || n < 0) throw new CrmHttpError(400, `invalid_${field}`);
  return Math.min(MAX_PER_WEEK, Math.round(n));
}

export async function saveTarget(
  user: CrmUser,
  body: TargetsPostBody,
  now: Date = new Date(),
): Promise<Omit<TargetsResponse, "ok">> {
  if (user.role !== "director") throw new CrmHttpError(403, "director_only");

  const allReps = await listReps({ includeInactive: false });
  const rep = measurableRoster(allReps).find((r) => r.slug === body.repSlug);
  if (!rep) throw new CrmHttpError(404, `unknown_rep: ${body.repSlug}`);

  const effectiveFrom = body.effectiveFrom ?? nextMondayEt(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new CrmHttpError(400, "invalid_date");
  // A target that starts mid-week would measure a week that is already half
  // run against a bar nobody saw on Monday.
  if (dayOfWeek(effectiveFrom) !== 1) throw new CrmHttpError(400, "effective_from_must_be_monday");

  await upsertTarget(
    {
      repId: rep.id,
      effectiveFrom,
      calls: bounded(body.calls, "calls"),
      texts: bounded(body.texts, "texts"),
      emails: bounded(body.emails, "emails"),
      reachouts: bounded(body.reachouts, "reachouts"),
      responseTargetMinutes: Math.max(1, Math.min(24 * 60, Math.round(body.responseTargetMinutes))),
    },
    user.email,
  );

  return listTargets(user, now);
}
