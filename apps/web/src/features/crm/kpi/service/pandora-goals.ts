/**
 * The downstream mirror: `crm_goals` → Pandora `/v2/bmi/goals`, so commissions
 * keep reading the same numbers the owner types here.
 *
 * NEON IS THE SOURCE OF TRUTH AND IS WRITTEN FIRST (brief C7, CLAUDE.md
 * "ALWAYS persist guest-provided data to our own DB at capture — independent
 * of, and not gated on, the external API call"). By the time anything in this
 * file runs, the owner's grid is already committed. A failure here can only
 * delay the mirror; it can never lose an input.
 *
 * A FAILURE IS QUEUED AND SHOWN, NEVER SWALLOWED: the caller runs this through
 * `crm_jobs` (`pandora-goals-sync`), so a bad run leaves a `failed` row with
 * its error, the runner retries it with backoff, and the Goals screen prints
 * the state beside the year. `markGoalsSynced` is called ONLY when every month
 * was accepted — a partial push leaves the year unsynced rather than claiming
 * a mirror that is half there.
 *
 * PANDORA'S SHAPE, read from `C:\GIT\Pandora_API\src` (brief C7):
 *   POST /v2/bmi/goals  {salesName: string, year: number, month: number, goal: number}
 *     → 201 {success, data:{salesGoalID, salesName, year, month, goal}}
 *   It upserts on `(salesName, year, month)` — `prisma.salesGoal.upsert` — so
 *   re-sending a month is idempotent and re-running a failed job is safe.
 *   `goal` is a NUMBER IN DOLLARS (`bmi.models.ts` `z.number().min(0)`), which
 *   is why cents are divided here and nowhere else.
 *
 * IT IS KEYED BY REP NAME WITH NO CENTRE, so per-centre `crm_goals` rows cannot
 * mirror 1:1. The job sends the per-rep TOTAL (Σ across centres) under
 * `crm_reps.bmi_username`, and the Goals screen carries that as a footnote.
 *
 * `parseWithRawIds(text, ["salesGoalID"])` out of habit: these ids are small
 * Prisma integers, not 17-digit BMI ids, but a JSON id read through `res.json()`
 * is the exact shape of the production off-by-one and the habit costs nothing.
 */

import { parseWithRawIds } from "@ft/db";
import type { CrmRep } from "~/features/crm/core/types";
import type { PandoraGoalsRunSummary } from "../contracts";
import { markGoalsSynced, sumGoalsForYear } from "../data/goals-db";

export const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

/** Pandora's own guard rail (`bmiPostParams`): a goal before 2025 is rejected. */
export const PANDORA_MIN_YEAR = 2025;

const TIMEOUT_MS = 20_000;

export interface PandoraGoalResponse {
  salesGoalID: string;
  salesName: string;
  year: number;
  month: number;
  goal: number;
}

export interface GoalsPushDeps {
  fetch?: typeof fetch;
  apiKey?: string | null;
  now?: () => Date;
}

/** Cents → the whole-dollar number Pandora's schema accepts. */
export function goalDollars(cents: number): number {
  return Math.round(cents / 100);
}

export class PandoraGoalsError extends Error {
  readonly month: number | null;
  readonly status: number;
  constructor(message: string, month: number | null, status: number) {
    super(message);
    this.name = "PandoraGoalsError";
    this.month = month;
    this.status = status;
  }
}

/** POST one month. Throws `PandoraGoalsError` on anything but an accepted body. */
export async function putPandoraGoal(
  input: { salesName: string; year: number; month: number; goalCents: number },
  deps: GoalsPushDeps = {},
): Promise<PandoraGoalResponse> {
  const apiKey = deps.apiKey ?? process.env.SWAGGER_ADMIN_KEY ?? null;
  if (!apiKey) throw new PandoraGoalsError("SWAGGER_ADMIN_KEY not configured", input.month, 500);
  const doFetch = deps.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${PANDORA_URL}/bmi/goals`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        salesName: input.salesName,
        year: input.year,
        month: input.month,
        goal: goalDollars(input.goalCents),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const aborted =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new PandoraGoalsError(
      aborted ? "Pandora timed out" : err instanceof Error ? err.message : "Pandora fetch error",
      input.month,
      aborted ? 504 : 502,
    );
  }

  // RAW TEXT, never `res.json()` — the body carries an id.
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    body = parseWithRawIds<Record<string, unknown>>(text, ["salesGoalID"]);
  } catch {
    body = null;
  }
  if (!res.ok || !body) {
    const message =
      (body?.message as string | undefined) ?? `Pandora returned ${res.status || 502}`;
    throw new PandoraGoalsError(message, input.month, res.status || 502);
  }
  if (typeof body.success === "boolean" && !body.success) {
    throw new PandoraGoalsError(
      (body.message as string | undefined) ?? "Pandora rejected the goal",
      input.month,
      res.status || 400,
    );
  }
  const data = (body.data as Record<string, unknown> | undefined) ?? body;
  return {
    salesGoalID: data.salesGoalID === undefined ? "" : String(data.salesGoalID),
    salesName: String(data.salesName ?? input.salesName),
    year: Number(data.year ?? input.year),
    month: Number(data.month ?? input.month),
    goal: Number(data.goal ?? goalDollars(input.goalCents)),
  };
}

/**
 * Mirror ONE rep's whole year. Every month with a goal is sent, oldest first;
 * the first refusal stops the run and the job's error names the month, so a
 * retry is not a mystery.
 *
 * A rep with no `bmi_username` is SKIPPED, not guessed: Pandora matches on the
 * name and there is no safe default. The skip reason is the job's result and
 * the Goals screen shows it — the same refuse-rather-than-guess rule §5.7b
 * applies to Office user ids.
 */
export async function pushRepGoals(
  rep: CrmRep,
  year: number,
  deps: GoalsPushDeps = {},
): Promise<PandoraGoalsRunSummary> {
  const salesName = rep.bmiUsername?.trim() ?? "";
  if (!salesName) {
    return {
      ok: false,
      repSlug: rep.slug,
      salesName: "",
      year,
      months: [],
      skipped: `${rep.displayName} has no BMI username; Pandora matches goals by name.`,
    };
  }
  if (year < PANDORA_MIN_YEAR) {
    return {
      ok: false,
      repSlug: rep.slug,
      salesName,
      year,
      months: [],
      skipped: `Pandora only accepts goals from ${PANDORA_MIN_YEAR} onward.`,
    };
  }

  const months = await sumGoalsForYear(rep.id, year);
  const sent: PandoraGoalsRunSummary["months"] = [];
  for (const m of months) {
    const answer = await putPandoraGoal(
      { salesName, year, month: m.month, goalCents: m.goalCents },
      deps,
    );
    sent.push({
      month: m.month,
      goalDollars: goalDollars(m.goalCents),
      salesGoalId: answer.salesGoalID || null,
    });
  }

  const now = deps.now?.() ?? new Date();
  await markGoalsSynced(rep.id, year, now);
  return { ok: true, repSlug: rep.slug, salesName, year, months: sent, skipped: null };
}

/** `crm_jobs` idempotency key — one mirror per rep per year per minute. */
export function goalsSyncKey(repSlug: string, year: number, now: Date): string {
  return `pandora-goals-sync:${repSlug}:${year}:${now.toISOString().slice(0, 16)}`;
}
