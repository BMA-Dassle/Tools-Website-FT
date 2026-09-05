/**
 * Check-in schedule sweep — the queue that finishes seating racers the kiosk
 * couldn't seat inline (kiosk-bmi-sync-sweep cron, every 2 min).
 *
 * WHY: the cloud attach (registerProjectPerson) reaches the center's LOCAL
 * Firebird only via Fast WSync, whose cloud→local lag is measured in MINUTES.
 * The old in-request ladder retried for ~34s, folded the vendor's own
 * "retryable" answer (person_not_on_project) into a terminal 'failed', and
 * memo'd staff to hand-seat — which minted the duplicate T_PROJECT_PERSON row
 * that jammed WSync for the whole center (2026-08-11). This sweep is the
 * missing patience: it re-drives 'waiting-sync' rows across minutes, and only
 * involves staff when sync is genuinely stuck.
 *
 * SYNC BARRIERS (owner rule 2026-08-12 — one writer per entity, wait for
 * cross-rail visibility, never dual-write):
 *  - Barrier A (local→cloud): a row whose attach hasn't landed is re-attached
 *    only once its person resolves on the Office cloud (`fetchOfficePerson`).
 *  - Barrier B (cloud→local): the schedule POST itself is the probe — Pandora
 *    answers person_not_on_project until WSync delivers the row; we simply try
 *    again next tick. The insert is idempotent per racer (already_linked), so
 *    re-POSTing never double-links.
 *
 * ESCALATION: still waiting after MEMO_AFTER (10 min — ~2× the typical ~6 min
 * lag) → ONE staff memo, worded so nobody hand-seats unless the heat is about
 * to start.
 *
 * GIVING UP IS KEYED TO THE HEAT, NOT A CLOCK (2026-09-05). A row stops being
 * worth re-driving when its last bound heat has gone (+ SWEEP_HEAT_GRACE_MS),
 * because only then is there nothing left to seat anyone on. The old flat
 * 60-minute rule wrote `failed` — the label reserved for a vendor REFUSAL — onto
 * rows that were merely slow, and `listPendingScheduleRows` excludes `failed`
 * forever, so nothing ever re-seated them. That is why the grid could not repair
 * itself; see `classifyRowAge`. The 60-minute rule survives only for a row that
 * names no heat, where there is no better moment to measure against.
 *
 * Scoped to TODAY's business date, so the historical failed backlog is never
 * resurrected.
 */
import {
  listPendingScheduleRows,
  setCheckinPersonStatus,
  type PendingScheduleRow,
} from "../data/kiosk-checkins-db";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import { fetchOfficePerson, appendProjectPrivateNote } from "@/lib/bmi-office-actions";
import { nyNaiveToUtcMs } from "@/lib/bmi-sync-lapse";
import { officeProjectIdFromBillId } from "@/lib/bmi-office-ids";
import { getBowlingReservationByBillId } from "@/lib/bowling-db";
import { getRaceProductById } from "~/features/booking/service/race-products";
import { todayET } from "~/features/daily-events/format";
import {
  scheduleCheckinRacers,
  heatStopFor,
  type ScheduleRacer,
  type RacerOutcome,
} from "./schedule-racers";

export const SWEEP_MEMO_AFTER_MS = 10 * 60_000;
export const SWEEP_TERMINAL_AFTER_MS = 60 * 60_000;

/** Marker stored in the row's errors JSONB so the 10-minute memo fires once. */
const MEMO_MARKER_STEP = "schedule-sweep-memo";

export function hasSweepMemoMarker(errors: unknown): boolean {
  return (
    typeof errors === "object" &&
    errors !== null &&
    (errors as { step?: unknown }).step === MEMO_MARKER_STEP
  );
}

export type RowAgeClass = "retry" | "memo-then-retry" | "terminal";

/**
 * Grace past a racer's own heat before seating them stops being worth doing.
 * Heats routinely run 6-20 min behind, so the heat's clock time is not the
 * moment the chance is gone.
 */
export const SWEEP_HEAT_GRACE_MS = 20 * 60_000;

/**
 * Where this row sits on the patience ladder.
 *
 * A TIMEOUT IS NOT A REFUSAL (2026-09-05). This used to return `terminal` purely
 * on `age >= 60 min`, and the caller writes that straight to
 * `schedule_status = 'failed'` — the same label the vendor's real refusals get.
 * `listPendingScheduleRows` then excludes `failed` forever ("terminal by
 * definition"), so a racer whose WSync was merely slow was never seated again by
 * anything.
 *
 * That is why the grid could not repair itself, and it is the same shape as the
 * waiver black hole fixed earlier today: work that was still perfectly doable got
 * written off because a clock ran out. Measured 2026-09-05: 133 of 806 schedule
 * rows sit `failed`, and 25 of the 26 stamps that lapsed waiting on the grid had
 * every racer at `inserted` — their own error text saying
 * "retryable: person_not_on_project — kiosk-bmi-sync-sweep re-seats", aged out
 * into terminal an hour later. Meanwhile the stamp that depends on the grid waits
 * 480 minutes, so for seven of its eight hours nothing was still trying.
 *
 * So the question becomes the one that actually matters: IS THERE STILL A HEAT TO
 * SEAT THEM ON? While the racer's last bound heat is ahead (plus grace), keep
 * trying — the work is doable and a guest is going to want their seat. Once the
 * heat has gone, seating them achieves nothing and the row is genuinely finished.
 *
 * The 60-minute rule stays as the fallback for a row we cannot date: no bound
 * heats means no moment to measure against, and retrying forever on an unknowable
 * row is how a sweep becomes a load generator.
 */
export function classifyRowAge(
  createdAtIso: string,
  nowMs: number,
  /** Last bound heat as epoch ms, or null when the row names no heat. */
  lastHeatMs?: number | null,
): RowAgeClass {
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return "terminal"; // unparseable — don't retry forever
  const age = nowMs - createdMs;

  if (lastHeatMs != null && Number.isFinite(lastHeatMs)) {
    // The heat is the deadline, not the clock since check-in.
    if (nowMs > lastHeatMs + SWEEP_HEAT_GRACE_MS) return "terminal";
    return age >= SWEEP_MEMO_AFTER_MS ? "memo-then-retry" : "retry";
  }

  if (age >= SWEEP_TERMINAL_AFTER_MS) return "terminal";
  if (age >= SWEEP_MEMO_AFTER_MS) return "memo-then-retry";
  return "retry";
}

/**
 * The latest heat this row is bound to, as epoch ms — the moment after which
 * seating it is pointless. Null when the row names no parseable heat.
 *
 * `heatId` is a naive center-local `YYYY-MM-DDTHH:MM`, converted by the SAME
 * helper the stamp's lapse rule uses, deliberately: two copies of a timezone
 * conversion is how this repo has been bitten before, and these two rails must
 * agree on when a heat has passed or one will keep seating for a moment the
 * other has already written off.
 */
export function lastBoundHeatMs(boundHeats: unknown): number | null {
  if (!Array.isArray(boundHeats)) return null;
  let latest: number | null = null;
  for (const h of boundHeats as BoundHeat[]) {
    if (!h || typeof h.heatId !== "string") continue;
    const ms = nyNaiveToUtcMs(h.heatId);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * Where a row sits relative to its own heat, in words.
 *
 * Every log line about an unseated racer is useless without this. On 2026-09-05 it
 * took eight ad-hoc probe scripts to establish that a row reading "not on the grid"
 * was simply twenty minutes early — a fact the sweep knew all along and never said.
 */
export function heatPositionLabel(lastHeatMs: number | null, nowMs: number): string {
  if (lastHeatMs == null) return "no heat named";
  const mins = Math.round((lastHeatMs - nowMs) / 60_000);
  if (mins > 0) return `heat in ${mins}m`;
  if (mins === 0) return "heat now";
  return `heat ${Math.abs(mins)}m ago`;
}

interface BoundHeat {
  heatId?: string;
  track?: string | null;
  tier?: string;
  category?: string;
  productId?: string | null;
}

/** Rebuild the schedule payload from the row's persisted bound_heats — the
 *  exact mapping completeCheckin's assignToSlot used when it bound them. */
export function buildRacersFromRow(row: {
  personId: string | null;
  pandoraPersonId: string | null;
  displayName: string;
  firstName: string | null;
  boundHeats: unknown;
}): ScheduleRacer[] {
  const schedulableId = row.pandoraPersonId || row.personId;
  if (!schedulableId || !Array.isArray(row.boundHeats)) return [];
  const name = row.firstName || row.displayName || "Racer";
  const racers: ScheduleRacer[] = [];
  for (const h of row.boundHeats as BoundHeat[]) {
    if (!h || typeof h !== "object" || !h.heatId) continue;
    const productId = h.productId ?? null;
    const product = productId ? getRaceProductById(productId) : null;
    racers.push({
      racerName: name,
      personId: schedulableId,
      product: product?.name ?? "Race",
      productId,
      tier: h.tier || product?.tier || "starter",
      track: (h.track as ScheduleRacer["track"]) ?? null,
      category: h.category || product?.category || "adult",
      heatName: product?.name ?? "Race",
      heatStart: h.heatId,
      heatStop: heatStopFor(h.heatId),
    });
  }
  return racers;
}

const isShortId = (id: string | null) => !!id && id.length < 15;

export interface ScheduleSweepSummary {
  rows: number;
  bills: number;
  seated: number;
  attachLanded: number;
  waitingPersonSync: number;
  stillWaiting: number;
  memoed: number;
  terminal: number;
  refused: number;
  deferred: number;
  errors: number;
  outcomes: Array<{
    billId: string;
    person: string;
    outcome: string;
    /** Heat position — "heat in 20m" / "heat 15m ago" / "no heat named". The
     *  field that turns "not seated" into "not seated YET" or "genuinely late". */
    where?: string;
    detail?: string;
  }>;
}

export async function runCheckinScheduleSweep(opts: {
  dryRun: boolean;
  deadlineAtMs?: number;
}): Promise<ScheduleSweepSummary> {
  const summary: ScheduleSweepSummary = {
    rows: 0,
    bills: 0,
    seated: 0,
    attachLanded: 0,
    waitingPersonSync: 0,
    stillWaiting: 0,
    memoed: 0,
    terminal: 0,
    refused: 0,
    deferred: 0,
    errors: 0,
    outcomes: [],
  };

  const rows = await listPendingScheduleRows(todayET());
  summary.rows = rows.length;
  if (rows.length === 0) return summary;

  const byBill = new Map<string, PendingScheduleRow[]>();
  for (const r of rows) {
    const list = byBill.get(r.billId) ?? [];
    list.push(r);
    byBill.set(r.billId, list);
  }
  summary.bills = byBill.size;

  for (const [billId, group] of byBill) {
    if (opts.deadlineAtMs && Date.now() > opts.deadlineAtMs) {
      summary.deferred += group.length;
      continue;
    }
    try {
      await sweepBill(billId, group, opts, summary);
    } catch (err) {
      summary.errors++;
      console.error(
        `[checkin-schedule-sweep] bill ${billId} errored:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}

/** One reservation's queued rows: barrier A, then the schedule POST, then the
 *  patience ladder (memo at 10 min, terminal at 60). */
async function sweepBill(
  billId: string,
  group: PendingScheduleRow[],
  opts: { dryRun: boolean },
  summary: ScheduleSweepSummary,
): Promise<void> {
  const nowMs = Date.now();
  // Check-in schedule rows are racing, and racing lives on the FastTrax rails —
  // the same centerCode completeCheckin stamps state/memo with.
  const centerCode = "fasttrax";
  const clientKey = group[0]?.center === "naples" ? "headpinznaples" : "headpinzftmyers";
  /**
   * One line per racer per tick. `where` is the heat position, always — an
   * outcome without it cannot answer the only question anyone asks of this sweep
   * ("should it have happened by now?"), which is what made 2026-09-05 a
   * script-writing exercise instead of a log read.
   */
  const note = (person: string, outcome: string, detail?: string, where?: string) =>
    summary.outcomes.push({
      billId,
      person,
      outcome,
      ...(where ? { where } : {}),
      ...(detail ? { detail } : {}),
    });

  // Names for the single composed staff memo (one per bill per tick).
  const memoSyncStuck: string[] = [];
  const memoTerminal: string[] = [];

  const markTerminal = async (row: PendingScheduleRow, reason: string): Promise<void> => {
    summary.terminal++;
    memoTerminal.push(row.displayName);
    note(
      row.displayName,
      "terminal",
      reason,
      heatPositionLabel(lastBoundHeatMs(row.boundHeats), nowMs),
    );
    if (!opts.dryRun) {
      await setCheckinPersonStatus(row.id, {
        scheduleStatus: "failed",
        error: { step: "schedule-sweep", message: reason },
      });
    }
  };

  // ── Barrier A: attach must exist cloud-side before the seat can ever land ──
  const schedulable: PendingScheduleRow[] = [];
  for (const row of group) {
    const lastHeatMs = lastBoundHeatMs(row.boundHeats);
    if (classifyRowAge(row.createdAt, nowMs, lastHeatMs) === "terminal") {
      await markTerminal(
        row,
        lastHeatMs == null
          ? "no heat named and still unseated after 60 min — seat by hand"
          : "their last heat has gone — there is nothing left to seat them on",
      );
      continue;
    }
    if (row.bmiAttachStatus === "attached" || !row.personId) {
      // No personId: nothing to attach with — let the schedule POST answer
      // (person_not_on_project until the give-up clock runs out).
      schedulable.push(row);
      continue;
    }
    const person = await fetchOfficePerson(row.personId, clientKey);
    if (!person) {
      summary.waitingPersonSync++;
      note(
        row.displayName,
        "waiting-person-sync",
        undefined,
        heatPositionLabel(lastBoundHeatMs(row.boundHeats), nowMs),
      );
      continue; // next tick — the person hasn't crossed local→cloud yet
    }
    if (opts.dryRun) {
      note(row.displayName, "would-attach");
      continue;
    }
    try {
      const res = await registerProjectPersonServer({
        clientKey,
        orderId: billId, // a BILL id — what the public-booking endpoint means by orderId
        personId: row.personId,
        firstName: row.firstName ?? row.displayName.split(" ")[0] ?? "Guest",
        lastName: row.lastName ?? "",
      });
      if (res.ok) {
        summary.attachLanded++;
        await setCheckinPersonStatus(row.id, { bmiAttachStatus: "attached" });
        schedulable.push(row);
      } else {
        // A declared refusal with the person VISIBLE cloud-side is not sync lag
        // — it's terminal, and staff need to know now.
        summary.refused++;
        memoTerminal.push(row.displayName);
        note(row.displayName, "attach-refused", `${res.status}: ${res.body.slice(0, 200)}`);
        await setCheckinPersonStatus(row.id, {
          bmiAttachStatus: "failed",
          scheduleStatus: "failed",
          error: { step: "schedule-sweep", message: `attach refused: ${res.status}` },
        });
      }
    } catch {
      note(row.displayName, "attach-transport"); // next tick
    }
  }

  // ── Barrier B: the schedule POST is the cloud→local visibility probe ──────
  if (schedulable.length > 0 && !opts.dryRun) {
    const reservation = await getBowlingReservationByBillId(billId);
    const reservationNumber = reservation?.bmiReservationNumber ?? "";
    if (!reservationNumber) {
      // Without a W-number the endpoint is unaddressable — terminal, tell staff.
      for (const row of schedulable) await markTerminal(row, "no reservation number on file");
    } else {
      const racersByRowId = new Map(schedulable.map((r) => [r.id, buildRacersFromRow(r)]));
      const racers = [...racersByRowId.values()].flat();
      const outcomes: RacerOutcome[] = [];
      // Same two-batch isolation as completeCheckin: one 17-digit Office id
      // 500s a whole Pandora batch, so it never rides with the short ids.
      for (const batch of [
        racers.filter((r) => isShortId(r.personId)),
        racers.filter((r) => !isShortId(r.personId)),
      ]) {
        if (batch.length === 0) continue;
        const part = await scheduleCheckinRacers({ reservationNumber, racers: batch });
        outcomes.push(...part.outcomes);
      }
      for (const row of schedulable) {
        const ids = new Set([row.pandoraPersonId, row.personId].filter((v): v is string => !!v));
        const mine = outcomes.filter((o) => ids.has(o.personId));
        if (mine.length === 0) continue; // no heats rebuilt — nothing to record
        const refused = mine.find((o) => o.kind === "refused");
        const waiting = mine.find((o) => o.kind === "waiting");
        if (refused) {
          summary.refused++;
          memoTerminal.push(row.displayName);
          note(row.displayName, "schedule-refused", refused.vendorStatus);
          await setCheckinPersonStatus(row.id, {
            scheduleStatus: "failed",
            error: { step: "schedule-sweep", message: `refused: ${refused.vendorStatus}` },
          });
        } else if (waiting) {
          summary.stillWaiting++;
          note(
            row.displayName,
            "still-waiting",
            waiting.vendorStatus,
            heatPositionLabel(lastBoundHeatMs(row.boundHeats), nowMs),
          );
          if (
            classifyRowAge(row.createdAt, nowMs, lastBoundHeatMs(row.boundHeats)) ===
              "memo-then-retry" &&
            !hasSweepMemoMarker(row.errors)
          ) {
            memoSyncStuck.push(row.displayName);
            await setCheckinPersonStatus(row.id, {
              error: { step: MEMO_MARKER_STEP, message: "10-min sync memo written" },
            });
          }
        } else {
          summary.seated++;
          note(row.displayName, "seated");
          await setCheckinPersonStatus(row.id, { scheduleStatus: "inserted", error: null });
        }
      }
    }
  } else if (schedulable.length > 0 && opts.dryRun) {
    for (const row of schedulable) note(row.displayName, "would-schedule");
  }

  // ── One composed staff memo per bill per tick, only when something is owed ──
  if (!opts.dryRun && (memoSyncStuck.length > 0 || memoTerminal.length > 0)) {
    const officeProjectId = officeProjectIdFromBillId(billId);
    const parts: string[] = [];
    if (memoSyncStuck.length > 0) {
      parts.push(
        `still adding to session (sync running >10 min, auto-retry continues): ` +
          `${[...new Set(memoSyncStuck)].join(", ")} — only seat by hand if the heat is about to start`,
      );
    }
    if (memoTerminal.length > 0) {
      parts.push(
        `AUTO CHECK-IN INCOMPLETE — please check into session: ${[...new Set(memoTerminal)].join(", ")}`,
      );
    }
    summary.memoed += memoSyncStuck.length + memoTerminal.length;
    try {
      await appendProjectPrivateNote({
        centerCode,
        projectId: officeProjectId,
        note: `Kiosk check-in sweep: ${parts.join(" | ")}`,
        billId,
      });
    } catch (err) {
      console.error(`[checkin-schedule-sweep] memo failed for bill ${billId}:`, err);
    }
  }
}
