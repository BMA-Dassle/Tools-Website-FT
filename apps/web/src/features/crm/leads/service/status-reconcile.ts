/**
 * ADVANCE A LEAD WHOSE CONTRACT HAS ALREADY MOVED ON WITHOUT IT.
 *
 * Owner, 2026-09-14, on Kara Simmons: "this event should be in lead its
 * contract sent double check and fix." L-129 (#2950) read `assigned` on the
 * board while its contract had been signed on 1 July and the deposit paid — so
 * the queue card nagged "no touch · 1 h 33 m" about an event that was booked
 * and paid for.
 *
 * Our status is the SALES view and the contract the MONEY view of one record,
 * but they are written by different rails: a rep drags the board, the contract
 * moves when the guest signs or pays. Nothing reconciled them, so a deal that
 * progressed entirely through the guest's own actions kept whatever the rep
 * last set.
 *
 * ONE DIRECTION ONLY — FORWARD. This never pulls a status back. A rep who has
 * moved a deal on knows something the money does not (a verbal yes, a bounced
 * cheque), and a nightly job that undid their work would be worse than the
 * drift it fixes. Lost and No-response are skipped entirely: they are a
 * human's judgement about a guest, not a state money can infer.
 *
 * WAS A SCRIPT, IS NOW A SCHEDULE. It ran once by hand (4 of 151 leads were
 * behind; all 4 advanced) and the drift simply starts again the next day, so
 * it runs daily on the CRM's own job rail — the same shape as
 * `guest-intro-backstop`.
 */

import { isDbConfigured, sql } from "@ft/db";
import { recordActivity } from "~/features/crm/activities";
import { todayEasternYmd } from "../../core/dates";

/** Once a day, in ET. The overnight run is the one that matters. */
export function statusReconcileKey(now: Date): string {
  return `lead-status-reconcile:${todayEasternYmd(now)}`;
}

/**
 * How far along OUR pipeline each status sits.
 *
 * `lost` and `noresp` are absent on purpose — absent, not zero, so a future
 * edit cannot accidentally make them "behind" everything and have the money
 * drag a lost deal back to life.
 */
export const OUR_RANK: Readonly<Record<string, number>> = Object.freeze({
  new: 0,
  assigned: 1,
  contacted: 2,
  waiting: 2,
  quote: 3,
  contract: 4,
  deposit: 5,
  confirmed: 6,
});

/**
 * What a contract status PROVES about the deal, said as one of our statuses.
 *
 * Only the states that are evidence. `draft` proves nothing (a quote nobody
 * sent), and cancelled / denied / expired are excluded by the query rather
 * than mapped, because they are reasons to leave a lead alone.
 */
export const FROM_CONTRACT: Readonly<Record<string, string>> = Object.freeze({
  pending_approval: "quote",
  contract_sent: "contract",
  resign_required: "contract",
  deposit_paid: "deposit",
  balance_link_sent: "deposit",
  balance_funded: "deposit",
  // The money is in. That is a won deal whatever the board says.
  balance_charged: "confirmed",
  completed: "confirmed",
});

export interface ReconcileCandidate {
  id: string;
  publicId: string;
  statusId: string;
  projectNumber: string | null;
  gfStatus: string;
}

export interface ReconcileMove extends ReconcileCandidate {
  to: string;
}

/**
 * The decision, pure. Given the rows, which leads are BEHIND their contract?
 *
 * Split out from the query so the rule that moves real money-adjacent state is
 * a unit test rather than a live probe.
 */
export function movesFor(rows: readonly ReconcileCandidate[]): ReconcileMove[] {
  const out: ReconcileMove[] = [];
  for (const r of rows) {
    const to = FROM_CONTRACT[r.gfStatus];
    if (!to) continue;
    // An unknown status on either side ranks NOWHERE, and nowhere never wins.
    const want = OUR_RANK[to];
    const have = OUR_RANK[r.statusId];
    if (want === undefined || have === undefined) continue;
    if (want > have) out.push({ ...r, to });
  }
  return out;
}

export interface ReconcileResult {
  scanned: number;
  advanced: number;
  moves: ReconcileMove[];
}

export interface ReconcileDeps {
  listCandidates: () => Promise<ReconcileCandidate[]>;
  applyMove: (move: ReconcileMove) => Promise<void>;
  recordActivity: typeof recordActivity;
}

export function defaultReconcileDeps(): ReconcileDeps {
  return {
    listCandidates: async () => {
      // The "is there a database" guard lives HERE, in the real dependency,
      // not in `runStatusReconcile` — a guard inside the function that takes
      // injected deps makes the function untestable, which is exactly how it
      // first shipped: every test returned `skipped` and asserted nothing.
      if (!isDbConfigured()) return [];
      const q = sql();
      const rows = (await q`
        SELECT l.id::text AS id, l.public_id, l.status_id, l.bmi_project_number,
               gfq.status AS gf_status
          FROM crm_leads l
          JOIN group_function_quotes gfq ON gfq.bmi_reservation_id = l.bmi_project_id
         WHERE l.archived_at IS NULL
           AND gfq.status NOT IN ('cancelled', 'denied', 'expired')
           -- A human's verdict on a guest is never inferred from the money.
           AND l.status_id NOT IN ('lost', 'noresp')
         ORDER BY l.id
      `) as Array<{
        id: string;
        public_id: string;
        status_id: string;
        bmi_project_number: string | null;
        gf_status: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        publicId: r.public_id,
        statusId: r.status_id,
        projectNumber: r.bmi_project_number,
        gfStatus: r.gf_status,
      }));
    },
    applyMove: async (move) => {
      const q = sql();
      // Guarded by the status we READ: if a rep moved the card between the
      // scan and the write, theirs wins and this is a no-op. The job is a
      // safety net, never a competitor.
      await q`
        UPDATE crm_leads
           SET status_id = ${move.to}, updated_at = now()
         WHERE id = ${move.id}::bigint AND status_id = ${move.statusId}
      `;
    },
    recordActivity,
  };
}

/**
 * Run it. Never throws: a reconcile that dies takes the whole cron tick with
 * it, and nothing here is urgent enough to be worth that.
 */
export async function runStatusReconcile(
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<ReconcileResult> {
  const rows = await deps.listCandidates();
  const moves = movesFor(rows);
  let advanced = 0;
  for (const move of moves) {
    try {
      await deps.applyMove(move);
      // On the timeline, because a status that changed by itself has to say
      // who changed it and why — otherwise a rep finds their board rearranged
      // by nobody.
      await deps.recordActivity({
        leadId: move.id,
        actorEmail: "contract-reconcile",
        kind: "status",
        occurredAt: new Date(),
        body: `Status ${move.statusId} → ${move.to} — the contract is already ${move.gfStatus}`,
        meta: { from: move.statusId, to: move.to, gfStatus: move.gfStatus, reconcile: true },
      });
      advanced += 1;
    } catch (err) {
      console.error("[crm] status reconcile could not advance a lead", {
        public_id: move.publicId,
        from: move.statusId,
        to: move.to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { scanned: rows.length, advanced, moves };
}
