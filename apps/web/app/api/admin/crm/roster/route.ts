import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import { listReps } from "~/features/crm/reps";
import {
  RosterPostBodySchema,
  RosterQuerySchema,
  isSevenShiftsConfigured,
  lastSevenShiftsSyncAt,
  listShiftsForDates,
  rosterDateLabel,
  rosterFromShiftRows,
  setOffToday,
  toRosterRows,
  type RosterResponse,
} from "~/features/crm/rules";

/**
 * /api/admin/crm/roster (wire contract: `rules/contracts.ts`)
 *   GET [?date=]   → today / tomorrow per rep with the "Status now" verdict,
 *                    whether anything has been mirrored from 7shifts yet (the
 *                    honest empty state), and when.
 *   POST director  `{repId, off, reason?, date?}` → the manual off-today
 *                  override (works with no 7shifts token), audited, returns
 *                  the refreshed roster.
 *
 * Dates are ET business dates; `date` defaults to ET today.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function rosterFor(date: string, now: Date): Promise<Omit<RosterResponse, "ok">> {
  const tomorrow = shiftYmd(date, 1);
  const [reps, rows, lastSyncedAt] = await Promise.all([
    listReps(),
    listShiftsForDates([date, tomorrow]),
    lastSevenShiftsSyncAt(),
  ]);
  const { shiftsToday, shiftsTomorrow } = rosterFromShiftRows(rows, {
    todayYmd: date,
    tomorrowYmd: tomorrow,
  });
  const clock = { shiftsToday, shiftsTomorrow, now };
  const dayInstant = date === todayEasternYmd(now) ? now : new Date(`${date}T17:00:00Z`);
  return {
    date,
    tomorrow,
    dateLabel: rosterDateLabel(dayInstant),
    rows: toRosterRows(reps, clock),
    mirrored: rows.some((r) => r.source === "7shifts"),
    lastSyncedAt,
    sevenShiftsConfigured: isSevenShiftsConfigured(),
    now: now.toISOString(),
  };
}

export const GET = withCrmRoute(RosterQuerySchema, async ({ input }) => {
  const now = new Date();
  return rosterFor(input.date ?? todayEasternYmd(now), now);
});

export const POST = withCrmRoute(
  RosterPostBodySchema,
  async ({ input, user }) => {
    const now = new Date();
    const date = input.date ?? todayEasternYmd(now);
    const reps = await listReps();
    const rep = reps.find((r) => r.id === input.repId);
    if (!rep) throw new CrmHttpError(404, "rep_not_found");
    const before = (await listShiftsForDates([date])).find(
      (r) => r.repId === rep.id && r.source === "manual",
    );
    const after = await setOffToday({
      repId: rep.id,
      date,
      off: input.off,
      reason: input.reason,
      actorEmail: user.email,
    });
    await writeAudit({
      entity: "shift_override",
      entityId: `${rep.slug}:${date}`,
      action: input.off ? "off-today" : "available",
      actorEmail: user.email,
      before: before ?? null,
      after,
    });
    return rosterFor(date, now);
  },
  { director: true },
);
