/**
 * Racer login-code → personId map. NEON, not Redis.
 *
 * WHY IT IS PERMANENT DATA. A BMI `person.tags[]` entry is append-only and
 * resolves uniquely and forever — measured 2026-08-04 across 20 racers, every
 * one of 31 tags on a single record still returned that exact person, including
 * one last seen 2023-09-25. A code never changes owner and never stops working,
 * so this mapping has no staleness mode at all.
 *
 * WHY NOT REDIS. Precisely because it is permanent. Redis here is a cache with
 * eviction pressure — this repo already had an OOM incident and its eviction
 * policy is still outstanding — so a fact we intend to keep forever would be
 * quietly evicted and silently degrade back to a ~1.4 s Office lookup with
 * nothing to show why. Durable facts belong in the durable store; that is the
 * same rule the house applies to guest input.
 *
 * WHAT IT SAVES. A wallet-licence scan otherwise pays a BMI Office token search
 * (~1 s, and it must go over raw https.get) before it can look at a roster.
 * A hit here is a single indexed read, tens of milliseconds — and on a path
 * that also performs a Pandora check-in write, the difference between Neon and
 * Redis is noise next to the second we are removing.
 *
 * TWO WRITERS, on purpose:
 *   - `pre-race-tickets` PRE-WARMS every racer with an upcoming heat, so even a
 *     racer's first ever scan is instant.
 *   - `lookupMemberMatches` BACKFILLS on a miss, so it self-heals for walk-ins
 *     the cron never ticketed.
 *
 * NEVER the authority: every miss falls through to the Office search, and every
 * failure in here is swallowed. A racer must not fail to check in because this
 * table was cold or the DB blinked.
 *
 * BMI ID precision: person_id is TEXT end to end. Modern ids are 17 digits and
 * exceed MAX_SAFE_INTEGER — never Number() one.
 */
import { sql, isDbConfigured } from "@/lib/db";
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";

/**
 * How long before we re-read a racer's tags. NOT correctness — existing codes
 * stay valid forever — only how quickly a NEWLY minted tag (BMI adds roughly
 * one per visit) gets pre-warmed. A miss self-heals via the backfill.
 */
const REWARM_AFTER_DAYS = 30;

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`
        CREATE TABLE IF NOT EXISTS racer_login_codes (
          code        TEXT PRIMARY KEY,
          person_id   TEXT NOT NULL,
          first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      // Pre-warm skip check is "when did we last read THIS person's tags",
      // which is a lookup by person, not by code.
      await q`CREATE INDEX IF NOT EXISTS racer_login_codes_person
                ON racer_login_codes (person_id)`;
    })().catch((e) => {
      // Let a later call retry rather than poisoning the module for the
      // lifetime of the lambda.
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/** Cached personId for a login code, or null. Never throws. */
export async function personIdForCode(code: string): Promise<string | null> {
  const c = (code || "").trim().toLowerCase();
  if (!c || !isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`SELECT person_id FROM racer_login_codes WHERE code = ${c} LIMIT 1`;
    const pid = rows[0] ? String((rows[0] as Record<string, unknown>).person_id ?? "") : "";
    return /^\d+$/.test(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Remember every tag a racer holds — old ones resolve too, so store them all. */
export async function rememberCodes(personId: string, codes: string[]): Promise<void> {
  const pid = String(personId || "").trim();
  const clean = [...new Set(codes.map((c) => String(c || "").trim().toLowerCase()).filter(Boolean))];
  if (!/^\d+$/.test(pid) || clean.length === 0 || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    for (const c of clean) {
      // A code cannot change owner, so a conflict is the same fact arriving
      // again — refresh last_seen and leave the mapping alone.
      await q`
        INSERT INTO racer_login_codes (code, person_id)
        VALUES (${c}, ${pid})
        ON CONFLICT (code) DO UPDATE SET last_seen = now()`;
    }
  } catch {
    /* cache-only — never fail a caller for this */
  }
}

interface PersonTags {
  tags?: Array<{ tag?: string }>;
}

/**
 * Pre-warm a batch of racers. Skips anyone read recently, so the every-2-minute
 * `pre-race-tickets` cron costs one Office person call per racer per 30 days
 * rather than one per run.
 *
 * `personsByIds` is NOT usable here: it returns profiles WITHOUT the `tags`
 * array (established during the 2026-08-03 Office outage triage), so the codes
 * we need exist only on `/person/{id}`.
 */
export async function warmRacerCodes(
  clientKey: string,
  personIds: Array<string | number>,
): Promise<{ warmed: number; skipped: number; failed: number }> {
  const unique = [
    ...new Set(personIds.map((p) => String(p ?? "").trim()).filter((p) => /^\d+$/.test(p))),
  ];
  const out = { warmed: 0, skipped: 0, failed: 0 };
  if (unique.length === 0 || !isDbConfigured()) return out;

  let fresh = new Set<string>();
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT DISTINCT person_id FROM racer_login_codes
      WHERE person_id = ANY(${unique})
        AND last_seen > now() - (${REWARM_AFTER_DAYS} || ' days')::interval`;
    fresh = new Set(rows.map((r) => String((r as Record<string, unknown>).person_id ?? "")));
  } catch {
    // Treat an unreadable table as "nothing warmed" — worst case we re-read
    // some tags, which is wasteful but never wrong.
  }

  for (const pid of unique) {
    if (fresh.has(pid)) {
      out.skipped++;
      continue;
    }
    const person = await fetchPersonRaw<PersonTags>(clientKey, pid).catch(() => null);
    if (!person) {
      out.failed++;
      continue;
    }
    const codes = (person.tags ?? []).map((t) => String(t?.tag ?? "")).filter(Boolean);
    if (codes.length > 0) await rememberCodes(pid, codes);
    out.warmed++;
  }
  return out;
}
