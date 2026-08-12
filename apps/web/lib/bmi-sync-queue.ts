/**
 * BMI sync queue — the ONE place cross-rail BMI followups wait for the other
 * side to catch up.
 *
 * WHY THIS EXISTS (owner 2026-08-12): BMI has two stores that converge only via
 * Fast WSync — the vendor CLOUD (public-booking / Office) and each center's
 * LOCAL Firebird (Pandora). Writing to one and immediately reading or writing
 * the other is the shape behind most of our BMI incidents: the 8/11 duplicate
 * projectPerson jam (we quit after 34s and staff hand-seated), the 7/22 kiosk
 * state clobber, the 8/3 split-brain. The owner's rule is now explicit — "cloud
 * is first, onsite second" — and this queue is the mechanism: the guest-critical
 * chain completes entirely CLOUD-side, and every LOCAL followup becomes a row
 * here that fires only once its barrier says the other side can see the thing.
 *
 * DESIGN — deliberately narrow:
 *  - A `barrier` is a first-class column, not handler logic. The cron checks it
 *    BEFORE calling the handler, so "wait for visibility" can never be
 *    forgotten by a new handler author.
 *  - **The person-local barrier tests `status !== 404`, NOT `=== 200`.** Measured
 *    2026-08-12: a cloud-minted person answers Pandora with **500 "Response
 *    Validator Error"** while its birthdate is null — it IS present, just
 *    unreadable. A queue waiting for 200 waits forever on a row that already
 *    landed. 404 (and only 404) means "not here yet".
 *  - Idempotency is a UNIQUE key, so enqueueing the same followup twice is a
 *    no-op (the deposit-retry pattern).
 *  - Escalating backoff + a per-kind give-up deadline + PARKING, and parked rows
 *    are reported on EVERY run including the idle one, so "gave up" never looks
 *    like "all clear" (lesson: `bmi-deposit-retry`).
 *  - Chaining, not a DAG: a handler may enqueue its successor. That covers every
 *    sequence we have (mint → repair → waiver → membership → seat) without a
 *    workflow engine.
 *
 * DELIBERATELY OUT OF SCOPE: money. The deposit-retry and project-payment
 * sweeps keep their own rails — their safety semantics (re-read the vendor
 * ledger, post `min(collected − recorded, balance, row)`) were paid for in
 * incidents and do not generalize. This queue is for SYNC followups only.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). BMI ids stay TEXT end-to-end;
 * never Number() them.
 */
import { sql, isDbConfigured } from "@/lib/db";

/** What the handler does. One handler per kind, registered in bmi-sync-handlers. */
export type SyncKind =
  /** Pandora PATCH: write birthdate (+ email/phone) onto a cloud-minted person
   *  so every Pandora consumer can read it at all. */
  | "repair-person-details"
  /** Pandora POST /bmi/waiver: create the waiver RECORD for a signature we
   *  already hold in Neon. */
  | "push-waiver-signature"
  /** Pandora addMembership — the FastTrax racing LICENCE ("License Fee",
   *  LICENSE_MEMBERSHIP_KIND_ID) is the only kind wired today, so a row here means
   *  "grant the licence this guest paid for". Was called add-default-membership,
   *  which implied a generic default that does not exist (owner 2026-08-12: "if
   *  they bought a license give them that instead of the default membership").
   *  The payload carries the purchase ref so a granted licence is traceable to
   *  the money that bought it. */
  | "add-membership"
  /** public-booking registerProjectPerson: attach a person to an order. */
  | "attach-project-person"
  /** Stamp the BMI project's "Confirmation Kiosk" / "Confirmation - Express"
   *  custom state — but ONLY once the whole party is local AND waivered (owner
   *  2026-08-12). Staff read that state as "party is here and checked in", so its
   *  ARRIVAL is now the signal that the on-site sync finished. */
  | "stamp-confirmation-state";

/** What must be VISIBLE before the handler may run. */
export type SyncBarrier =
  /** The person exists on the center's LOCAL server (Pandora). 404 = wait. */
  | "person-local"
  /** The person exists on the vendor CLOUD (Office). null = wait. */
  | "person-cloud"
  /** The reservation/project has synced DOWN to the local server. */
  | "project-local"
  /** EVERY party member (payload.personIds) is local AND has a valid waiver.
   *  Stricter than person-local: needs a real 200 per member, because an
   *  unreadable record cannot prove a waiver. */
  | "party-ready"
  /** Fire immediately. */
  | "none";

export type SyncStatus = "pending" | "done" | "parked" | "cancelled";

export interface SyncQueueRow {
  id: number;
  kind: SyncKind;
  idempotencyKey: string;
  barrier: SyncBarrier;
  /** The id the barrier probes — a personId or a projectId. */
  barrierRef: string | null;
  /** Pandora location id the barrier probes against (and handlers default to). */
  locationId: string | null;
  /** The reservation this followup belongs to — a BMI bill id or W-number.
   *  Purely for GROUPING: it is what lets the admin board show "is the on-site
   *  work for this reservation done?" without joining through personIds. */
  reservationRef: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  giveUpAt: string | null;
  status: SyncStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** Per-kind patience. Deliberately generous: the whole point is to out-wait
 *  Fast WSync rather than escalate to a human who will hand-write the other
 *  side (which is exactly how the 8/11 duplicate rows were born). */
export const GIVE_UP_MINUTES: Record<SyncKind, number> = {
  "repair-person-details": 120,
  "push-waiver-signature": 720, // a waiver is worth chasing all day
  "add-membership": 720,
  "attach-project-person": 120,
  // Long: a party can legitimately take a while to finish signing, and the state
  // arriving late is the POINT. Ends well before the business day does.
  "stamp-confirmation-state": 480,
};

export const MAX_ATTEMPTS = 40;

/** Escalating backoff, capped: 30s × attempt, max 10 min. The first check is
 *  ~30s because a cloud→local PERSON lands in ~19-32s (measured 2026-08-12). */
export function backoffSeconds(attempts: number): number {
  return Math.min(600, 30 * Math.max(1, attempts));
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS bmi_sync_queue (
      id              BIGSERIAL PRIMARY KEY,
      kind            TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      barrier         TEXT NOT NULL DEFAULT 'none',
      barrier_ref     TEXT,
      location_id     TEXT,
      reservation_ref TEXT,
      payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      give_up_at      TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'pending',
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at     TIMESTAMPTZ
    )
  `;
  /**
   * ADDITIVE MIGRATIONS, not just CREATE TABLE.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so a column
   * added to the definition later never reaches a database that already ran the
   * original — every read of it then fails with `errorMissingColumn`. Caught the
   * hard way 2026-08-12: `reservation_ref` (the admin board's grouping key) was
   * added to the CREATE above, the live table already existed from an earlier
   * run, and the queue-peek tool blew up on the missing column — which is
   * exactly what the admin panel would have done on deploy.
   *
   * So every column added after the first release gets an explicit
   * ADD COLUMN IF NOT EXISTS here. Cheap, idempotent, and it makes the schema
   * block the single source of truth for what the table really has.
   */
  await q`ALTER TABLE bmi_sync_queue ADD COLUMN IF NOT EXISTS reservation_ref TEXT`;
  await q`
    CREATE UNIQUE INDEX IF NOT EXISTS bmi_sync_queue_idem
    ON bmi_sync_queue (idempotency_key)
  `;
  // The cron's read: due pending rows, oldest first. Partial index stays tiny
  // because rows resolve within minutes.
  await q`
    CREATE INDEX IF NOT EXISTS bmi_sync_queue_due
    ON bmi_sync_queue (next_attempt_at, created_at)
    WHERE status = 'pending'
  `;
  await q`
    CREATE INDEX IF NOT EXISTS bmi_sync_queue_reservation
    ON bmi_sync_queue (reservation_ref)
    WHERE reservation_ref IS NOT NULL
  `;
  await q`
    CREATE INDEX IF NOT EXISTS bmi_sync_queue_barrier_ref
    ON bmi_sync_queue (barrier_ref)
    WHERE status = 'pending'
  `;
  schemaReady = true;
}

function mapRow(r: Record<string, unknown>): SyncQueueRow {
  return {
    id: Number(r.id),
    kind: String(r.kind) as SyncKind,
    idempotencyKey: String(r.idempotency_key),
    barrier: String(r.barrier) as SyncBarrier,
    barrierRef: r.barrier_ref === null ? null : String(r.barrier_ref),
    locationId: r.location_id === null ? null : String(r.location_id),
    reservationRef: r.reservation_ref === null ? null : String(r.reservation_ref),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts),
    nextAttemptAt: String(r.next_attempt_at),
    giveUpAt: r.give_up_at === null ? null : String(r.give_up_at),
    status: String(r.status) as SyncStatus,
    lastError: r.last_error === null ? null : String(r.last_error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
  };
}

export interface EnqueueSyncParams {
  kind: SyncKind;
  /** Stable per-followup key. Re-enqueueing the same work is a no-op. */
  idempotencyKey: string;
  barrier?: SyncBarrier;
  barrierRef?: string | null;
  locationId?: string | null;
  /** BMI bill id or W-number, for admin grouping. */
  reservationRef?: string | null;
  payload?: Record<string, unknown>;
  /** Override the per-kind default patience. */
  giveUpMinutes?: number;
  /** Delay the first attempt (default: due immediately — the barrier gates it). */
  delaySeconds?: number;
}

/**
 * Add a followup. Idempotent per `idempotencyKey`: a duplicate enqueue MERGES
 * into the payload of a still-pending row and NEVER resurrects a resolved one (a
 * finished followup must not run twice because a retried request replayed the
 * enqueue).
 *
 * MERGE, NOT REPLACE (`old || new`) — caught by the live smoke 2026-08-12: the
 * replace version let a thinner replay silently DROP fields, and the handler then
 * repaired a person's birthdate while losing the email and phone that the first
 * enqueue carried. jsonb `||` keeps every key and lets the newer value win on
 * the ones that overlap, so a replay can refresh a field but never erase one.
 */
export async function enqueueSync(params: EnqueueSyncParams): Promise<SyncQueueRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const giveUp = params.giveUpMinutes ?? GIVE_UP_MINUTES[params.kind];
  const rows = (await q`
    INSERT INTO bmi_sync_queue
      (kind, idempotency_key, barrier, barrier_ref, location_id, reservation_ref,
       payload, next_attempt_at, give_up_at)
    VALUES
      (${params.kind}, ${params.idempotencyKey}, ${params.barrier ?? "none"},
       ${params.barrierRef ?? null}, ${params.locationId ?? null},
       ${params.reservationRef ?? null},
       ${JSON.stringify(params.payload ?? {})}::jsonb,
       now() + (${params.delaySeconds ?? 0} * INTERVAL '1 second'),
       now() + (${giveUp} * INTERVAL '1 minute'))
    ON CONFLICT (idempotency_key) DO UPDATE SET
      payload         = bmi_sync_queue.payload || EXCLUDED.payload,
      reservation_ref = COALESCE(EXCLUDED.reservation_ref, bmi_sync_queue.reservation_ref),
      updated_at      = now()
    WHERE bmi_sync_queue.status = 'pending'
    RETURNING *
  `) as Array<Record<string, unknown>>;
  // No row returned = the conflict hit a non-pending row, which is the correct
  // no-op (already done/parked/cancelled).
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Due pending rows, oldest first. */
export async function listDueSyncRows(limit = 100): Promise<SyncQueueRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM bmi_sync_queue
    WHERE status = 'pending' AND next_attempt_at <= now()
    ORDER BY created_at ASC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Handler succeeded — the followup is done for good. */
export async function markSyncDone(id: number, note?: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE bmi_sync_queue
    SET status = 'done', resolved_at = now(), updated_at = now(),
        last_error = ${note ?? null}
    WHERE id = ${id}
  `;
}

/**
 * Not yet — either the barrier is still closed or the handler failed
 * retryably. Bumps attempts + backoff, and PARKS the row once it runs out of
 * patience (attempts or the give-up deadline). Parking is visible, never silent:
 * the cron reports parked rows on every run.
 */
export async function markSyncRetry(
  row: SyncQueueRow,
  error: string,
  opts?: { countAttempt?: boolean },
): Promise<"retry" | "parked"> {
  if (!isDbConfigured()) return "retry";
  await ensureSchema();
  const q = sql();
  // A CLOSED BARRIER IS NOT A FAILED ATTEMPT. Waiting on sync must not burn the
  // attempt budget, or a slow WSync would park a row that never actually ran —
  // the give_up_at deadline is what bounds waiting.
  const countAttempt = opts?.countAttempt ?? true;
  const attempts = row.attempts + (countAttempt ? 1 : 0);
  const expired = row.giveUpAt !== null && Date.parse(row.giveUpAt) <= Date.now();
  const park = expired || attempts >= MAX_ATTEMPTS;
  await q`
    UPDATE bmi_sync_queue
    SET attempts = ${attempts},
        status = ${park ? "parked" : "pending"},
        next_attempt_at = now() + (${backoffSeconds(attempts)} * INTERVAL '1 second'),
        last_error = ${error.slice(0, 500)},
        resolved_at = ${park ? new Date().toISOString() : null},
        updated_at = now()
    WHERE id = ${row.id}
  `;
  return park ? "parked" : "retry";
}

/** Rows that ran out of patience. Reported on EVERY cron run — including the
 *  idle one — so a give-up is never mistaken for a clean sweep. */
export async function listParkedSyncRows(limit = 50): Promise<SyncQueueRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM bmi_sync_queue
    WHERE status = 'parked'
    ORDER BY resolved_at DESC NULLS LAST
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Ops/among-tests visibility for one entity's outstanding followups. */
export async function listSyncRowsForRef(barrierRef: string): Promise<SyncQueueRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM bmi_sync_queue
    WHERE barrier_ref = ${barrierRef}
    ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Counts by status+kind for the cron summary and the admin view. */
export async function syncQueueCounts(): Promise<
  Array<{ kind: string; status: string; n: number }>
> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT kind, status, COUNT(*)::int AS n
    FROM bmi_sync_queue
    GROUP BY kind, status
    ORDER BY kind, status
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ kind: String(r.kind), status: String(r.status), n: Number(r.n) }));
}
