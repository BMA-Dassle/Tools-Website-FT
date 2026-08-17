/**
 * Pandora session scheduling for kiosk check-in — the call that puts a racer on
 * the timing grid ("checked into session"). Adapted from the proven
 * kiosk-post-reserve rail (buildKioskRacers + postSchedule), parameterized for
 * check-in and kept in the check-in feature so the multi-writer booking service
 * is untouched.
 *
 * ONE FAST ATTEMPT, THEN THE QUEUE (owner 2026-08-12). This module used to hold
 * the guest at the kiosk through a ~34s in-request ladder (10s + 20s straggler
 * re-POSTs) against a cloud→local project-person sync lag measured in MINUTES —
 * so it gave up, the racer was marked failed, staff hand-seated them in the
 * local client, and the duplicate T_PROJECT_PERSON row jammed Fast WSync for
 * the whole center (2026-08-11 incident). Now this makes a single quick attempt
 * (transport retry only), classifies every racer from Pandora's OWN per-racer
 * results, and hands anything retryable to the kiosk-bmi-sync-sweep cron, whose
 * retries span minutes. The guest never waits on sync.
 *
 * Per-racer outcome classification (the vendor spec's words, not ours):
 *  - inserted / already_linked  → linked (idempotent per racer, ≥2.4.57)
 *  - person_not_on_project      → WAITING — documented "retryable, NOT failed":
 *    the cloud attach hasn't synced down to the center's Firebird yet
 *  - schedule_not_found         → REFUSED — the heat block genuinely isn't on
 *    the local dayplanner (a retime/mismatch, a real bug wanting eyes)
 *  - anything else / no detail  → WAITING (the re-POST is idempotent, so
 *    retrying an unknown is safe; treating it as failed is what manufactured
 *    the hand-seat duplicates)
 *
 * SHORT Pandora ids only — the endpoint 500s on a 17-digit Office id (W52109),
 * and one bad id fails the whole batch, so the CALLER must pre-filter to racers
 * with a resolved short id (see completeCheckin). tier / category / heatStop are
 * REQUIRED strings or it 400s. This module never writes a memo — the caller
 * composes the single staff memo from the returned outcomes.
 */

import { partitionByCloudRoster } from "@/lib/bmi-cloud-roster";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";
const HEAT_DURATION_MIN = 7;

export interface ScheduleRacer {
  racerName: string;
  /** SHORT Pandora id — the only id the schedule endpoint accepts. */
  personId: string | null;
  /**
   * The OTHER id this human is known by (17-digit Office id when `personId` is
   * the short one, and vice versa). Never sent to Pandora — stripped before the
   * POST — it exists only so the cloud-roster guard can match a roster row that
   * carries the person under whichever id its minting rail used.
   */
  altPersonId?: string | null;
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

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
}

export type RacerOutcomeKind =
  /** Confirmed on the session (inserted or already_linked). */
  | "linked"
  /** Not on yet for a RETRYABLE reason (sync lag, transport, no detail) —
   *  the sweep's work token. Never show this to the guest as a failure. */
  | "waiting"
  /** Pandora positively refused (schedule_not_found) — terminal, wants eyes. */
  | "refused";

export interface RacerOutcome {
  personId: string;
  racerName: string;
  heatStart: string | null;
  kind: RacerOutcomeKind;
  /** Pandora's per-racer status word, or our transport-level reason
   *  ("transport", "count-only-partial", "no-result-row"). */
  vendorStatus: string;
}

export interface ScheduleResult {
  attempted: number;
  /** (person|heat) pairs confirmed on the session. */
  linked: number;
  /** One entry per attempted racer-heat pair. */
  outcomes: RacerOutcome[];
  /** Racer names not confirmed (waiting + refused) — caller memo/reporting. */
  unlinked: string[];
  /** Short personIds not confirmed — caller maps to per-person status. */
  unlinkedPersonIds: string[];
}

interface ScheduleResponseRow {
  personId?: string;
  heatStart?: string;
  status?: string;
}

/**
 * Schedule racers onto their Pandora sessions for an existing reservation —
 * ONE attempt (transport retry only, ~10s cap), per-racer classification.
 * Never throws. The caller must pass only racers with a resolved SHORT
 * pandoraPersonId (a 17-digit Office id 500s the whole batch).
 */
export async function scheduleCheckinRacers(args: {
  reservationNumber: string; // the W-number (path segment), NOT the 17-digit billId
  racers: ScheduleRacer[];
  /**
   * Person ids the CLOUD still carries on this reservation, from
   * `projectRosterCloudBarrier`. Racers absent from it are NOT posted — see the
   * WSync FK-orphan note below. Pass `null` when the roster could not be read:
   * the guard then does nothing and behaviour is exactly as before, because a
   * guard that fails CLOSED on an Office hiccup would stop every check-in.
   */
  cloudRoster?: ReadonlySet<string> | null;
}): Promise<ScheduleResult> {
  const assignable = args.racers.filter((r) => r.personId && r.heatStart);
  const result: ScheduleResult = {
    attempted: assignable.length,
    linked: 0,
    outcomes: [],
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
        // altPersonId is ours, not the vendor's — strip it so the wire payload
        // stays byte-identical to the shape this endpoint has always accepted.
        body: JSON.stringify({
          racers: batch.map(({ altPersonId: _alt, ...wire }) => wire),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { inserted?: number; results?: ScheduleResponseRow[] };
    } | null;
    if (!res.ok || !data?.success) {
      throw new Error(
        `schedule POST ${res.status}${data?.success === false ? " (success=false)" : ""}`,
      );
    }
    return data.data ?? {};
  };

  const outcomeFor = new Map<string, RacerOutcome>();
  const record = (r: ScheduleRacer, kind: RacerOutcomeKind, vendorStatus: string) => {
    outcomeFor.set(rKey(r), {
      personId: r.personId as string,
      racerName: r.racerName,
      heatStart: r.heatStart,
      kind,
      vendorStatus,
    });
  };

  /**
   * CLOUD-ROSTER GUARD (2026-08-16 — WSync FK jam, T_PARTICIPANT 58922217).
   *
   * Pandora's own insert already refuses a racer whose project-person is
   * missing (`person_not_on_project`) — but it looks that up in the CENTER'S
   * LOCAL table. In the window after a project-person is deleted cloud-side and
   * before that delete syncs down, the local row is stale-PRESENT, Pandora's
   * check passes, and the participant it writes is orphaned the moment the
   * delete lands. Its queued upload then violates FK_PAR_PRJP_ID and wedges Fast
   * WSync's whole upload batch for the center.
   *
   * So: anyone the CLOUD no longer has on this reservation is not posted at all.
   * They are recorded WAITING, never refused — the kiosk-bmi-sync-sweep re-drives
   * waiting rows every 2 minutes and its own barrier re-ATTACHES a person who is
   * genuinely missing from the project before re-seating them. A racer held here
   * is therefore queued, not dropped, which is what makes holding safe.
   */
  const guarded = args.cloudRoster
    ? partitionByCloudRoster(assignable, args.cloudRoster, (r) => [r.personId, r.altPersonId])
    : { onRoster: assignable, offRoster: [] as ScheduleRacer[] };
  for (const r of guarded.offRoster) record(r, "waiting", "off-cloud-roster");
  if (guarded.offRoster.length > 0) {
    console.warn(
      `[kiosk-checkin] ${args.reservationNumber}: held ${guarded.offRoster.length} racer(s) off the ` +
        `schedule POST — not on the cloud roster (would orphan a participant): ` +
        guarded.offRoster.map((r) => `${r.racerName}/${r.personId}`).join(", "),
    );
  }

  if (guarded.onRoster.length === 0) {
    result.outcomes = assignable.map((r) => outcomeFor.get(rKey(r))!);
    result.linked = 0;
    result.unlinked = [...new Set(result.outcomes.map((o) => o.racerName))];
    result.unlinkedPersonIds = [...new Set(result.outcomes.map((o) => o.personId))];
    return result;
  }

  try {
    const d = await withRetry("checkin schedule", () => postSchedule(guarded.onRoster));
    if (Array.isArray(d.results)) {
      const byKey = new Map<string, ScheduleResponseRow>();
      for (const row of d.results) byKey.set(rKey(row), row);
      for (const r of guarded.onRoster) {
        const status = byKey.get(rKey(r))?.status;
        if (status === "inserted" || status === "already_linked") {
          record(r, "linked", status);
        } else if (status === "schedule_not_found") {
          record(r, "refused", status);
        } else {
          // person_not_on_project (the documented retryable), an unknown word,
          // or no result row for this racer at all — all WAITING.
          record(r, "waiting", status ?? "no-result-row");
        }
      }
    } else if ((d.inserted ?? 0) >= guarded.onRoster.length) {
      // Count-only response covering the whole batch — everyone landed.
      for (const r of guarded.onRoster) record(r, "linked", "count-only");
    } else {
      // Count-only PARTIAL: Pandora didn't say WHO. The insert is idempotent
      // per racer (≥2.4.57 returns already_linked), so the sweep re-POSTs the
      // whole set safely — mark everyone unconfirmed as waiting. (The old code
      // skipped retries entirely here, which stranded real racers.)
      for (const r of guarded.onRoster) record(r, "waiting", "count-only-partial");
    }
  } catch (err) {
    console.error("[kiosk-checkin] schedule failed:", err instanceof Error ? err.message : err);
    for (const r of guarded.onRoster) record(r, "waiting", "transport");
  }

  result.outcomes = assignable.map((r) => outcomeFor.get(rKey(r))!);
  result.linked = result.outcomes.filter((o) => o.kind === "linked").length;
  const notLinked = result.outcomes.filter((o) => o.kind !== "linked");
  result.unlinked = [...new Set(notLinked.map((o) => o.racerName))];
  result.unlinkedPersonIds = [...new Set(notLinked.map((o) => o.personId))];

  return result;
}
