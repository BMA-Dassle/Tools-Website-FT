import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";
import { getBowlingExperiences, type BowlingExperienceKind } from "@/lib/bowling-db";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";
import {
  earliestProbeMin,
  etNowDateAndMinutes,
} from "~/features/booking/service/availability-window";
import {
  evaluateWindow,
  minConfiguredMinutes,
  resolveOptionMinutes,
  type ProbeMap,
} from "~/features/booking/service/duration-feasibility";
import { etMinutesOfDay } from "~/components/features/booking/steps/bowling/availability-client";
import { FASTTRAX_QAMF_CENTER_ID, FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";

// Cold-start + 4-7 batches of 8 probes can exceed the default 10s budget
// when QAMF auth is also cold. Other QAMF-touching routes use 30s; match
// that so we don't 504 ourselves into a false "no slots" UX.
export const maxDuration = 30;

/**
 * GET /api/bowling/v2/availability
 *
 * Returns available bowling slots for a given date, filtered to only
 * experiences that are valid on that day of week (via daysOfWeek in DB).
 *
 * Two modes:
 *
 * 1. **Targeted** (hour + minute provided) — probes QAMF at the exact
 *    selected time for each valid experience's offer ID. Fast: one probe
 *    per offer (typically 2–4 calls). Used by the booking wizard after
 *    the guest picks a time.
 *
 * 2. **Full-day** (no hour/minute) — probes every 15 minutes from open
 *    to close. Used by KBF reschedule and any case needing all slots.
 *    Still filtered to only valid-day experiences.
 *
 * QAMF's searchAvailability is a point-in-time check — StartAt must equal
 * EndAt. It returns ALL enabled web offers regardless of any filter, so
 * server-side post-filtering by known offer IDs is required.
 *
 * Both HeadPinz centers are in Eastern time.
 *
 * Query params:
 *   centerId        — QAMF center ID (required)
 *   players         — number of players (required)
 *   startDate       — ISO date string 'YYYY-MM-DD' (required)
 *   hour            — selected hour 0–25 (optional; 24=midnight, 25=1am)
 *   minute          — selected minute 0/15/30/45 (optional, requires hour)
 *   kind            — experience kind filter: 'kbf' | 'open' | 'hourly' (optional)
 *   durationMinutes — booking duration in minutes; overrides WebOffer option (optional)
 */

// QAMF center ID → Square center code
const QAMF_TO_CENTER_CODE: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

// QAMF center ID → HP_LOCATIONS slug (for closing-time lookup).
// FastTrax duckpin shares the Fort Myers building, so it reuses FM hours.
const QAMF_TO_HP_SLUG: Record<number, string> = {
  9172: "fort-myers",
  3148: "naples",
  [FASTTRAX_QAMF_CENTER_ID]: "fort-myers",
};

/**
 * Parse "11AM" → 11, "12AM" → 24, "2AM" → 26, "9PM" → 21.
 * Post-midnight hours (12 AM, 1 AM, 2 AM) are 24+ so they sort after 11 PM.
 */
function parseHourToken(token: string): number {
  const m = token.trim().match(/^(\d+)(AM|PM)$/i);
  if (!m) return 11;
  let h = parseInt(m[1], 10);
  const period = m[2].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h <= 2) h += 24; // 12 AM → 24, 1 AM → 25, 2 AM → 26
  if (period === "AM" && h === 12) h = 24; // 12 AM → 24 (midnight)
  return h;
}

/**
 * Return { open, close } hours (24+ notation) for the given QAMF center
 * on a specific date. Sun-Thu → hours, Fri-Sat → hoursWeekend.
 */
function centerHoursForDate(centerId: number, dateStr: string): { open: number; close: number } {
  const slug = QAMF_TO_HP_SLUG[centerId];
  const loc = slug ? HP_LOCATIONS[slug] : undefined;
  if (!loc) return { open: 9, close: 26 };
  const dow = new Date(`${dateStr}T12:00:00`).getDay();
  const isWeekend = dow === 5 || dow === 6;
  const hoursStr = isWeekend ? loc.hoursWeekend : loc.hours;
  // Parse "Mon-Thu 11AM-11PM" → open=11, close=23
  const timePart = hoursStr.split(" ").pop() ?? "11AM-2AM";
  const dash = timePart.lastIndexOf("-");
  const openToken = timePart.slice(0, dash);
  const closeToken = timePart.slice(dash + 1);
  return { open: parseHourToken(openToken), close: parseHourToken(closeToken) };
}

/**
 * Check whether a slot's start time + duration would exceed the center's
 * closing time. `bookedAt` is an ISO string with ET offset.
 */
function slotExceedsClose(bookedAt: string, durationMin: number, closeHour24: number): boolean {
  const d = new Date(bookedAt);
  const endMs = d.getTime() + durationMin * 60_000;
  const end = new Date(endMs);
  const endET = new Date(end.toLocaleString("en-US", { timeZone: "America/New_York" }));
  let endHour24 = endET.getHours() + endET.getMinutes() / 60;
  if (endHour24 < 6) endHour24 += 24;
  return endHour24 > closeHour24;
}

/** A probe instant: ET minutes-of-day (0-26h notation) + the ISO QAMF gets. */
interface ProbeSlot {
  min: number;
  iso: string;
}

function buildProbeTime(date: string, hour: number, minute: number, tzOffset: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const calHour = hour % 24;
  let calDate = date;
  if (hour >= 24) {
    const next = new Date(y, mo - 1, d + 1);
    calDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  }
  return `${calDate}T${String(calHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${tzOffset}`;
}

function buildFullDayProbeTimes(
  date: string,
  tzOffset: string,
  openHour: number,
  closeHour: number,
  stepMinutes = 15,
  earliestMin = 0,
): ProbeSlot[] {
  const times: ProbeSlot[] = [];
  const [y, mo, d] = date.split("-").map(Number);
  const nextDate = new Date(y, mo - 1, d + 1);
  const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;

  // Probe from open to close at the requested granularity. QAMF is point-in-time
  // (one probe per slot), so a finer step = more probes = slower. Callers that
  // need the WHOLE day (the bowling time picker) pass a coarser step (e.g. 60)
  // to stay under the function timeout; KBF reschedule keeps the 15-min default.
  //
  // `earliestMin` floors the scan for today (now + leadMinutes) — QAMF happily
  // reports availability at times already past, which is how "12:00 PM" was
  // still offered at 12:17 PM in every full-day consumer (tier badges, the
  // offer step's widen scan, combos, KBF admin). The grid stays anchored at
  // openHour so slot alignment (on-the-hour chips) is unchanged; past steps
  // are skipped rather than shifting the grid.
  const step = Math.max(15, stepMinutes);
  for (let t = openHour * 60; t <= closeHour * 60; t += step) {
    if (t < earliestMin) continue;
    const h = Math.floor(t / 60);
    const m = t % 60;
    const calHour = h % 24;
    const calDate = h >= 24 ? nextDateStr : date;
    times.push({
      min: t,
      iso: `${calDate}T${String(calHour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tzOffset}`,
    });
  }
  return times;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const centerIdStr = searchParams.get("centerId");
  const playersStr = searchParams.get("players");
  const startDate = searchParams.get("startDate");
  const hourStr = searchParams.get("hour");
  const minuteStr = searchParams.get("minute");
  // `kind` accepts a single value ("kbf") or a comma-separated list
  // ("open,hourly"). The open wizard sends both so KBF offers don't leak into
  // its availability — KBF experiences are filtered client-side, so a slot
  // whose webOfferId belongs to a KBF experience contributes to no tier and
  // silently breaks the "next available" fallback.
  const kindStr = searchParams.get("kind");
  const validKindValues: BowlingExperienceKind[] = ["kbf", "open", "hourly"];
  const kinds: BowlingExperienceKind[] = kindStr
    ? (kindStr
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean) as BowlingExperienceKind[])
    : [];
  for (const k of kinds) {
    if (!validKindValues.includes(k)) {
      console.log(`[avail] EXIT: invalid kind value '${k}'`);
      return NextResponse.json(
        { error: `invalid kind: ${k}. Must be one of: ${validKindValues.join(", ")}` },
        { status: 400 },
      );
    }
  }
  const webOfferIdStr = searchParams.get("webOfferId");
  const durationMinStr = searchParams.get("durationMinutes");

  console.log(
    `[avail] ENTRY params: centerId=${centerIdStr} players=${playersStr} date=${startDate} hour=${hourStr} min=${minuteStr} kinds=[${kinds.join(",")}]`,
  );

  if (!centerIdStr || !playersStr || !startDate) {
    console.log(`[avail] EXIT: missing required params`);
    return NextResponse.json(
      { error: "centerId, players, and startDate are required" },
      { status: 400 },
    );
  }

  const centerId = parseInt(centerIdStr, 10);
  const players = parseInt(playersStr, 10);
  const webOfferId = webOfferIdStr ? parseInt(webOfferIdStr, 10) : undefined;
  const durationMinOver = durationMinStr ? parseInt(durationMinStr, 10) : undefined;
  // Full-day probe granularity (minutes). Coarser = fewer QAMF probes = faster;
  // the bowling time picker passes 60 (hourly) so a whole-day scan stays under
  // the timeout. Defaults to 15 (KBF reschedule + targeted mode).
  const stepMinutesStr = searchParams.get("stepMinutes");
  const stepMinutes = stepMinutesStr ? Math.max(15, parseInt(stepMinutesStr, 10)) : 15;
  // Targeted-mode fan-out (±minutes around the selected time). Default 300 (±5h);
  // the fine bowling probe passes a small value to scan just one hour.
  const windowMinutesStr = searchParams.get("windowMinutes");
  const windowMinutes = windowMinutesStr ? Math.max(15, parseInt(windowMinutesStr, 10)) : 300;
  // How close to "now" a today probe may start (minutes). Guest flows keep
  // the 15-min default; the admin combo time-shift passes 5 so a manager can
  // pull bowling nearly to now when the races finish early; the kiosk passes
  // 0 (walk-up ASAP — owner 7/17: no artificial minimum lead time).
  const leadMinutesStr = searchParams.get("leadMinutes");
  const leadMinutes = leadMinutesStr ? Math.max(0, parseInt(leadMinutesStr, 10) || 0) : 15;
  // optionCheck=accurate (2026-07-19): duration-accurate mode. The default
  // response echoes every configured Time option per slot — QAMF returns the
  // full option triple regardless of whether the LANE is actually free for
  // that long, which is how the 2-hour offer showed at any time the 1.5-hour
  // was open. Accurate mode window-filters each Time option against the
  // point-in-time probe map (branch D of the plan: a duration is only
  // POSSIBLE if its offer shows availability at every probed instant of the
  // window — sound rejection; unprobed instants fail open). Opt-in so legacy
  // consumers see zero behavior change.
  const accurate = searchParams.get("optionCheck") === "accurate";

  if (isNaN(centerId) || isNaN(players) || players < 1) {
    console.log(`[avail] EXIT: invalid centerId or players`);
    return NextResponse.json({ error: "invalid centerId or players" }, { status: 400 });
  }

  // ── Resolve center code → look up valid experiences from DB ──────
  const centerCode = QAMF_TO_CENTER_CODE[centerId];
  if (!centerCode) {
    console.log(`[avail] EXIT: unknown centerId ${centerId}`);
    return NextResponse.json({ error: `unknown centerId: ${centerId}` }, { status: 400 });
  }

  const dow = new Date(`${startDate}T12:00:00`).getDay(); // 0=Sun … 6=Sat

  // Get experiences valid for this day-of-week.
  // DB function only filters by a single kind, so for multi-kind requests we
  // fetch all and post-filter — cheaper than two separate DB round-trips.
  const dbKind = kinds.length === 1 ? kinds[0] : undefined;
  const allExperiences = await getBowlingExperiences(centerCode, dbKind);
  let validExperiences = allExperiences.filter(
    (e) => !e.daysOfWeek.length || e.daysOfWeek.includes(dow),
  );
  if (kinds.length > 1) {
    validExperiences = validExperiences.filter((e) => kinds.includes(e.kind));
  }

  console.log(
    `[avail] experiences: all=${allExperiences.length} valid=${validExperiences.length} dow=${dow} offerIds=[${validExperiences.map((e) => e.qamfWebOfferId).join(",")}]`,
  );

  // When webOfferId is specified (e.g. reschedule), narrow to just that offer
  if (webOfferId) {
    validExperiences = validExperiences.filter((e) => e.qamfWebOfferId === webOfferId);
  }

  if (validExperiences.length === 0) {
    console.log(
      `[avail] EXIT: no valid experiences for dow=${dow} centerCode=${centerCode} kind=${kindStr}`,
    );
    return NextResponse.json({ Availabilities: [] });
  }

  // Collect the set of known offer IDs for server-side post-filtering
  const validOfferIds = new Set(validExperiences.map((e) => e.qamfWebOfferId));

  // Accurate mode: experiences sharing each offer (Fun 4 All shares 154 with
  // regular-mon-thur) — resolveOptionMinutes needs the union — plus the
  // longest configured duration, which bounds how far past the display window
  // the probe fan-out must extend for tail checks.
  const offerConfigs = new Map<number, typeof validExperiences>();
  let maxDurationMin = 0;
  if (accurate) {
    for (const e of validExperiences) {
      const arr = offerConfigs.get(e.qamfWebOfferId) ?? [];
      arr.push(e);
      offerConfigs.set(e.qamfWebOfferId, arr);
      const durations = [
        e.qamfOfferDurationMinutes ?? 0,
        ...(e.durationOptions ?? []).map((d) => d.durationMinutes),
      ];
      maxDurationMin = Math.max(maxDurationMin, ...durations);
    }
  }

  // Both centers are in Southwest Florida (Eastern time).
  const month = parseInt(startDate.slice(5, 7), 10);
  const tzOffset = month >= 3 && month <= 11 ? "-04:00" : "-05:00";

  // ── Build probe times ────────────────────────────────────────────
  const hasSelectedTime = hourStr !== null && minuteStr !== null;
  const { open: openHour, close: closeHour } = centerHoursForDate(centerId, startDate);

  // Earliest allowed probe (minutes from midnight, 0-26h notation): opening
  // time for future dates, now + leadMinutes for today (incl. the weekend
  // post-midnight tail). Applied to BOTH modes — full-day previously had no
  // floor, which is how past slots (12:00 PM at 12:17 PM) reached the tier
  // badges, the widen scan, combos and the KBF admin.
  const { nowDateEt, nowMinutesEt } = etNowDateAndMinutes();
  const earliestMin = earliestProbeMin({
    startDate,
    nowDateEt,
    nowMinutesEt,
    openHour,
    closeHour,
    leadMinutes,
  });

  let probeTimes: ProbeSlot[];
  // Accurate mode, targeted window: extra probes PAST the display window so
  // tail-window checks for the last displayed slots have data. Never shown —
  // they only feed the probe map.
  const extraProbeTimes: ProbeSlot[] = [];

  if (hasSelectedTime) {
    // Targeted mode: probe ±windowMinutes around the selected time so the
    // tier step can show "Next available at …" when the exact time is sold
    // out. Default 300 (±5h); the coarse→fine bowling picker passes a small
    // value (e.g. 45) to probe just the chosen hour at 15-min granularity.
    const hour = parseInt(hourStr!, 10);
    const minute = parseInt(minuteStr!, 10);

    const windowStart = Math.max(hour * 60 + minute - windowMinutes, earliestMin);
    const windowEnd = Math.min(hour * 60 + minute + windowMinutes, closeHour * 60);

    probeTimes = [];
    for (let t = windowStart; t <= windowEnd; t += 15) {
      const probeH = Math.floor(t / 60);
      const probeM = t % 60;
      probeTimes.push({ min: t, iso: buildProbeTime(startDate, probeH, probeM, tzOffset) });
    }

    if (accurate && maxDurationMin > 15) {
      const tailEnd = Math.min(windowEnd + maxDurationMin - 15, closeHour * 60);
      for (let t = windowEnd + 15; t <= tailEnd; t += 15) {
        const probeH = Math.floor(t / 60);
        const probeM = t % 60;
        extraProbeTimes.push({ min: t, iso: buildProbeTime(startDate, probeH, probeM, tzOffset) });
      }
    }
  } else {
    // Full-day mode: probe open→close at the requested granularity, floored
    // to earliestMin for today. (No tail probes needed — the grid already
    // reaches close, and past-close durations are dropped by the close
    // filter before the window check matters.)
    probeTimes = buildFullDayProbeTimes(
      startDate,
      tzOffset,
      openHour,
      closeHour,
      stepMinutes,
      earliestMin,
    );
  }

  // ── Probe QAMF ──────────────────────────────────────────────────
  // QAMF ignores the WebOffer.Id filter and returns ALL enabled offers
  // in every response. So we only need one probe per time slot (not one
  // per offer × time). We post-filter by validOfferIds afterward.

  try {
    // Probe in batches of 8 to avoid QAMF rate limiting, with error tracking.
    // Each probe gets one retry on failure — cold Lambdas + cold Redis +
    // cold QAMF auth on the first request after a deploy used to fail
    // silently, producing { Availabilities: [] } and a false "no slots"
    // UI. A single retry catches that transient blip without inflating
    // latency on the warm path.
    type ProbeResult = {
      Availabilities: Array<{
        TotalPlayers: number;
        BookedAt: string;
        WebOffer: { Id: string | number; Options: Record<string, unknown>; Services: string[] };
      }>;
    };
    type ProbeOutcome = { slot: ProbeSlot; ok: boolean; data: ProbeResult };
    let probeErrorsLogged = 0;
    async function probeOne(slot: ProbeSlot): Promise<ProbeOutcome> {
      const call = () =>
        searchAvailability(centerId, {
          BookedAtRange: { StartAt: slot.iso, EndAt: slot.iso },
          TotalPlayers: players,
          WebOffer: { Services: ["BookForLater"] },
        });
      try {
        return { slot, ok: true, data: await call() };
      } catch {
        try {
          return { slot, ok: true, data: await call() };
        } catch (err2) {
          probeErrorsLogged++;
          if (probeErrorsLogged <= 3) {
            console.warn(
              `[avail] probe error at ${slot.iso} (after retry): ${err2 instanceof Error ? err2.message : String(err2)}`,
            );
          }
          return { slot, ok: false, data: { Availabilities: [] } };
        }
      }
    }
    const allSlots = [...probeTimes, ...extraProbeTimes];
    const outcomes: ProbeOutcome[] = [];
    for (let i = 0; i < allSlots.length; i += 8) {
      const batch = allSlots.slice(i, i + 8);
      outcomes.push(...(await Promise.all(batch.map(probeOne))));
    }
    const displayOutcomes = outcomes.slice(0, probeTimes.length);
    const probeErrors = displayOutcomes.filter((o) => !o.ok).length;

    // When *every* display probe failed even after retry, we have no signal —
    // returning 200 + empty would be indistinguishable from "this day
    // is sold out" and the client would render "No slots available."
    // Surface a 502 so the wizard can show a retry-able banner instead
    // of misleading the user.
    if (probeErrors === probeTimes.length && probeTimes.length > 0) {
      console.error(
        `[avail] all ${probeTimes.length} probes failed for centerId=${centerId} date=${startDate}`,
      );
      return NextResponse.json(
        { error: "Availability temporarily unavailable, please retry" },
        { status: 502 },
      );
    }

    // Probe map for accurate-mode window checks: minutes-of-day → the offer
    // ids QAMF reported at that instant. Only SUCCESSFUL probes get a key —
    // a failed probe must read as "unknown" (fail-open), never "no offers".
    const probeMap: ProbeMap = new Map();
    if (accurate) {
      for (const o of outcomes) {
        if (!o.ok) continue;
        const ids = new Set<number>();
        for (const a of o.data.Availabilities ?? []) ids.add(Number(a.WebOffer.Id));
        probeMap.set(o.slot.min, ids);
      }
    }

    // Flatten, deduplicate by (BookedAt + WebOffer.Id), filter to valid offers.
    // QAMF's spec types WebOffer.Id as string | number and we've seen it flip
    // per-center; normalize to number here so the client can use strict ===
    // against DB-sourced numeric offer IDs without silent type-mismatch.
    // DISPLAY probes only — the tail probes exist purely for the window check.
    const seen = new Set<string>();
    let availabilities = displayOutcomes
      .flatMap((o) => o.data.Availabilities)
      .map((a) => ({ ...a, WebOffer: { ...a.WebOffer, Id: Number(a.WebOffer.Id) } }))
      .filter((a) => {
        if (!validOfferIds.has(a.WebOffer.Id)) return false;
        const key = `${a.BookedAt}::${a.WebOffer.Id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.BookedAt.localeCompare(b.BookedAt));

    // Filter slots that would run past closing time.
    // For Time offers with multiple duration options (e.g. 60min + 90min),
    // strip individual options that exceed close but keep the slot if at
    // least one option still fits. This lets Fun 4 All fall back to a
    // shorter duration near closing instead of disappearing entirely.
    availabilities = availabilities
      .map((a) => {
        if (durationMinOver) {
          return slotExceedsClose(a.BookedAt, durationMinOver, closeHour) ? null : a;
        }
        const timeOpts = (
          a.WebOffer?.Options as { Time?: Array<{ Id: string | number; Minutes?: number }> }
        )?.Time;
        if (!timeOpts?.length) return a; // Game/Unlimited — keep as-is
        const validTimeOpts = timeOpts.filter(
          (t) =>
            !t.Minutes || t.Minutes <= 0 || !slotExceedsClose(a.BookedAt, t.Minutes, closeHour),
        );
        if (validTimeOpts.length === 0) return null;
        if (validTimeOpts.length === timeOpts.length) return a;
        return {
          ...a,
          WebOffer: {
            ...a.WebOffer,
            Options: { ...a.WebOffer.Options, Time: validTimeOpts },
          },
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    // ── Accurate mode: duration-window filter ───────────────────────
    // Strip Time options whose full duration window is provably blocked
    // (offer absent at a probed instant inside [start, start+minutes)), and
    // drop slots whose explicit durationMinutes doesn't fit. Duration per
    // option comes from OUR config (resolveOptionMinutes) — QAMF's Minutes
    // field is never read for logic. Options we can't resolve are kept
    // (fail-open); the hold-time guard is the final arbiter.
    if (accurate) {
      availabilities = availabilities
        .map((a) => {
          const cfgs = offerConfigs.get(a.WebOffer.Id) ?? [];
          const startMin = etMinutesOfDay(a.BookedAt);
          // QAMF stops listing an offer past its last bookable start
          // (close − shortest configured option) even with every lane empty —
          // window checks must not read those absences as occupancy.
          const minCfg = minConfiguredMinutes(cfgs);
          const lastStartMin = minCfg != null ? closeHour * 60 - minCfg : null;
          if (durationMinOver) {
            return evaluateWindow(probeMap, a.WebOffer.Id, startMin, durationMinOver, lastStartMin)
              ? a
              : null;
          }
          const timeOpts = (
            a.WebOffer?.Options as { Time?: Array<{ Id: string | number; Minutes?: number }> }
          )?.Time;
          if (!timeOpts?.length) return a; // Game/Unlimited — no duration semantics
          const fitting = timeOpts.filter((t) => {
            const minutes = resolveOptionMinutes(cfgs, Number(t.Id));
            return (
              minutes == null ||
              evaluateWindow(probeMap, a.WebOffer.Id, startMin, minutes, lastStartMin)
            );
          });
          if (fitting.length === 0) return null;
          if (fitting.length === timeOpts.length) return a;
          return {
            ...a,
            WebOffer: { ...a.WebOffer, Options: { ...a.WebOffer.Options, Time: fitting } },
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null);
    }

    console.log(
      `[avail] centerId=${centerId} date=${startDate} hour=${hourStr} min=${minuteStr} probes=${probeTimes.length}+${extraProbeTimes.length} errors=${probeErrors} accurate=${accurate} raw=${displayOutcomes.reduce((n, o) => n + o.data.Availabilities.length, 0)} filtered=${availabilities.length}`,
    );
    if (availabilities.length > 0) {
      console.log(
        `[avail] first=${availabilities[0].BookedAt} last=${availabilities[availabilities.length - 1].BookedAt}`,
      );
    }

    return NextResponse.json({
      Availabilities: availabilities,
      meta: {
        optionAccuracy: accurate ? "windowed" : "optimistic",
        probeCount: allSlots.length,
        probeErrors,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[avail] fatal error: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
