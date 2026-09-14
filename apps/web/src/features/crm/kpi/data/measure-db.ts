/**
 * The measure sub's READ-ONLY SQL. It creates nothing — every table it reads
 * belongs to another sub, whose `ensureSchema` it awaits first (brief §3.8:
 * "later PRs only `ALTER TABLE … ADD COLUMN IF NOT EXISTS` inside their OWN
 * sub's `data/*-db.ts`"). Raw SQL through `@ft/db`'s `sql()`; no ORM.
 *
 * SHAPE OF EVERY READ: **group by the dimensions, bucket in JS.** The portal's
 * state buckets live in exactly one place — `service/buckets.ts` — and a SQL
 * `WHERE state_name ILIKE 'confirmation%'` would be a second, silently
 * diverging copy. So these queries `GROUP BY` (state name, rep, day/month,
 * tenant) and hand back tens of rows for the pure module to bucket. A month at
 * three centres collapses to a few dozen rows; a whole year to a few hundred.
 *
 * ET, NOT UTC: `bmi_created_at` is a `timestamptz`, and the ET evening spills
 * into the next UTC day (memory `project_bookedat_utc_wallclock_sweep`). Every
 * day bucket here is `(ts AT TIME ZONE 'America/New_York')::date`. `event_date`
 * is already a DATE and is compared as one.
 *
 * ONLINE BOOKINGS ARE EXCLUDED: `kind_id = '-10'` is a web booking, not a
 * group-sales event, and counting them would flatter every conversion figure.
 * Cancellations stay in — the portal's LEAD bucket includes them, which is why
 * its conversion denominator is what it is.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureActivitiesSchema } from "~/features/crm/activities";
import { ensureBmiProjectsSchema } from "~/features/crm/bmi";
import { ensureLeadsSchema } from "~/features/crm/leads";
import { ensureGoalsSchema } from "./goals-db";
import { ensureTargetsSchema } from "./targets-db";

/** Every table the measure reads exists before the first SELECT. */
let ready: Promise<void> | null = null;
export function ensureMeasureReadable(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve();
  ready ??= (async () => {
    await ensureBmiProjectsSchema();
    await ensureLeadsSchema();
    await ensureActivitiesSchema();
    await ensureTargetsSchema();
    await ensureGoalsSchema();
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

function centsOf(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function intOf(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// ---------------------------------------------------------------------------
// The BMI mirror (basis `bmi` — Office project totalValue)
// ---------------------------------------------------------------------------

export interface MirrorFilter {
  /** Inclusive ET calendar days. */
  from: string;
  until: string;
  /**
   * ONE centre's Office locationId, or null for all three. Never `client_key`:
   * HPFM and FT share `headpinzftmyers`, so a clientKey filter cannot name a
   * single centre (`core/centres.ts`).
   */
  locationId?: number | null;
}

/** One `GROUP BY` row of the mirror: a state, a responsible, a bucket of time. */
export interface MirrorRollupRow {
  /** Present on the daily and monthly rollups only. */
  day?: string;
  month?: number;
  clientKey: string;
  stateName: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  cents: number;
  projects: number;
}

interface RollupRaw {
  bucket?: string | number | null;
  client_key: string;
  state_name: string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  cents: string | number | null;
  projects: string | number | null;
}

const GROUP_COLS = `p.client_key, p.state_name, p.responsible_user_id, p.responsible_name`;
const GROUP_AGG = `SUM(COALESCE(p.total_value_cents, 0))::text AS cents, COUNT(*)::int AS projects`;
const NOT_ONLINE = `p.kind_id IS DISTINCT FROM '-10'`;

function mapRollup(r: RollupRaw): MirrorRollupRow {
  return {
    clientKey: r.client_key,
    stateName: r.state_name,
    responsibleUserId: r.responsible_user_id,
    responsibleName: r.responsible_name,
    cents: centsOf(r.cents),
    projects: intOf(r.projects),
  };
}

/**
 * Projects whose EVENT falls in the window — the KPI dashboard's own frame
 * ("event-date month, not booked month", brief C7 Definitions).
 */
export async function eventWindowRollup(filter: MirrorFilter): Promise<MirrorRollupRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${GROUP_COLS}, ${GROUP_AGG}
       FROM crm_bmi_projects p
      WHERE p.event_date BETWEEN $1::date AND $2::date
        AND ${NOT_ONLINE}
        AND ($3::int IS NULL OR p.location_id = $3::int)
      GROUP BY ${GROUP_COLS}`,
    [filter.from, filter.until, filter.locationId ?? null],
  )) as RollupRaw[];
  return rows.map(mapRollup);
}

/**
 * Projects BOOKED (created in Office) on each ET day of the window — the
 * pacing chart's axis. Restricted to events in the same window, so the line
 * answers "how fast did we sell THIS month's events", not "how busy was the
 * office".
 */
export async function bookedByDayRollup(filter: MirrorFilter): Promise<MirrorRollupRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT (p.bmi_created_at AT TIME ZONE 'America/New_York')::date::text AS bucket,
            ${GROUP_COLS}, ${GROUP_AGG}
       FROM crm_bmi_projects p
      WHERE p.event_date BETWEEN $1::date AND $2::date
        AND p.bmi_created_at IS NOT NULL
        AND ${NOT_ONLINE}
        AND ($3::int IS NULL OR p.location_id = $3::int)
      GROUP BY bucket, ${GROUP_COLS}`,
    [filter.from, filter.until, filter.locationId ?? null],
  )) as RollupRaw[];
  return rows.map((r) => ({ ...mapRollup(r), day: r.bucket ? String(r.bucket) : undefined }));
}

/** Every month of a calendar year, by event month — the monthly goal chart. */
export async function monthlyRollup(
  year: number,
  locationId?: number | null,
): Promise<MirrorRollupRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT EXTRACT(MONTH FROM p.event_date)::int AS bucket, ${GROUP_COLS}, ${GROUP_AGG}
       FROM crm_bmi_projects p
      WHERE p.event_date >= make_date($1::int, 1, 1)
        AND p.event_date <  make_date($1::int + 1, 1, 1)
        AND ${NOT_ONLINE}
        AND ($2::int IS NULL OR p.location_id = $2::int)
      GROUP BY bucket, ${GROUP_COLS}`,
    [year, locationId ?? null],
  )) as RollupRaw[];
  return rows.map((r) => ({ ...mapRollup(r), month: intOf(r.bucket ?? null) }));
}

/**
 * Hosts whose event was in the window one year back: the reach-out
 * denominator, and how many of them still have no lead this year. Same
 * predicates as B1's `listLastYearHosts`, counted instead of listed.
 */
export async function lastYearHostCounts(filter: {
  from: string;
  until: string;
  locationId?: number | null;
}): Promise<{ hosts: number; remaining: number }> {
  if (!isDbConfigured()) return { hosts: 0, remaining: 0 };
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT COUNT(*)::int AS hosts,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM crm_leads l
                LEFT JOIN crm_contacts c ON c.id = l.contact_id
                 WHERE l.archived_at IS NULL
                   AND l.event_date > p.event_date
                   AND (
                         (p.account_id IS NOT NULL AND l.account_id = p.account_id)
                      OR (p.person_phone IS NOT NULL AND c.phone_e164 = p.person_phone)
                      OR (p.person_email IS NOT NULL AND c.email_key = lower(p.person_email))
                   )
              )
            )::int AS remaining
       FROM crm_bmi_projects p
      WHERE p.event_date BETWEEN $1::date AND $2::date
        AND ${NOT_ONLINE}
        AND p.state_id IS DISTINCT FROM '-4'
        AND ($3::int IS NULL OR p.location_id = $3::int)`,
    [filter.from, filter.until, filter.locationId ?? null],
  )) as { hosts: number; remaining: number }[];
  const row = rows[0];
  return { hosts: intOf(row?.hosts), remaining: intOf(row?.remaining) };
}

// ---------------------------------------------------------------------------
// Leads (counts, never money — `crm_leads.value_cents` is our own estimate)
// ---------------------------------------------------------------------------

export interface LeadFilter {
  from: string;
  until: string;
  /** `crm_reps.id`, or null for the whole team. */
  repId?: string | null;
  /** CentreCode, or null. */
  centre?: string | null;
}

export interface LeadSourceRow {
  source: string;
  leads: number;
  won: number;
}

/** Leads CREATED in the window, split by source, with how many reached a won status. */
export async function leadsBySource(filter: LeadFilter): Promise<LeadSourceRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT l.source,
            COUNT(*)::int AS leads,
            COUNT(*) FILTER (WHERE s.kind = 'won')::int AS won
       FROM crm_leads l
       LEFT JOIN crm_statuses s ON s.id = l.status_id
      WHERE l.archived_at IS NULL
        AND (l.created_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR l.assigned_rep_id = $3::bigint)
        AND ($4::text IS NULL OR l.centre = $4::text)
      GROUP BY l.source
      ORDER BY leads DESC`,
    [filter.from, filter.until, filter.repId ?? null, filter.centre ?? null],
  )) as { source: string; leads: number; won: number }[];
  return rows.map((r) => ({ source: r.source, leads: intOf(r.leads), won: intOf(r.won) }));
}

export interface FunnelRowRaw {
  statusId: string;
  label: string;
  position: number;
  kind: string;
  count: number;
  valueCents: number;
}

/**
 * The pipeline as OUR statuses see it: open leads whose EVENT is in the window,
 * by status. `value_cents` is the lead's own figure — our estimate of the deal,
 * which is what "dollars quoted in that stage" means on the prototype. It is
 * NOT a BMI figure and the card says so.
 */
export async function funnelByStatus(filter: LeadFilter): Promise<FunnelRowRaw[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT s.id AS status_id, s.label, s.position, s.kind,
            COUNT(l.id)::int AS n,
            COALESCE(SUM(l.value_cents), 0)::text AS cents
       FROM crm_statuses s
       LEFT JOIN crm_leads l
              ON l.status_id = s.id
             AND l.archived_at IS NULL
             AND l.event_date BETWEEN $1::date AND $2::date
             AND ($3::bigint IS NULL OR l.assigned_rep_id = $3::bigint)
             AND ($4::text IS NULL OR l.centre = $4::text)
      WHERE s.archived_at IS NULL
      GROUP BY s.id, s.label, s.position, s.kind
      ORDER BY s.position ASC`,
    [filter.from, filter.until, filter.repId ?? null, filter.centre ?? null],
  )) as {
    status_id: string;
    label: string;
    position: number;
    kind: string;
    n: number;
    cents: string | number | null;
  }[];
  return rows.map((r) => ({
    statusId: r.status_id,
    label: r.label,
    position: intOf(r.position),
    kind: r.kind,
    count: intOf(r.n),
    valueCents: centsOf(r.cents),
  }));
}

export async function lostReasons(filter: LeadFilter): Promise<{ reason: string; n: number }[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT COALESCE(NULLIF(btrim(l.lost_reason), ''), 'Not recorded') AS reason,
            COUNT(*)::int AS n
       FROM crm_leads l
       JOIN crm_statuses s ON s.id = l.status_id AND s.kind = 'lost'
      WHERE l.archived_at IS NULL
        AND (l.updated_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR l.assigned_rep_id = $3::bigint)
        AND ($4::text IS NULL OR l.centre = $4::text)
      GROUP BY reason
      ORDER BY n DESC, reason ASC
      LIMIT 8`,
    [filter.from, filter.until, filter.repId ?? null, filter.centre ?? null],
  )) as { reason: string; n: number }[];
  return rows.map((r) => ({ reason: r.reason, n: intOf(r.n) }));
}

/**
 * Minutes from `created_at` to `first_touch_at` for leads ASSIGNED in the
 * window — the brief's definition ("median first response over leads assigned
 * in range"; first touch is the first OUTBOUND call, text or email by the
 * assignee, which is what sets the column).
 *
 * Leads still untouched are EXCLUDED rather than counted as infinite: a median
 * that a single unanswered lead can send to infinity tells nobody anything.
 * The untouched count comes back beside it so the screen can say so.
 */
export async function responseMinutes(
  filter: LeadFilter,
): Promise<{ minutes: number[]; untouched: number }> {
  if (!isDbConfigured()) return { minutes: [], untouched: 0 };
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT CASE WHEN l.first_touch_at IS NULL THEN NULL
                 ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (l.first_touch_at - l.created_at)) / 60))::int
            END AS minutes
       FROM crm_leads l
      WHERE l.archived_at IS NULL
        AND l.assigned_at IS NOT NULL
        AND (l.assigned_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR l.assigned_rep_id = $3::bigint)
        AND ($4::text IS NULL OR l.centre = $4::text)`,
    [filter.from, filter.until, filter.repId ?? null, filter.centre ?? null],
  )) as { minutes: number | null }[];
  const minutes: number[] = [];
  let untouched = 0;
  for (const r of rows) {
    if (r.minutes === null || r.minutes === undefined) untouched += 1;
    else minutes.push(intOf(r.minutes));
  }
  return { minutes, untouched };
}

/** The same, per rep — the accountability card's own median. */
export async function responseMinutesByRep(filter: {
  from: string;
  until: string;
}): Promise<Map<string, number[]>> {
  if (!isDbConfigured()) return new Map();
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT l.assigned_rep_id::text AS rep_id,
            GREATEST(0, ROUND(EXTRACT(EPOCH FROM (l.first_touch_at - l.created_at)) / 60))::int AS minutes
       FROM crm_leads l
      WHERE l.archived_at IS NULL
        AND l.assigned_rep_id IS NOT NULL
        AND l.first_touch_at IS NOT NULL
        AND (l.assigned_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date`,
    [filter.from, filter.until],
  )) as { rep_id: string; minutes: number }[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const list = out.get(r.rep_id) ?? [];
    list.push(intOf(r.minutes));
    out.set(r.rep_id, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activities (the ONLY source for accountability counts)
// ---------------------------------------------------------------------------

export interface TouchCountRow {
  repId: string;
  /** 'call' | 'sms' | 'email' | 'reachout' */
  channel: string;
  touches: number;
  leads: number;
}

/**
 * Touches per rep per channel, **counted once per lead per channel per ET day**
 * (the rule from `crm-shared.js:418`, carried into B4's spec). Five calls to
 * one guest in an afternoon is one touch; calling five guests is five.
 *
 * A REACH-OUT is `kind='reachout'` OR any touch on a lead whose `source` is
 * `historical` — the brief's rule, and the reason a "call" to a last-year host
 * lands in BOTH columns: it is a call, and it is the reach-out we asked for.
 *
 * Inbound is excluded (`direction = 'out'` or a kind with no direction):
 * a guest texting us is not the rep's work. Auto-replies and delivery receipts
 * never reach `crm_activities` as a rep row at all.
 */
export async function touchCounts(filter: {
  from: string;
  until: string;
}): Promise<TouchCountRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `WITH touched AS (
       SELECT DISTINCT
              a.rep_id::text AS rep_id,
              CASE WHEN a.kind = 'reachout' THEN 'reachout' ELSE a.kind END AS channel,
              a.lead_id,
              (a.occurred_at AT TIME ZONE 'America/New_York')::date AS et_day
         FROM crm_activities a
        WHERE a.rep_id IS NOT NULL
          AND a.kind IN ('call','sms','email','reachout')
          AND (a.direction IS NULL OR a.direction = 'out')
          AND (a.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
     ), reachouts AS (
       SELECT DISTINCT
              a.rep_id::text AS rep_id,
              'reachout'::text AS channel,
              a.lead_id,
              (a.occurred_at AT TIME ZONE 'America/New_York')::date AS et_day
         FROM crm_activities a
         JOIN crm_leads l ON l.id = a.lead_id AND l.source = 'historical'
        WHERE a.rep_id IS NOT NULL
          AND a.kind IN ('call','sms','email','reachout')
          AND (a.direction IS NULL OR a.direction = 'out')
          AND (a.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
     ), merged AS (
       SELECT * FROM touched UNION SELECT * FROM reachouts
     )
     SELECT rep_id, channel, COUNT(*)::int AS touches,
            COUNT(DISTINCT lead_id)::int AS leads
       FROM merged
      GROUP BY rep_id, channel`,
    [filter.from, filter.until],
  )) as { rep_id: string; channel: string; touches: number; leads: number }[];
  return rows.map((r) => ({
    repId: r.rep_id,
    channel: r.channel,
    touches: intOf(r.touches),
    leads: intOf(r.leads),
  }));
}

/** Distinct leads a rep touched at all in the window (any channel). */
export async function leadsTouched(filter: {
  from: string;
  until: string;
}): Promise<Map<string, number>> {
  if (!isDbConfigured()) return new Map();
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `SELECT a.rep_id::text AS rep_id, COUNT(DISTINCT a.lead_id)::int AS n
       FROM crm_activities a
      WHERE a.rep_id IS NOT NULL
        AND a.lead_id IS NOT NULL
        AND a.kind IN ('call','sms','email','reachout','note')
        AND (a.direction IS NULL OR a.direction = 'out')
        AND (a.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
      GROUP BY a.rep_id`,
    [filter.from, filter.until],
  )) as { rep_id: string; n: number }[];
  return new Map(rows.map((r) => [r.rep_id, intOf(r.n)]));
}

/** Calls per rep per ET week over a span — the accountability sparkline. */
export async function callsByWeek(filter: {
  from: string;
  until: string;
}): Promise<{ repId: string; weekStart: string; calls: number }[]> {
  if (!isDbConfigured()) return [];
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q.query(
    `WITH touched AS (
       SELECT DISTINCT a.rep_id::text AS rep_id, a.lead_id,
              (a.occurred_at AT TIME ZONE 'America/New_York')::date AS et_day
         FROM crm_activities a
        WHERE a.rep_id IS NOT NULL
          AND a.kind = 'call'
          AND (a.direction IS NULL OR a.direction = 'out')
          AND (a.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
     )
     SELECT rep_id,
            (date_trunc('week', et_day)::date)::text AS week_start,
            COUNT(*)::int AS calls
       FROM touched
      GROUP BY rep_id, week_start`,
    [filter.from, filter.until],
  )) as { rep_id: string; week_start: string; calls: number }[];
  return rows.map((r) => ({
    repId: r.rep_id,
    weekStart: String(r.week_start),
    calls: intOf(r.calls),
  }));
}

/*
 * `reachOutCount` used to live here: a second `touchCounts` read that kept one
 * of its four channels, for the KPI dashboard's reach-out tile. The tile moved
 * to the accountability board (owner, 2026-09-13), which already reads
 * `touchCounts` for its per-rep meters, so the figure is summed off those rows
 * in `service/accountability.ts` (`reachOutProgress`) and the duplicate query
 * is gone with it.
 */

// ---------------------------------------------------------------------------
// Contracts + Square (bases `contract` and `square`)
// ---------------------------------------------------------------------------

/**
 * Money still to collect on events inside the next N ET days.
 *
 * Basis `square`: `deposit_due_cents` on a contract whose deposit has NOT been
 * paid, plus `balance_cents` on one whose balance has not. Both are what the
 * contract rail will CHARGE — it is cash, not booking value, and that is why
 * this tile is the one figure on the page that is not `bmi`.
 *
 * `group_function_quotes` belongs to the v1 contracts rail and has no
 * `ensureSchema` of its own here; `to_regclass` guards a preview database that
 * has never run it.
 */
export async function depositsDue(filter: {
  from: string;
  until: string;
  centerCode?: string | null;
}): Promise<{ outstandingCents: number; events: number; unsigned: number }> {
  if (!isDbConfigured()) return { outstandingCents: 0, events: 0, unsigned: 0 };
  await ensureMeasureReadable();
  const q = sql();
  const rows = (await q
    .query(
      `SELECT COALESCE(SUM(
              CASE WHEN g.deposit_paid_at IS NULL THEN COALESCE(g.deposit_due_cents, 0) ELSE 0 END
            + CASE WHEN g.balance_paid_at  IS NULL THEN COALESCE(g.balance_cents, 0)     ELSE 0 END
            ), 0)::text AS cents,
            COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE g.contract_signed_at IS NULL)::int AS unsigned
       FROM group_function_quotes g
      WHERE to_regclass('group_function_quotes') IS NOT NULL
        AND (g.event_date AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
        AND g.status NOT IN ('cancelled','denied','expired')
        AND ($3::text IS NULL OR g.center_code = $3::text)`,
      [filter.from, filter.until, filter.centerCode ?? null],
    )
    .catch(() => [])) as { cents: string | number | null; events: number; unsigned: number }[];
  const row = rows[0];
  return {
    outstandingCents: centsOf(row?.cents),
    events: intOf(row?.events),
    unsigned: intOf(row?.unsigned),
  };
}
