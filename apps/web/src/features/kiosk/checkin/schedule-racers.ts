/**
 * Pandora session scheduling for kiosk check-in — the call that puts a racer on
 * the timing grid ("checked into session"). Adapted from the proven
 * kiosk-post-reserve rail (buildKioskRacers + postSchedule), parameterized for
 * check-in and kept in the check-in feature so the multi-writer booking service
 * is untouched.
 *
 * Differences from the booking rail, on purpose:
 *  - NO 8s reservation-sync pre-delay: at check-in the reservation synced long
 *    ago; the only lag is a just-registered person's cloud→local sync, handled
 *    by the targeted re-POSTs.
 *  - Idempotent per racer (Pandora returns already_linked) so scheduling the
 *    whole roster re-links nobody twice.
 *  - FastTrax-only: the schedule endpoint is hardcoded to the FastTrax racing
 *    Pandora location — the only racing venue today. The caller only reaches
 *    this for racing reservations (hasRacing), so a Naples booking never posts.
 *
 * SHORT Pandora ids only — the endpoint 500s on a 17-digit Office id (W52109),
 * and one bad id fails the whole batch, so the CALLER must pre-filter to racers
 * with a resolved short id (see completeCheckin). tier / category / heatStop are
 * REQUIRED strings or it 400s. This module never writes a memo — the caller
 * composes the single staff memo from the returned `unlinked`.
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";
const HEAT_DURATION_MIN = 7;

export interface ScheduleRacer {
  racerName: string;
  /** SHORT Pandora id — the only id the schedule endpoint accepts. */
  personId: string | null;
  product: string;
  productId: string | null;
  tier: string;
  track: "Red" | "Blue" | "Mega" | null;
  category: string;
  heatName: string;
  heatStart: string | null;
  heatStop: string | null;
}

/** heatStop = heatStart + 7 min, naive-UTC round-trip (kiosk-post-reserve idiom). */
export function addMinutesNaive(iso: string, min: number): string {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + min);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function heatStopFor(heatStart: string): string {
  return addMinutesNaive(heatStart, HEAT_DURATION_MIN);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
}

export interface ScheduleResult {
  attempted: number;
  linked: number;
  /** Racer names that couldn't be linked (sync lag) — caller memos these. */
  unlinked: string[];
  /** Short personIds that couldn't be linked — caller maps to per-person status. */
  unlinkedPersonIds: string[];
}

/**
 * Schedule racers onto their Pandora sessions for an existing reservation.
 * Never throws. The caller must pass only racers with a resolved SHORT
 * pandoraPersonId (a 17-digit Office id 500s the whole batch); this returns the
 * still-unlinked racers for the caller's single composed memo.
 */
export async function scheduleCheckinRacers(args: {
  reservationNumber: string; // the W-number (path segment), NOT the 17-digit billId
  racers: ScheduleRacer[];
}): Promise<ScheduleResult> {
  const assignable = args.racers.filter((r) => r.personId && r.heatStart);
  const result: ScheduleResult = {
    attempted: assignable.length,
    linked: 0,
    unlinked: [],
    unlinkedPersonIds: [],
  };
  if (assignable.length === 0) return result;

  const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
  const rKey = (r: { personId?: string | null; heatStart?: string | null }) =>
    `${r.personId}|${r.heatStart}`;

  const postSchedule = async (batch: ScheduleRacer[]) => {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/schedule/${FASTTRAX_RACING_LOCATION_ID}/${args.reservationNumber}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pandoraKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ racers: batch }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: {
        inserted?: number;
        results?: Array<{ personId?: string; heatStart?: string; status?: string }>;
      };
    } | null;
    if (!res.ok || !data?.success) {
      throw new Error(
        `schedule POST ${res.status}${data?.success === false ? " (success=false)" : ""}`,
      );
    }
    return data.data ?? {};
  };

  const linked = new Set<string>();
  let hasDetail = false;
  const applyResults = (
    batch: ScheduleRacer[],
    d: { inserted?: number; results?: Array<{ status?: string } & Record<string, unknown>> },
  ): boolean => {
    if (Array.isArray(d.results)) {
      for (const row of d.results) {
        if (row.status === "inserted" || row.status === "already_linked") {
          linked.add(rKey(row as { personId?: string; heatStart?: string }));
        }
      }
      return true;
    }
    // Count-only response: only trust it if the whole batch inserted (a partial
    // count-only can't tell us WHICH — re-POSTing blind would double-link).
    if ((d.inserted ?? 0) >= batch.length) for (const r of batch) linked.add(rKey(r));
    return false;
  };

  let missing = assignable;
  try {
    hasDetail = applyResults(
      assignable,
      await withRetry("checkin schedule", () => postSchedule(assignable)),
    );
    missing = assignable.filter((r) => !linked.has(rKey(r)));
  } catch (err) {
    console.error("[kiosk-checkin] schedule failed:", err instanceof Error ? err.message : err);
  }

  // Targeted re-POSTs for stragglers (project-person cloud→local sync lag) —
  // only when the API named who's missing.
  if (missing.length > 0 && hasDetail) {
    for (const backoffMs of [10_000, 20_000]) {
      await new Promise((r) => setTimeout(r, backoffMs));
      try {
        applyResults(missing, await postSchedule(missing));
      } catch (err) {
        console.error(
          "[kiosk-checkin] schedule re-POST failed:",
          err instanceof Error ? err.message : err,
        );
      }
      missing = assignable.filter((r) => !linked.has(rKey(r)));
      if (missing.length === 0) break;
    }
  }

  result.linked = linked.size;
  result.unlinked = [...new Set(missing.map((r) => r.racerName))];
  result.unlinkedPersonIds = [
    ...new Set(missing.map((r) => r.personId).filter((id): id is string => !!id)),
  ];

  return result;
}
