/**
 * Who holds a wallet racing licence, and what we last wrote onto it.
 *
 * TWO JOBS, and the second is the one that makes the live-update crons viable.
 *
 * 1. WHO HAS A PASS. Nearly no racer does. Without this table the "now checking
 *    in" cron would ask PassKit about every racer on every heat and take a 404
 *    for almost all of them — a per-racer round trip, every minute, to learn
 *    nothing. A row exists only once a pass has actually been issued, so the
 *    crons skip everyone else for free.
 *
 * 2. WHAT WE LAST PUSHED. `checkin-alerts` runs EVERY MINUTE against the same
 *    open heat. Apple only raises a lock-screen alert when a field's value
 *    CHANGES, so re-sending an identical value is silent — but it is still an
 *    API call per racer per minute for nothing. Comparing against the last
 *    written value means one push per real change.
 *
 * Neon, not Redis: a pass id is durable and losing it to eviction would orphan
 * a billed member record. person_id / member_id stay TEXT end to end — modern
 * BMI ids are 17 digits and exceed MAX_SAFE_INTEGER, so never Number() one.
 */
import { sql, isDbConfigured } from "@/lib/db";

export interface RacerWalletPass {
  personId: string;
  /** PassKit member id — what `PUT /members/member` addresses. */
  memberId: string;
  /** Last value written to the NEXT RACE field, for change detection. */
  nextRace: string | null;
  /** Last value written to the check-in status field. */
  checkinStatus: string | null;
  /** Session each live field was written for — what the clear-down checks. */
  checkinSessionId: string | null;
  nextRaceSessionId: string | null;
  /** Full metaData last written — the base every partial update builds on.
   *  Without it an update would send only the changed keys, and
   *  PUT /members/member REPLACES metaData, which wipes the barcode. */
  meta: Record<string, string> | null;
  /** PassKit `passMetaData.status` as last reconciled — PASS_ISSUED means it
   *  was created but has never reached a device. Null = never reconciled. */
  passStatus?: string | null;
}

/** One row for the reconcile sweep — every live pass we are being billed for. */
export interface RacerPassBillingRow {
  personId: string;
  memberId: string;
  passStatus: string | null;
  installedAt: Date | null;
  createdAt: Date | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`
        CREATE TABLE IF NOT EXISTS racer_wallet_passes (
          person_id       TEXT PRIMARY KEY,
          member_id       TEXT NOT NULL,
          login_code      TEXT,
          next_race       TEXT,
          checkin_status  TEXT,
          issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      // WHICH session each live field refers to. Without this the clear-down
      // has nothing to check: a stale "check in now" is only stale relative to
      // the heat it was written for, and elapsed time cannot tell us that
      // because races run late (and sometimes early — heat 1 on 2026-08-04
      // started 17 minutes AHEAD of schedule).
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS checkin_session_id TEXT`;
      // THE FULL metaData last written to the pass.
      //
      // PUT /members/member REPLACES metaData — it does NOT merge, which is the
      // opposite of PUT /template. Pushing only the changed keys therefore
      // DELETED every other field, including the one the barcode is built from,
      // and left a live pass reading "missing: meta.code" that would not scan
      // (2026-08-05). Every update must send the COMPLETE object, so we keep it
      // here rather than reading it back off the pass.
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS meta JSONB`;
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS next_race_session_id TEXT`;
      // INSTALL STATE — this is a BILLING record, not a nicety.
      //
      // A multi-use pass is re-billed every month it stays alive, and the
      // 250-free allowance is a standing cap on live records rather than a
      // monthly reset. So a pass that was issued and never installed, or
      // installed and later deleted off the phone, is a line item for nothing.
      // PassKit exposes the truth as `passMetaData.status` (PASS_ISSUED before
      // an install, PASS_INSTALLED after), which the reconcile sweep records
      // here so a deletion decision is never made on a guess.
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS pass_status TEXT`;
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS pass_status_at TIMESTAMPTZ`;
      // First time we ever saw it on a device. Kept even after an uninstall,
      // because "installed once" and "never installed" are different guests.
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ`;
      // When we deleted the PassKit record to stop the meter. The row stays so
      // we remember the history; member_id is nulled so nothing tries to push
      // to a record that no longer exists.
      await q`ALTER TABLE racer_wallet_passes ADD COLUMN IF NOT EXISTS reaped_at TIMESTAMPTZ`;
      // member_id was NOT NULL from the original schema, but reaping a pass has
      // to null it: every push path skips a row without one, which is exactly
      // how we stop writing to a PassKit record that no longer exists.
      await q`ALTER TABLE racer_wallet_passes ALTER COLUMN member_id DROP NOT NULL`;
    })().catch((e) => {
      schemaReady = null; // let a later call retry rather than poison the lambda
      throw e;
    });
  }
  return schemaReady;
}

/** The pass a racer holds, or null when they have none (the common case). */
export async function getRacerPass(personId: string): Promise<RacerWalletPass | null> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT person_id, member_id, next_race, checkin_status,
             checkin_session_id, next_race_session_id, meta, pass_status
      FROM racer_wallet_passes WHERE person_id = ${pid} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    // A reaped row keeps its history but has no PassKit record behind it, so it
    // is not a pass anyone can push to.
    if (!r || r.member_id == null) return null;
    return {
      personId: String(r.person_id),
      memberId: String(r.member_id),
      nextRace: r.next_race == null ? null : String(r.next_race),
      checkinStatus: r.checkin_status == null ? null : String(r.checkin_status),
      checkinSessionId: r.checkin_session_id == null ? null : String(r.checkin_session_id),
      nextRaceSessionId: r.next_race_session_id == null ? null : String(r.next_race_session_id),
      meta: (r.meta as Record<string, string> | null) ?? null,
      passStatus: r.pass_status == null ? null : String(r.pass_status),
    };
  } catch {
    return null;
  }
}

/**
 * Every racer holding a pass, keyed by personId — one query for a whole heat
 * instead of one per racer. The table only ever holds actual pass-holders, so
 * this stays small.
 */
export async function getRacerPasses(
  personIds: Array<string | number>,
): Promise<Map<string, RacerWalletPass>> {
  const out = new Map<string, RacerWalletPass>();
  const ids = [
    ...new Set(personIds.map((p) => String(p ?? "").trim()).filter((p) => /^\d+$/.test(p))),
  ];
  if (ids.length === 0 || !isDbConfigured()) return out;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT person_id, member_id, next_race, checkin_status,
             checkin_session_id, next_race_session_id
      FROM racer_wallet_passes
      WHERE person_id = ANY(${ids}) AND member_id IS NOT NULL`;
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const pid = String(r.person_id);
      out.set(pid, {
        personId: pid,
        memberId: String(r.member_id),
        nextRace: r.next_race == null ? null : String(r.next_race),
        checkinStatus: r.checkin_status == null ? null : String(r.checkin_status),
        checkinSessionId: r.checkin_session_id == null ? null : String(r.checkin_session_id),
        nextRaceSessionId: r.next_race_session_id == null ? null : String(r.next_race_session_id),
        // Identity only on the roster path — updateLicencePass reloads the full
        // row (and its meta) before it writes anything.
        meta: null,
      });
    }
  } catch {
    /* no rows = nobody gets a push; never fail a cron for this */
  }
  return out;
}

/** Record an issued pass. Idempotent — re-issuing re-points the same row. */
export async function recordRacerPass(args: {
  personId: string;
  memberId: string;
  loginCode?: string | null;
}): Promise<void> {
  const pid = String(args.personId || "").trim();
  if (!/^\d+$/.test(pid) || !args.memberId || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO racer_wallet_passes (person_id, member_id, login_code)
      VALUES (${pid}, ${args.memberId}, ${args.loginCode ?? null})
      ON CONFLICT (person_id) DO UPDATE
        SET member_id = EXCLUDED.member_id,
            login_code = COALESCE(EXCLUDED.login_code, racer_wallet_passes.login_code),
            updated_at = now()`;
  } catch {
    /* the pass exists at PassKit either way — this row is bookkeeping */
  }
}

/** Remember what we last pushed, so an unchanged value costs no API call. */
export async function markPushed(
  personId: string,
  patch: {
    nextRace?: string;
    checkinStatus?: string;
    checkinSessionId?: string | null;
    nextRaceSessionId?: string | null;
  },
): Promise<void> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    if (patch.nextRace !== undefined) {
      await q`UPDATE racer_wallet_passes
                SET next_race = ${patch.nextRace}, updated_at = now()
              WHERE person_id = ${pid}`;
    }
    if (patch.checkinStatus !== undefined) {
      await q`UPDATE racer_wallet_passes
                SET checkin_status = ${patch.checkinStatus}, updated_at = now()
              WHERE person_id = ${pid}`;
    }
    if (patch.checkinSessionId !== undefined) {
      await q`UPDATE racer_wallet_passes
                SET checkin_session_id = ${patch.checkinSessionId}, updated_at = now()
              WHERE person_id = ${pid}`;
    }
    if (patch.nextRaceSessionId !== undefined) {
      await q`UPDATE racer_wallet_passes
                SET next_race_session_id = ${patch.nextRaceSessionId}, updated_at = now()
              WHERE person_id = ${pid}`;
    }
  } catch {
    // Worst case we re-push an identical value next run: silent for the guest
    // (Apple only alerts on change) and merely a wasted call.
  }
}

/**
 * Every pass holding a live field, with the session that field was written for.
 * The clear-down's input: small by construction, because only actual
 * pass-holders are ever in this table.
 */
export async function getPassesWithLiveFields(): Promise<
  Array<{
    personId: string;
    memberId: string;
    checkinStatus: string | null;
    checkinSessionId: string | null;
    nextRace: string | null;
    nextRaceSessionId: string | null;
  }>
> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT person_id, member_id, checkin_status, checkin_session_id,
             next_race, next_race_session_id
      FROM racer_wallet_passes
      WHERE (checkin_status IS NOT NULL AND checkin_status <> '')
         OR (next_race IS NOT NULL AND next_race <> '' AND next_race <> 'None booked')`;
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        personId: String(r.person_id),
        memberId: String(r.member_id),
        checkinStatus: r.checkin_status == null ? null : String(r.checkin_status),
        checkinSessionId: r.checkin_session_id == null ? null : String(r.checkin_session_id),
        nextRace: r.next_race == null ? null : String(r.next_race),
        nextRaceSessionId: r.next_race_session_id == null ? null : String(r.next_race_session_id),
      };
    });
  } catch {
    return [];
  }
}

/** Persist the full metaData we just wrote to a pass. */
export async function saveMeta(personId: string, meta: Record<string, string>): Promise<void> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`UPDATE racer_wallet_passes SET meta = ${JSON.stringify(meta)}::jsonb, updated_at = now()
            WHERE person_id = ${pid}`;
  } catch {
    /* the pass is already correct; this is the record of it */
  }
}

/**
 * Every pass we still hold a PassKit record for — the sweep's input, and the
 * list we are actually being billed for each month.
 */
export async function getBillablePasses(): Promise<RacerPassBillingRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT person_id, member_id, pass_status, installed_at, issued_at
      FROM racer_wallet_passes
      WHERE member_id IS NOT NULL AND reaped_at IS NULL`;
    return rows.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        personId: String(x.person_id),
        memberId: String(x.member_id),
        passStatus: x.pass_status == null ? null : String(x.pass_status),
        installedAt: x.installed_at ? new Date(String(x.installed_at)) : null,
        // The column is `issued_at`, not `created_at`. Selecting a column that
        // does not exist threw, the catch below swallowed it, and the sweep saw
        // an EMPTY list — a reaper that reports success while doing nothing.
        createdAt: x.issued_at ? new Date(String(x.issued_at)) : null,
      };
    });
  } catch {
    return [];
  }
}

/** Record what PassKit says about a pass. `installed_at` is set once and never
 *  cleared — "installed then removed" and "never installed" are different
 *  guests, and only the second is safe to reap without warning. */
export async function recordPassStatus(
  personId: string,
  status: string,
): Promise<void> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    const installed = status === "PASS_INSTALLED";
    await q`
      UPDATE racer_wallet_passes
      SET pass_status = ${status},
          pass_status_at = now(),
          installed_at = CASE WHEN ${installed} AND installed_at IS NULL THEN now() ELSE installed_at END,
          updated_at = now()
      WHERE person_id = ${pid}`;
  } catch {
    /* the sweep re-reads next run */
  }
}

/**
 * Mark a pass as reaped after its PassKit record was deleted.
 *
 * NULLS `member_id` deliberately: every push path skips a row without one, so
 * this is what stops the cron writing to a record that no longer exists. The
 * row itself stays — it is the history of a racer who once held a pass, and
 * re-issuing simply writes a fresh member_id over it.
 */
export async function markPassReaped(personId: string): Promise<void> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE racer_wallet_passes
      SET reaped_at = now(), member_id = NULL, meta = NULL, updated_at = now()
      WHERE person_id = ${pid}`;
  } catch {
    /* non-fatal — the sweep retries, and a duplicate delete is a 404 we ignore */
  }
}
