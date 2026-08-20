/**
 * Junior adjacency fence — the I/O half. Reads BMI, writes BMI, nothing else.
 *
 * The rule lives in junior-fence.ts (pure). This file fetches a day's sessions
 * per track, asks the planner what should be fenced, re-checks each slot is
 * STILL empty, and locks the product limit on the survivors.
 *
 * ── Why a sweep and not a hook on our own booking confirm ──
 * `/bmi/sessions` sits downstream of POS, kiosk and web alike, so one reader
 * covers all three channels. Our own surfaces already block adjacent juniors in
 * the picker and in the booking service — the fence exists to catch the
 * register. Hooking `patchHeatSetups` as well would put a second writer on the
 * same BMI entity, which tasks/lessons.md forbids.
 *
 * ── Add-only, by decision ──
 * Nothing is known to CLEAR a BMI product limit and no endpoint reads one back.
 * The planner still computes the fences whose junior booking has gone away; we
 * LOG that list and never execute it (owner 2026-08-16: "they can reset
 * manually if something falls"). The log is ops' worklist.
 *
 * ── What a booking does to a fence ──
 * Confirmed live 2026-08-16: session 58598953 was fenced and read
 * "24 - Adult Only"; an adult Starter booked it and the row became
 * "24 - Blue Starter". The limit stays, the visible marker does not. So a
 * fenced-then-booked slot silently leaves our view. That is tolerable while the
 * slot is occupied (the limit permitted the booking sitting in it) and is the
 * reason the remove list can never be trusted as a complete inventory.
 *
 * NEVER throws. A sweep failure must not take down a cron that also has to run
 * next minute.
 */
import redis from "@/lib/redis";
import { etDateIso } from "~/lib/constants/fasttrax-hours";
import {
  FENCE_TRACKS,
  planTrackFences,
  type BmiSessionRow,
  type FencePlan,
  type FenceTarget,
  type FenceTrack,
} from "./junior-fence";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
/** Races run only at FastTrax Fort Myers. */
const PANDORA_RACE_LOCATION_ID = "LAB52GY480CJF";

/**
 * Hard ceiling on writes per run. A planner bug must not be able to carpet the
 * dayplanner before anyone notices — on a normal day the sweep writes 0–3.
 */
const MAX_WRITES_PER_RUN = 20;

/**
 * Don't fence a slot starting sooner than this. A limit landing a minute before
 * the heat only blocks a walk-in nobody was going to sell anyway, and the
 * dayplanner churn is noise for the desk.
 */
const MIN_LEAD_MINUTES = 15;

/**
 * Kill switch — default ON, per the flags rule (a merged feature is on; a flag
 * exists only to turn it OFF in an emergency). Never an opt-in gate.
 */
export function juniorFenceEnabled(): boolean {
  return process.env.JUNIOR_FENCE_SWEEP !== "false";
}

async function pandora(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PANDORA_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
}

async function sessionsFor(date: string, track: FenceTrack): Promise<BmiSessionRow[]> {
  const res = await pandora(
    `/bmi/sessions/${PANDORA_RACE_LOCATION_ID}` +
      `?startDate=${date}T00:00:00&endDate=${date}T23:59:59` +
      `&resourceName=${encodeURIComponent(`${track} Track`)}`,
  );
  if (!res.ok) throw new Error(`sessions ${track} ${date}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: BmiSessionRow[] };
  return body.data ?? [];
}

/**
 * The limit's name is read from BMI, never hardcoded — it was renamed three
 * times on 2026-08-16 alone ("Adult Starter & Intermediate" → "Adult" →
 * "Adult Only"), and the planner recognises an existing fence BY that name.
 * A stale literal would make every fence look unrecognised and get re-added.
 */
/**
 * Cached, because this sweep runs EVERY MINUTE and this call reads one string.
 *
 * The name is renamed occasionally — three times on 2026-08-16 — which is why
 * it is read from BMI rather than hardcoded. But three times a YEAR is not
 * three times a MINUTE, and asking Pandora 1,440 times a day for a value that
 * changes a handful of times ever was the single most wasteful call we made
 * (measured 2026-08-19: this sweep was ~4,320 Pandora calls/day, a third of
 * them this one line).
 *
 * Five minutes is the whole exposure: a rename mid-window means at most one
 * sweep does not recognise an existing fence by its new name. That costs a
 * duplicate write attempt, not a wrong fence — and the pre-write re-read still
 * guards the slot itself.
 */
const LIMIT_CACHE_KEY = `junior-fence:limit:${PANDORA_RACE_LOCATION_ID}`;
const LIMIT_CACHE_TTL_SECONDS = 5 * 60;

async function resolveLimit(): Promise<{ id: number; name: string } | null> {
  try {
    const cached = await redis.get(LIMIT_CACHE_KEY);
    if (cached) {
      const v = JSON.parse(cached) as { id: number; name: string };
      if (v && typeof v.name === "string") return v;
    }
  } catch {
    /* an unreadable cache is not a reason to skip the read */
  }
  const res = await pandora(`/bmi/product-limits/${PANDORA_RACE_LOCATION_ID}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { id: number; name: string }[] };
  // "Lock Race" closes a heat outright; ours is the adult-only one.
  const limit = body.data?.find((l) => !/lock\s*race/i.test(l.name)) ?? null;
  if (limit) {
    redis
      .set(LIMIT_CACHE_KEY, JSON.stringify(limit), "EX", LIMIT_CACHE_TTL_SECONDS)
      .catch(() => void 0);
  }
  return limit;
}

export interface FenceWrite {
  track: FenceTrack;
  startLocal: string;
  slot: number;
  ok: boolean;
  detail: string;
  becauseOf: string[];
}

export interface JuniorFenceRunResult {
  ok: boolean;
  date: string;
  dryRun: boolean;
  limit: { id: number; name: string } | null;
  /** Fences written this run (or that would have been, on a dry run). */
  wrote: FenceWrite[];
  /** Planned, then dropped because the slot filled between plan and write. */
  raced: { track: FenceTrack; startLocal: string }[];
  /** Already fenced and still justified — no action. */
  held: number;
  /**
   * Fences whose junior booking is gone. NEVER executed — nothing clears a BMI
   * product limit. This is ops' manual-reset worklist.
   */
  shouldClear: { track: FenceTrack; startLocal: string; sessionId?: string }[];
  /** Junior heats already sitting back-to-back — the fence was too late. */
  tooLate: { track: FenceTrack; startLocal: string }[];
  /** Non-fatal problems (a track that failed to fetch, a capped run, …). */
  notes: string[];
}

function describe(t: FenceTarget): string[] {
  return t.becauseOf.map((b) => `${b.startLocal} ${b.name}`);
}

/**
 * Sweep one date across every junior-carrying track.
 *
 * `date` defaults to today in center time — the same-day sweep is the live one;
 * future dates are handled by the rolling sweep passing an explicit date.
 */
export async function runJuniorFenceSweep(
  opts: { date?: string; dryRun?: boolean } = {},
): Promise<JuniorFenceRunResult> {
  const date = opts.date ?? etDateIso();
  const dryRun = opts.dryRun === true;
  const result: JuniorFenceRunResult = {
    ok: true,
    date,
    dryRun,
    limit: null,
    wrote: [],
    raced: [],
    held: 0,
    shouldClear: [],
    tooLate: [],
    notes: [],
  };

  try {
    if (!juniorFenceEnabled()) {
      result.notes.push("disabled by JUNIOR_FENCE_SWEEP=false");
      return result;
    }
    if (!process.env.SWAGGER_ADMIN_KEY) {
      result.ok = false;
      result.notes.push("SWAGGER_ADMIN_KEY missing");
      return result;
    }

    const limit = await resolveLimit();
    result.limit = limit;
    if (!limit) {
      result.ok = false;
      result.notes.push("no usable product limit returned by BMI");
      return result;
    }

    let budget = MAX_WRITES_PER_RUN;

    for (const track of FENCE_TRACKS) {
      let plan: FencePlan;
      try {
        plan = planTrackFences(track, {
          date,
          sessions: await sessionsFor(date, track),
          limitName: limit.name,
          nowMs: Date.now(),
          minLeadMinutes: MIN_LEAD_MINUTES,
        });
      } catch (err) {
        result.ok = false;
        result.notes.push(`${track}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      result.held += plan.keep.length;
      for (const t of plan.remove)
        result.shouldClear.push({ track, startLocal: t.startLocal, sessionId: t.sessionId });
      for (const s of plan.existingAdjacentJuniorSlots)
        result.tooLate.push({
          track,
          startLocal: plan.placed.find((h) => h.slot === s)!.startLocal,
        });

      if (plan.add.length === 0) continue;

      // Re-read the board immediately before writing. The plan above is seconds
      // old and this race is REAL: on 2026-08-16 a slot we were about to fence
      // was booked during the wait, and only a pre-write re-check caught it.
      let live: Set<string>;
      try {
        live = new Set(
          planTrackFences(track, {
            date,
            sessions: await sessionsFor(date, track),
            limitName: limit.name,
            nowMs: Date.now(),
            minLeadMinutes: MIN_LEAD_MINUTES,
          }).add.map((t) => t.startLocal),
        );
      } catch (err) {
        result.ok = false;
        result.notes.push(`${track} re-check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const target of plan.add) {
        if (!live.has(target.startLocal)) {
          result.raced.push({ track, startLocal: target.startLocal });
          continue;
        }
        if (budget <= 0) {
          result.notes.push(`write cap ${MAX_WRITES_PER_RUN} reached — remaining slots next run`);
          break;
        }
        budget--;

        if (dryRun) {
          result.wrote.push({
            track,
            slot: target.slot,
            startLocal: target.startLocal,
            ok: true,
            detail: "dryRun",
            becauseOf: describe(target),
          });
          continue;
        }

        // Limit ONLY — no level/junior, so BMI applies no style and the slot is
        // fenced without being configured as a race (Pandora made those fields
        // optional on 2026-08-16 for exactly this).
        let ok = false;
        let detail: string;
        try {
          const res = await pandora(`/bmi/session/${PANDORA_RACE_LOCATION_ID}`, {
            method: "PATCH",
            body: JSON.stringify({
              track,
              heatStart: target.startLocal,
              productLimitId: limit.id,
            }),
          });
          const text = await res.text();
          ok = res.ok;
          detail = res.ok ? text.slice(0, 200) : `HTTP ${res.status} ${text.slice(0, 200)}`;
        } catch (err) {
          detail = err instanceof Error ? err.message : "fetch error";
        }
        if (!ok) result.ok = false;

        result.wrote.push({
          track,
          slot: target.slot,
          startLocal: target.startLocal,
          ok,
          detail,
          becauseOf: describe(target),
        });

        // Mirror to bmi:api:log exactly as session-setup.ts does — with no way
        // to read a limit back off a heat, this log is the only record that we
        // ever fenced a slot, and it survives the name being overwritten.
        try {
          await redis.lpush(
            "bmi:api:log",
            JSON.stringify({
              type: "junior-fence",
              timestamp: new Date().toISOString(),
              date,
              track,
              heatStart: target.startLocal,
              productLimitId: limit.id,
              productLimitName: limit.name,
              becauseOf: describe(target),
              outcome: ok ? "OK" : detail,
            }),
          );
          await redis.ltrim("bmi:api:log", 0, 4999);
        } catch {
          // Redis failure must not fail the sweep.
        }
      }
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
