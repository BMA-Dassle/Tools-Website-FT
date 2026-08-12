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
 * to start. Still waiting after TERMINAL_AFTER (60 min) → the row goes
 * 'failed' and exits the sweep. Scoped to TODAY's business date, so the
 * historical failed backlog is never resurrected.
 */
import {
  listPendingScheduleRows,
  setCheckinPersonStatus,
  type PendingScheduleRow,
} from "../data/kiosk-checkins-db";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import { fetchOfficePerson, appendProjectPrivateNote } from "@/lib/bmi-office-actions";
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

/** Where this row sits on the patience ladder, from its creation time. */
export function classifyRowAge(createdAtIso: string, nowMs: number): RowAgeClass {
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return "terminal"; // unparseable — don't retry forever
  const age = nowMs - createdMs;
  if (age >= SWEEP_TERMINAL_AFTER_MS) return "terminal";
  if (age >= SWEEP_MEMO_AFTER_MS) return "memo-then-retry";
  return "retry";
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
  outcomes: Array<{ billId: string; person: string; outcome: string; detail?: string }>;
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
  const note = (person: string, outcome: string, detail?: string) =>
    summary.outcomes.push({ billId, person, outcome, ...(detail ? { detail } : {}) });

  // Names for the single composed staff memo (one per bill per tick).
  const memoSyncStuck: string[] = [];
  const memoTerminal: string[] = [];

  const markTerminal = async (row: PendingScheduleRow, reason: string): Promise<void> => {
    summary.terminal++;
    memoTerminal.push(row.displayName);
    note(row.displayName, "terminal", reason);
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
    if (classifyRowAge(row.createdAt, nowMs) === "terminal") {
      await markTerminal(row, "sync timeout (60 min) — seat by hand");
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
      note(row.displayName, "waiting-person-sync");
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
          note(row.displayName, "still-waiting", waiting.vendorStatus);
          if (
            classifyRowAge(row.createdAt, nowMs) === "memo-then-retry" &&
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
