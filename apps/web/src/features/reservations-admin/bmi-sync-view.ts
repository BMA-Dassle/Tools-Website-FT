/**
 * Admin read model for the BMI sync queue — the watch surface the owner asked
 * for (2026-08-12): "on reservation admin, can you add a BMI sync that shows
 * anything that is in that table. Also can you add a pill to each bmi
 * reservation that is green when on-site is done. will help watch for these
 * problems."
 *
 * Two questions, one query each:
 *
 *  1. WHAT IS OUTSTANDING RIGHT NOW — `listSyncQueueForAdmin`. Every row, newest
 *     first, with the fields that tell an operator what to do: which kind, which
 *     barrier it is waiting behind, how many attempts, the last error, and how
 *     long it has been waiting. Parked rows sort FIRST because they are the ones
 *     nobody is coming to fix automatically.
 *
 *  2. IS THE ON-SITE WORK DONE FOR THIS RESERVATION — `syncStateForReservations`.
 *     Under cloud-first the guest's booking completes on the BMI cloud while the
 *     local (Pandora) work — waiver record, licence, grid seat — lands seconds to
 *     minutes later. The pill is how staff see that landing without opening BMI.
 *
 * The pill is deliberately THREE states, not two. "No rows" cannot mean "done":
 * a reservation that never needed local followups and one whose followups were
 * never enqueued look identical in this table, and painting the second one green
 * would be the same class of lie as a status field that claims more than it
 * knows (lessons § "a status field IS a claim"). So absence reads as `unknown`
 * and only positive evidence earns green.
 *
 * Read-only. Never throws — the board must render if the queue is unreachable.
 */
import { sql, isDbConfigured } from "@/lib/db";

/** FastTrax racing — where kiosk waiver joins are added, and the same default the
 *  sync cron and barrier probe use. A person id from another centre simply 404s
 *  here, which fails closed (still shown as owed) rather than wrongly cleared. */
const RACING_LOCATION_ID = "LAB52GY480CJF";

/** How far back the board looks by default. A week covers "what happened on
 *  shift" and the weekend either side of it; older work is counted, not shown. */
const DEFAULT_WINDOW_DAYS = 7;

export interface AdminSyncRow {
  id: number;
  /**
   * WHICH TABLE `id` IS A KEY INTO. The panel unions three sources and two of
   * them carry a real primary key from DIFFERENT tables — `bmi_sync_queue.id`
   * and `waiver_signatures.id` are independent sequences, so id 1732 exists in
   * both and means different things. `kind` cannot disambiguate them either:
   * `push-waiver-signature` is both a `SyncKind` and what a waiver row calls
   * itself. Any action taken on a row MUST send this, or it will eventually
   * update the wrong table's row.
   *
   * `guest-add` rows are derived, not stored: their id is synthesised from a
   * person id and is a key into nothing. They can never be acted on.
   */
  source: "queue" | "waiver" | "guest-add";
  kind: string;
  /** `pending` | `done` | `parked` | `dismissed` — see SyncStatus. */
  status: string;
  barrier: string;
  barrierRef: string | null;
  reservationRef: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  giveUpAt: string | null;
  resolvedAt: string | null;
  /** Minutes since the row was created — how long this has been outstanding. */
  ageMin: number;
  /** Best-effort display name from the payload, so a row reads as a person. */
  who: string | null;
  /** WHICH MECHANISM is carrying this work — "neon-cron", "vercel-queue", or null
   *  for a row that is not a queued push at all. On screen this is the difference
   *  between "the cron is behind" and "the message bus is behind", which are
   *  different problems with different fixes (owner 2026-08-13). */
  transport: string | null;
  /** Which center this work belongs to, spelled out. Never a bare location id —
   *  a row that says "Naples" is the difference between "the queue is broken" and
   *  "one center's config is wrong" (owner 2026-08-12: "Add center name"). */
  center: string | null;
}

/** Pandora locationID → center name. The same three ids the rest of the app uses
 *  (`bmi-attraction-cancel.ts`, `bowling-lane-ready-notify.ts`). */
const CENTER_NAMES: Record<string, string> = {
  LAB52GY480CJF: "FastTrax",
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};

/** Names a center for display. An unmapped id shows AS the id rather than as
 *  nothing — an unknown center is itself the finding. */
export function centerName(locationId: string | null | undefined): string | null {
  if (!locationId) return null;
  return CENTER_NAMES[locationId] ?? locationId;
}

/** `green` = every local followup landed. `waiting` = something is still owed.
 *  `attention` = a row parked (gave up) — a human is needed.
 *  `unknown` = no rows at all, which is NOT the same as done. */
export type OnsiteState = "green" | "waiting" | "attention" | "unknown";

export interface ReservationSyncState {
  state: OnsiteState;
  pending: number;
  parked: number;
  done: number;
  /** The kinds still outstanding, for the pill's tooltip. */
  waitingKinds: string[];
  /** Oldest outstanding row's age in minutes — what makes a stall obvious. */
  oldestWaitingMin: number | null;
}

const EMPTY: ReservationSyncState = {
  state: "unknown",
  pending: 0,
  parked: 0,
  done: 0,
  waitingKinds: [],
  oldestWaitingMin: null,
};

function nameFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const first = typeof p.firstName === "string" ? p.firstName : "";
  const last = typeof p.lastName === "string" ? p.lastName : "";
  const name = typeof p.name === "string" ? p.name : "";
  const joined = `${first} ${last}`.trim() || name.trim();
  return joined || null;
}

/**
 * On-site work for RECENTLY ADDED GUESTS, whether or not it had to wait.
 *
 * Why this is not just the queue: the queue only holds work that FAILED or is
 * WAITING, so a guest whose waiver and attach both landed first time produces
 * NO rows at all. Owner 2026-08-12, after signing two test guests: "I just put
 * in a person name test again and don't see it here?" — and they were right to
 * expect it, because the question the panel has to answer is "did my person get
 * added and is the on-site side done", not "what is in one table".
 *
 * So each signer's ATTACH outcome (kiosk_waiver_joins) is folded in as a row of
 * its own. A successful attach shows as `done` — visible proof rather than
 * silence — and a failed one shows as needing attention. `attached` rows also
 * carry the waiver outcome, since a guest who attached but whose waiver never
 * reached BMI is exactly the case worth seeing.
 */
/**
 * Attach + waiver outcome → what the board is allowed to claim.
 *
 * `queued` IS NOT DONE. It means the push was handed to Vercel Queues, not that
 * BMI holds the record. Counting it as done was the same shape as the swallowed
 * $2,113.95: a row whose consumer never ran sits at `queued` forever and reads
 * green, with `resolvedAt` set and no age-out to give it away. Two such rows are
 * in the table right now (#776, #777) from previews that had no consumer bound.
 *
 * So `queued` is PENDING — still moving, and the caller stamps `ageMin`, which is
 * what turns a stuck one amber instead of invisible. Only `signed` (BMI wrote it)
 * and `salvaged` (they already had a valid waiver) are finished.
 */
export function guestAddStatus(attach: string, waiver: string | null): string {
  if (attach === "failed") return "parked";
  if (attach !== "attached") return "pending";
  return waiver === "signed" || waiver === "salvaged" ? "done" : "pending";
}

/**
 * Does BMI already hold a CURRENT waiver for this person?
 *
 * Read-only, and fails CLOSED: anything other than a 200 with a future
 * `waiverExpiry` returns false, so the guest keeps showing as owed. A 500 here
 * means a null birthdate (the record exists but the vendor's own schema rejects
 * it) — "we cannot tell", never "they are covered".
 *
 * `kiosk_waiver_joins.location_id` is a BMI centre code, not a Pandora location id,
 * so it cannot be used directly; the default racing location is where these guests
 * are being added.
 */
async function bmiHoldsCurrentWaiver(personId: string, _joinLocationId: string): Promise<boolean> {
  /**
   * TWO ATTEMPTS, 12s each — MEASURED, not guessed.
   *
   * This shipped at 6s and was too tight for the endpoint it calls: median 3.7s,
   * max 6.6s over six samples, so roughly one render in six timed out. Because the
   * check fails CLOSED, a timeout put a guest who is demonstrably covered back into
   * "waiver not recorded yet" — so rebecca wolfson flickered between Waiting and
   * Cleared depending on how Pandora felt that second (2026-08-13).
   *
   * An intermittently wrong board is worse than a consistently wrong one: it
   * teaches staff the panel is unreliable, and then the real rows get ignored too.
   * The retry is what makes fail-closed honest — it should mean "we asked properly
   * and BMI says no", never "the vendor was slow".
   */
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://bma-pandora-api.azurewebsites.net/v2/bmi/person/${RACING_LOCATION_ID}/${personId}?picture=false&allRelated=false`,
        {
          headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        },
      );
      // A 404/500 is a real answer (wrong centre / unreadable record) — no retry.
      if (!res.ok) return false;
      const d = (await res.json()) as {
        success?: boolean;
        data?: { waiverExpiry?: string | null };
      };
      const exp = d?.success && d.data?.waiverExpiry ? Date.parse(d.data.waiverExpiry) : NaN;
      return Number.isFinite(exp) && exp > Date.now();
    } catch {
      // Timeout or network only. Fall through and ask once more.
    }
  }
  return false;
}

export async function listRecentGuestAdds(minutes = 720, limit = 100): Promise<AdminSyncRow[]> {
  if (!isDbConfigured()) return [];
  try {
    const q = sql();
    const rows = (await q`
      SELECT j.project_id, j.person_id, j.display_name, j.bmi_attach_status,
             j.bmi_attach_error, j.created_at, j.location_id,
             EXTRACT(EPOCH FROM (now() - j.created_at)) / 60 AS age_min,
             (SELECT s.outcome FROM waiver_signatures s
               WHERE s.person_id = j.person_id
               ORDER BY s.ts DESC LIMIT 1) AS waiver_outcome
      FROM kiosk_waiver_joins j
      WHERE j.created_at > now() - (${minutes} * INTERVAL '1 minute')
      ORDER BY j.created_at DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    /**
     * ASK BMI BEFORE CLAIMING A GUEST OWES US A WAIVER.
     *
     * A missing `waiver_signatures` row means only that they did not sign THROUGH
     * US. The commonest reason is the happy one: they already hold a valid waiver,
     * so the kiosk never asked them to sign. rebecca wolfson sat on this board for
     * 90 minutes reading "waiver not recorded yet" while BMI had her covered until
     * 2027-01-03 (2026-08-13).
     *
     * A board that cries wolf gets ignored, and then the real rows get ignored with
     * it — which is the same failure as calling unfinished work done, pointed the
     * other way.
     *
     * Only the rows that would otherwise read as owed are checked, so a clean board
     * costs nothing — and on a busy board that is a handful of rows, not the 100 the
     * query can return.
     *
     * Deliberately a BARE FETCH rather than `waiverValidNow`, whose Redis import
     * drags `ioredis` (and therefore `tls`) into this module. This file is in the
     * CLIENT bundle graph — `BmiSyncPanel` imports `guestAddStatus` and
     * `onsitePillCopy` from it — so a server-only dependency here fails the build
     * with `Module not found: Can't resolve 'tls'`, which neither tsc nor vitest
     * catches because neither bundles for the browser (2026-08-13).
     *
     * Losing the cache costs nothing here: these rows have NO signature record by
     * definition, so the vendor's answer is the only one that exists. Unreadable
     * stays PENDING — never silently "covered" — so a Pandora outage cannot turn
     * into "nobody owes a waiver".
     */
    const suspect = rows.filter(
      (r) =>
        String(r.bmi_attach_status) === "attached" &&
        guestAddStatus(
          String(r.bmi_attach_status),
          r.waiver_outcome === null ? null : String(r.waiver_outcome),
        ) === "pending",
    );
    const coveredAnyway = new Set<string>();
    const CHECK_CONCURRENCY = 5;
    for (let i = 0; i < suspect.length; i += CHECK_CONCURRENCY) {
      const batch = suspect.slice(i, i + CHECK_CONCURRENCY);
      await Promise.all(
        batch.map(async (r) => {
          const pid = String(r.person_id ?? "");
          if (!pid) return;
          if (await bmiHoldsCurrentWaiver(pid, String(r.location_id ?? ""))) coveredAnyway.add(pid);
        }),
      );
    }

    return rows.map((r) => {
      const attach = String(r.bmi_attach_status);
      const waiver = r.waiver_outcome === null ? null : String(r.waiver_outcome);
      const covered = coveredAnyway.has(String(r.person_id ?? ""));
      const status = covered && attach === "attached" ? "done" : guestAddStatus(attach, waiver);
      return {
        // Negative ids keep these distinct from real queue rows in React keys.
        id: -Number(r.person_id ? String(r.person_id).slice(-9) : Math.random() * 1e9),
        source: "guest-add" as const,
        kind: "guest-added",
        transport: null,
        status,
        barrier: "none",
        barrierRef: r.person_id === null ? null : String(r.person_id),
        reservationRef: r.project_id === null ? null : String(r.project_id),
        attempts: 0,
        lastError:
          attach === "attached"
            ? covered && !waiver
              ? "attached; BMI already holds a current waiver — nothing owed"
              : `attached${waiver ? `, waiver ${waiver}` : ", waiver not recorded yet"}`
            : `attach ${attach}${r.bmi_attach_error ? `: ${String(r.bmi_attach_error).slice(0, 120)}` : ""}`,
        createdAt: String(r.created_at),
        nextAttemptAt: String(r.created_at),
        giveUpAt: null,
        resolvedAt: status === "done" ? String(r.created_at) : null,
        ageMin: Math.round(Number(r.age_min ?? 0)),
        who: r.display_name === null ? null : String(r.display_name),
        center: centerName(r.location_id === null ? null : String(r.location_id)),
      } satisfies AdminSyncRow;
    });
  } catch (err) {
    console.warn("[bmi-sync-view] recent guest adds failed:", err);
    return [];
  }
}

/**
 * How much still-open work sits OUTSIDE the board's window.
 *
 * The number the panel prints so a quiet board is never mistaken for an empty
 * one. Counts parked rows only: a pending row older than the window is not a
 * thing that exists (the give-up deadlines are hours, not days).
 *
 * Read-only, never throws, and returns 0 when it cannot tell — a count is a
 * footnote, and a footnote must never be the reason the board fails to render.
 */
export async function countParkedBeforeWindow(windowDays = DEFAULT_WINDOW_DAYS): Promise<number> {
  if (!isDbConfigured() || windowDays <= 0) return 0;
  const days = Number.isFinite(windowDays) ? Math.min(365, windowDays) : DEFAULT_WINDOW_DAYS;
  try {
    const q = sql();
    const rows = (await q`
      SELECT count(*)::int AS n FROM bmi_sync_queue
      WHERE status = 'parked' AND created_at <= now() - (${days} * INTERVAL '1 day')
    `) as Array<Record<string, unknown>>;
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.warn("[bmi-sync-view] older-parked count failed:", err);
    return 0;
  }
}

/**
 * Everything in the table, for the admin panel. Parked first (needs a human),
 * then still-pending, then the resolved tail for context.
 *
 * WINDOWED (2026-08-24). This used to have no time bound at all, so every row
 * ever parked stayed on the board for ever and the badge — whose whole job is to
 * say "something needs you RIGHT NOW" — was permanently red from work that was
 * weeks old. A signal that is always on is not a signal.
 *
 * The window HIDES nothing, though: `olderParked` counts what fell outside it,
 * and the panel says so. That distinction is the point — an operational board
 * may go quiet about old work, but it must never claim there is none. Use
 * `windowDays: 0` to see everything (the cleanup scripts do).
 */
export async function listSyncQueueForAdmin(
  opts: { limit?: number; includeDone?: boolean; windowDays?: number } = {},
): Promise<AdminSyncRow[]> {
  if (!isDbConfigured()) return [];
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const includeDone = opts.includeDone ?? true;
  // 0 = no window. Clamped so a bad query string cannot produce `INTERVAL 'NaN'`.
  const rawDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowDays = Number.isFinite(rawDays)
    ? Math.min(365, Math.max(0, rawDays))
    : DEFAULT_WINDOW_DAYS;
  try {
    const q = sql();
    const rows = (await q`
      SELECT id, kind, status, barrier, barrier_ref, reservation_ref, attempts,
             last_error, created_at, next_attempt_at, give_up_at, resolved_at, payload,
             location_id, push_transport,
             EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS age_min
      FROM bmi_sync_queue
      WHERE (${includeDone} OR status <> 'done')
        AND (${windowDays} = 0 OR created_at > now() - (${windowDays} * INTERVAL '1 day'))
      ORDER BY
        CASE status WHEN 'parked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      source: "queue" as const,
      kind: String(r.kind),
      status: String(r.status),
      barrier: String(r.barrier),
      barrierRef: r.barrier_ref === null ? null : String(r.barrier_ref),
      reservationRef: r.reservation_ref === null ? null : String(r.reservation_ref),
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: String(r.created_at),
      nextAttemptAt: String(r.next_attempt_at),
      giveUpAt: r.give_up_at === null ? null : String(r.give_up_at),
      resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
      ageMin: Math.round(Number(r.age_min ?? 0)),
      who: nameFromPayload(r.payload),
      center: centerName(r.location_id === null ? null : String(r.location_id)),
      /**
       * REPORTED, not assumed. This was hardcoded to "neon-cron" from when the
       * table had only one rail, and it kept saying so after the Vercel Queues
       * migration — the board claimed cron for rows the Took column showed
       * landing in 16-30s, which no cron can do on a 2-minute tick (owner
       * 2026-08-13: "a bunch of stuff still going via cron... like grant
       * registration"). Every one of them had ridden the queue.
       *
       * A row that never got a lease genuinely is cron work, so null is the
       * honest fallback rather than a second guess.
       */
      transport: r.push_transport === null ? "neon-cron" : String(r.push_transport),
    }));
  } catch (err) {
    console.warn("[bmi-sync-view] queue list failed:", err);
    return [];
  }
}

/**
 * Per-reservation on-site verdict for the board's pill, in ONE grouped query
 * (the board renders dozens of reservations — a per-row query would be a
 * classic N+1 on a page staff keep open all day).
 *
 * Keyed on whatever the enqueuers recorded as `reservation_ref` — a BMI bill id
 * or a W-number — so the caller passes both forms it knows for a reservation and
 * takes whichever answers.
 */
export async function syncStateForReservations(
  refs: string[],
): Promise<Map<string, ReservationSyncState>> {
  const out = new Map<string, ReservationSyncState>();
  const wanted = [...new Set(refs.filter(Boolean).map(String))];
  if (!isDbConfigured() || wanted.length === 0) return out;
  try {
    const q = sql();
    const rows = (await q`
      SELECT reservation_ref,
             status,
             kind,
             COUNT(*)::int AS n,
             MAX(EXTRACT(EPOCH FROM (now() - created_at)) / 60) AS oldest_min
      FROM bmi_sync_queue
      WHERE reservation_ref = ANY(${wanted})
      GROUP BY reservation_ref, status, kind
    `) as Array<Record<string, unknown>>;

    for (const r of rows) {
      const ref = String(r.reservation_ref);
      const cur = out.get(ref) ?? { ...EMPTY, waitingKinds: [] };
      const n = Number(r.n);
      const status = String(r.status);
      if (status === "pending") {
        cur.pending += n;
        cur.waitingKinds = [...new Set([...cur.waitingKinds, String(r.kind)])];
        const age = Math.round(Number(r.oldest_min ?? 0));
        cur.oldestWaitingMin = Math.max(cur.oldestWaitingMin ?? 0, age);
      } else if (status === "parked") {
        cur.parked += n;
      } else if (status === "done") {
        cur.done += n;
      }
      out.set(ref, cur);
    }

    // Verdict, worst-first: a parked row outranks a pending one, because
    // something has stopped retrying and only a person will move it.
    for (const [ref, s] of out) {
      s.state =
        s.parked > 0 ? "attention" : s.pending > 0 ? "waiting" : s.done > 0 ? "green" : "unknown";
      out.set(ref, s);
    }
    return out;
  } catch (err) {
    console.warn("[bmi-sync-view] reservation sync state failed:", err);
    return out;
  }
}

/** The pill's label + palette. Kept next to the verdict so the board and any
 *  future surface describe the same state the same way. */
export function onsitePillCopy(s: ReservationSyncState): {
  label: string;
  tone: "green" | "amber" | "red" | "grey";
  title: string;
} {
  switch (s.state) {
    case "green":
      return {
        label: "On-site ✓",
        tone: "green",
        title: `All ${s.done} on-site sync step(s) landed on the center's server.`,
      };
    case "waiting":
      return {
        label:
          s.oldestWaitingMin && s.oldestWaitingMin >= 10
            ? `On-site ${s.oldestWaitingMin}m`
            : "On-site…",
        tone: s.oldestWaitingMin && s.oldestWaitingMin >= 10 ? "amber" : "grey",
        title:
          `${s.pending} step(s) still syncing to the center: ${s.waitingKinds.join(", ")}.` +
          (s.oldestWaitingMin ? ` Oldest ${s.oldestWaitingMin} min.` : "") +
          ` Normal is under a minute — over ~10 min means Fast WSync is behind.`,
      };
    case "attention":
      return {
        label: "On-site ⚠",
        tone: "red",
        title: `${s.parked} step(s) gave up retrying and need a human. Check the BMI sync panel.`,
      };
    default:
      return {
        label: "On-site ?",
        tone: "grey",
        // Saying "done" here would be a claim we cannot back — see the header.
        title:
          "No on-site sync steps recorded for this reservation (nothing to report either way).",
      };
  }
}

/**
 * Waiver pushes that are riding VERCEL QUEUES.
 *
 * Needed because those pushes have no `bmi_sync_queue` row to be seen through —
 * the message lives in Vercel's topic, which the board cannot query. What we DO
 * have is the `waiver_signatures` row: it is written before anything is sent, it
 * records which transport took the push, and it is settled with the outcome. So it
 * is a better source than the queue ever was — it exists even when the transport
 * has lost the message entirely, which is exactly the case a board must surface.
 *
 * Status mapping is about WHAT A HUMAN SHOULD DO:
 *   pending  — captured, push in flight. Normal for the first ~30s.
 *   done     — BMI has it (signed), or already had a valid one (salvaged).
 *   parked   — failed, or unsettled well past any plausible sync window. Needs
 *              someone. An unsettled row is the one that used to be invisible.
 *
 * Read-only, never throws — same contract as the rest of this module.
 */
export async function listWaiverPushesForAdmin(
  opts: { limit?: number; includeDone?: boolean; staleAfterMin?: number } = {},
): Promise<AdminSyncRow[]> {
  if (!isDbConfigured()) return [];
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const includeDone = opts.includeDone ?? true;
  // Past this with nothing settled, "still syncing" stops being a credible story.
  const staleAfterMin = opts.staleAfterMin ?? 10;
  try {
    const q = sql();
    const rows = (await q`
      SELECT id, ts, person_id, signer_person_id, location_id, outcome, waiver_id,
             settled_at, push_transport, invalidation_date, last_error,
             EXTRACT(EPOCH FROM (now() - ts)) / 60 AS age_min
      FROM waiver_signatures
      WHERE push_transport = 'vercel-queue'
      ORDER BY ts DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;

    return rows
      .map((r) => {
        const outcome = r.outcome === null ? null : String(r.outcome);
        const ageMin = Math.round(Number(r.age_min ?? 0));
        // `dismissed` is a human's verdict that this row cannot be landed and is
        // not worth chasing — it leaves the board like a finished row, but the
        // signature stays in Neon. See WaiverSignOutcome in lib/waiver-sign-log.
        const status =
          outcome === "signed" || outcome === "salvaged" || outcome === "dismissed"
            ? "done"
            : outcome === "failed"
              ? "parked"
              : ageMin > staleAfterMin
                ? "parked"
                : "pending";
        const person = String(r.person_id);
        const signer = String(r.signer_person_id);
        return {
          id: Number(r.id),
          source: "waiver" as const,
          kind: "push-waiver-signature",
          status,
          barrier: "persons-local",
          barrierRef: person,
          reservationRef: null,
          attempts: 0,
          // The STORED reason wins whenever we have one. The fixed sentence below
          // is a last resort for rows settled before `last_error` existed — it
          // says only that the push failed, which is the thing the reader can
          // already see, and it hid two unrelated causes on 2026-08-15.
          lastError:
            status === "parked"
              ? outcome === "failed"
                ? (r.last_error === null || r.last_error === undefined
                    ? null
                    : String(r.last_error)) || "push failed — BMI has no waiver for this signature"
                : `no confirmation after ${ageMin} min — the signature is safe in Neon but BMI does not have it`
              : null,
          createdAt: String(r.ts),
          nextAttemptAt: String(r.ts),
          giveUpAt: null,
          resolvedAt: r.settled_at === null ? null : String(r.settled_at),
          ageMin,
          who: signer === person ? person : `${person} (signed by ${signer})`,
          center: centerName(r.location_id === null ? null : String(r.location_id)),
          transport: "vercel-queue",
        } satisfies AdminSyncRow;
      })
      .filter((row) => includeDone || row.status !== "done");
  } catch (err) {
    console.warn("[bmi-sync-view] waiver push list failed:", err);
    return [];
  }
}
