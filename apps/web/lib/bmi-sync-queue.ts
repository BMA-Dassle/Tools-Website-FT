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
  /** party-ready AND every seat in `payload.seats` is on the local GRID —
   *  the racers this check-in bound are actually on their sessions, verified
   *  against Pandora's session participants rather than our own
   *  `schedule_status` (which goes stale the moment staff hand-seat someone).
   *  This is what the "Confirmation - Express" flip waits on: staff read that
   *  state as "here and checked in", and seating is part of checked in. */
  | "party-seated"
  /** EVERY person in payload.personIds exists on the LOCAL server. Presence
   *  only — no waiver required, which is what separates it from party-ready.
   *  Exists for the guardian-signed waiver: Pandora's write names both the
   *  minor and the signing adult, so both must be resolvable locally. */
  | "persons-local"
  /** Fire immediately. */
  | "none";

/**
 * `pending` — owed, still being tried.
 * `done`    — the followup landed.
 * `parked`  — we ran out of patience. A WORK ORDER FOR A HUMAN.
 * `dismissed` — a human read the work order and closed it. See `dismissSyncRow`.
 * `cancelled` — set by hand in a few 2026-08 cleanups; no code writes it.
 *
 * A NOTE ON ADDING TO THIS UNION. Preview and production share one
 * `bmi_sync_queue` table, so a status an older deploy does not recognise will be
 * read by that older deploy. Every status here is SAFE in that respect because
 * the work selector matches `status = 'pending'` explicitly (`listDueSyncRows`)
 * — an unknown status is simply never picked up, which is the failure mode we
 * want. Keep it that way: never write a selector that means "not done".
 */
export type SyncStatus = "pending" | "done" | "parked" | "dismissed" | "cancelled";

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
  /** Which rail carried this row: `vercel-queue` once the push leased it, else
   *  null, which means the cron picked it up. Recorded at enqueue — it cannot be
   *  derived later, because `next_attempt_at` moves on every retry. */
  pushTransport: string | null;
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
  /**
   * WHICH RAIL CARRIED THIS ROW — recorded, not guessed.
   *
   * The admin board used to hardcode every queue row as "neon-cron", because when
   * it was written that was the only rail. After the Vercel Queues migration that
   * label became a lie: rows landing in 16-30s were still reported as cron work,
   * so the board said the migration had not happened while the Took column proved
   * it had (owner, 2026-08-13: "a bunch of stuff still going via cron... like grant
   * registration").
   *
   * It cannot be derived after the fact — `next_attempt_at` carries the lease at
   * enqueue but moves on every retry, so a completed row has no trace of how it
   * travelled. Stamp it once, at the moment we know.
   */
  await q`ALTER TABLE bmi_sync_queue ADD COLUMN IF NOT EXISTS push_transport TEXT`;
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
    pushTransport: r.push_transport === null ? null : String(r.push_transport),
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
  /**
   * No row returned = the conflict hit a non-pending row, which is the correct
   * no-op: the work is already done, or already given up on, or a human has set
   * it aside. Re-arming it here would undo their decision from a code path that
   * cannot know why they made it.
   *
   * WHAT THIS MEANS FOR A DISMISSED ROW. `stamp-confirmation-state` is keyed
   * `state-stamp:{billId}:{businessDate}`, so once a stamp is set aside, a LATER
   * check-in on the same reservation that day will not re-queue it. That is the
   * intended reading of "set aside" — the operator saw this reservation's stamp
   * and decided it is not landing today — and it is why the dismiss reason is
   * required and kept. To genuinely retry, clear the row rather than re-enqueue.
   */
  const row = rows[0] ? mapRow(rows[0]) : null;
  if (!row) return null;

  /**
   * HAND IT TO VERCEL QUEUES — one place, every kind.
   *
   * This is deliberately here rather than at each call site: `enqueueSync` is the
   * single door into the queue, so adding the push here lights up all five kinds at
   * once and no future kind can forget it. The Neon row above is already committed,
   * which is what makes the push safe to be best-effort.
   *
   * On success we LEASE the row (see SYNC_LEASE_SECONDS) so the cron cannot pick up
   * something the queue is about to run. On failure we change nothing — the row
   * keeps `next_attempt_at = now()` and the cron takes it exactly as before.
   */
  try {
    const { sendSyncPush, SYNC_LEASE_SECONDS } = await import("@/lib/bmi-sync-push");
    const messageId = await sendSyncPush(row);
    if (messageId) {
      await leaseSyncRow(row.id, SYNC_LEASE_SECONDS);
      return {
        ...row,
        nextAttemptAt: new Date(Date.now() + SYNC_LEASE_SECONDS * 1000).toISOString(),
      };
    }
  } catch (err) {
    console.warn(`[bmi-sync] push wiring failed for row ${row.id} — cron will handle it:`, err);
  }
  return row;
}

/** One row by id — what a queue message points at. */
export async function getSyncRowById(id: number): Promise<SyncQueueRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM bmi_sync_queue WHERE id = ${Number(id)} LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Push `next_attempt_at` out so the cron cannot see a row the queue owns.
 *
 * This is the CLAIM. `listDueSyncRows` has no `FOR UPDATE SKIP LOCKED`, so the
 * existing column doubles as a lease: invisible to the cron while held, and
 * automatically reaped by it once expired. Only ever moves the time FORWARD, and
 * only for a still-pending row — it must never resurrect a parked one.
 */
export async function leaseSyncRow(id: number, seconds: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE bmi_sync_queue
    SET next_attempt_at = GREATEST(next_attempt_at, now() + (${seconds} * INTERVAL '1 second')),
        -- Only the queue ever leases a row, so holding the lease IS the proof of
        -- which rail carried it. Stamped here so the board reports what happened
        -- instead of assuming.
        push_transport = 'vercel-queue',
        updated_at = now()
    WHERE id = ${Number(id)} AND status = 'pending'
  `;
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
  opts?: {
    countAttempt?: boolean;
    /**
     * Hold the queue's lease instead of handing the row back to the cron.
     *
     * A queue-owned retry is redelivered by Vercel in seconds, so scheduling
     * `next_attempt_at` off `backoffSeconds` would let the cron grab the row in the
     * gap and run the handler twice. Passing the lease keeps ownership until the
     * redelivery lands (or the lease expires and the cron correctly reaps it).
     */
    leaseSeconds?: number;
  },
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
        next_attempt_at = now() + (${opts?.leaseSeconds ?? backoffSeconds(attempts)} * INTERVAL '1 second'),
        last_error = ${error.slice(0, 500)},
        resolved_at = ${park ? new Date().toISOString() : null},
        updated_at = now()
    WHERE id = ${row.id}
  `;
  return park ? "parked" : "retry";
}

/**
 * Park a row NOW, without spending its patience — for work that is provably
 * impossible rather than merely not-yet.
 *
 * `markSyncRetry` parks only once attempts or the give-up deadline run out,
 * which is right for "waiting on sync" and wrong for "this can never happen".
 * A followup aimed at a person who lives at a DIFFERENT center (2026-08-12,
 * Nadine Poeter …8163542 aimed at Naples, resident at Fort Myers) would
 * otherwise report "not on the local server yet" for eleven hours.
 *
 * The message is the whole point: a parked row is a work order for a human, so
 * the caller passes the diagnosis, not just the symptom.
 */
export async function parkSyncRow(row: SyncQueueRow, reason: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE bmi_sync_queue
    SET status = 'parked', resolved_at = now(), updated_at = now(),
        last_error = ${reason.slice(0, 500)}
    WHERE id = ${row.id}
  `;
}

/**
 * A HUMAN READ THE WORK ORDER AND CLOSED IT.
 *
 * A parked row is a work order (see `parkSyncRow`). Until now the board could
 * only display work orders, never close them: nothing in the app wrote anything
 * but `pending`/`done`/`parked`, so every row a human had already dealt with —
 * or that was never actionable in the first place — stayed on the panel for
 * ever, and the badge stayed red. On 2026-08-24 that was 33 rows, none of them
 * a live fault, and a red badge that is always red is not a signal.
 *
 * DISMISSING IS NOT FIXING, and this is deliberately not `done`:
 *   - `done` means the followup LANDED. Only a handler may say that.
 *   - `dismissed` means a person decided it will not land and is not worth
 *     chasing. The work is still owed to nobody; the row just stops shouting.
 * The reason is required and it is kept: `last_error` holds the human's words,
 * so a dismissed row can still be read six weeks later and explain itself.
 * Nothing is deleted — the same rule the waiver half already follows, where a
 * dismissed signature keeps its PNG because it is the only proof the guest
 * signed (lib/waiver-sign-log.ts).
 *
 * ONLY A PARKED ROW MAY BE DISMISSED. A pending row is still being worked and
 * burying it would hide live work; a done row has nothing to dismiss. The guard
 * lives in the WHERE clause rather than a pre-read so two operators tapping at
 * once cannot race, and the caller learns which it was from the return value.
 */
export async function dismissSyncRow(
  id: number,
  reason: string,
  by?: string | null,
): Promise<"dismissed" | "not-parked"> {
  if (!isDbConfigured()) return "not-parked";
  await ensureSchema();
  const q = sql();
  const note = `${by ? `${by}: ` : ""}${reason}`.slice(0, 500);
  const rows = (await q`
    UPDATE bmi_sync_queue
    SET status = 'dismissed', resolved_at = now(), updated_at = now(),
        last_error = ${note}
    WHERE id = ${Number(id)} AND status = 'parked'
    RETURNING id
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? "dismissed" : "not-parked";
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
