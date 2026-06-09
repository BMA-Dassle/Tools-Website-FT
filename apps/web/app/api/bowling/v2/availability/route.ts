import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";
import { getBowlingExperiences, type BowlingExperienceKind } from "@/lib/bowling-db";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";

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
};

// QAMF center ID → HP_LOCATIONS slug (for closing-time lookup)
const QAMF_TO_HP_SLUG: Record<number, string> = {
  9172: "fort-myers",
  3148: "naples",
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
): string[] {
  const times: string[] = [];
  const [y, mo, d] = date.split("-").map(Number);
  const nextDate = new Date(y, mo - 1, d + 1);
  const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;

  // Probe from open to close at the requested granularity. QAMF is point-in-time
  // (one probe per slot), so a finer step = more probes = slower. Callers that
  // need the WHOLE day (the bowling time picker) pass a coarser step (e.g. 60)
  // to stay under the function timeout; KBF reschedule keeps the 15-min default.
  const step = Math.max(15, stepMinutes);
  for (let t = openHour * 60; t <= closeHour * 60; t += step) {
    const h = Math.floor(t / 60);
    const m = t % 60;
    const calHour = h % 24;
    const calDate = h >= 24 ? nextDateStr : date;
    times.push(
      `${calDate}T${String(calHour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tzOffset}`,
    );
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

  // Both centers are in Southwest Florida (Eastern time).
  const month = parseInt(startDate.slice(5, 7), 10);
  const tzOffset = month >= 3 && month <= 11 ? "-04:00" : "-05:00";

  // ── Build probe times ────────────────────────────────────────────
  const hasSelectedTime = hourStr !== null && minuteStr !== null;
  const { open: openHour, close: closeHour } = centerHoursForDate(centerId, startDate);
  let probeTimes: string[];

  if (hasSelectedTime) {
    // Targeted mode: probe ±5 hours around the selected time so the tier
    // step can show "Next available at …" when the exact time is sold out.
    // Never probe before the current time if startDate is today.
    const hour = parseInt(hourStr!, 10);
    const minute = parseInt(minuteStr!, 10);

    // Determine earliest allowed probe (in total minutes from midnight).
    // For today: current ET time + 15 min lead. For future dates: open hour.
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let earliestMin = openHour * 60;
    if (startDate === todayET) {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
        timeZone: "America/New_York",
      }).formatToParts(new Date());
      const nowH = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const nowM = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      let nowTotalMin = nowH * 60 + nowM;
      // Post-midnight (0–2 AM) → convert to 24+ notation so late-night
      // Fri/Sat slots (hour 24–26) are correctly gated. BUT only apply
      // this when the center actually HAS post-midnight hours (closeHour > 24,
      // i.e. Fri/Sat). On other days, pre-opening browsing (e.g. 3 AM on
      // Monday) should just use openHour as the floor — the +24*60 shift
      // would push earliestMin past closeHour, generating zero probes.
      if (nowH < 6 && closeHour > 24) {
        nowTotalMin += 24 * 60;
      }
      // Only apply the "don't probe past times" filter when we're within
      // operating hours. Before opening, openHour already floors the window.
      if (nowTotalMin >= openHour * 60) {
        earliestMin = Math.max(earliestMin, nowTotalMin + 15);
      }
    }
    // Snap earliestMin UP to next multiple of 15 so QAMF gets clean
    // quarter-hour probe times (QAMF rejects minutes not divisible by 5).
    earliestMin = Math.ceil(earliestMin / 15) * 15;

    const windowStart = Math.max(hour * 60 + minute - 300, earliestMin); // -5h, clamped
    const windowEnd = Math.min(hour * 60 + minute + 300, closeHour * 60); // +5h, clamped

    probeTimes = [];
    for (let t = windowStart; t <= windowEnd; t += 15) {
      const probeH = Math.floor(t / 60);
      const probeM = t % 60;
      probeTimes.push(buildProbeTime(startDate, probeH, probeM, tzOffset));
    }
  } else {
    // Full-day mode: probe open→close at the requested granularity (stepMinutes).
    probeTimes = buildFullDayProbeTimes(startDate, tzOffset, openHour, closeHour, stepMinutes);
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
    let probeErrors = 0;
    type ProbeResult = {
      Availabilities: Array<{
        TotalPlayers: number;
        BookedAt: string;
        WebOffer: { Id: string | number; Options: Record<string, unknown>; Services: string[] };
      }>;
    };
    const results: ProbeResult[] = [];
    async function probeOne(bookedAt: string): Promise<ProbeResult> {
      const call = () =>
        searchAvailability(centerId, {
          BookedAtRange: { StartAt: bookedAt, EndAt: bookedAt },
          TotalPlayers: players,
          WebOffer: { Services: ["BookForLater"] },
        });
      try {
        return await call();
      } catch (err1) {
        try {
          return await call();
        } catch (err2) {
          probeErrors++;
          if (probeErrors <= 3) {
            console.warn(
              `[avail] probe error at ${bookedAt} (after retry): ${err2 instanceof Error ? err2.message : String(err2)}`,
            );
          }
          return { Availabilities: [] };
        }
      }
    }
    for (let i = 0; i < probeTimes.length; i += 8) {
      const batch = probeTimes.slice(i, i + 8);
      const batchResults = await Promise.all(batch.map(probeOne));
      results.push(...batchResults);
    }

    // When *every* probe failed even after retry, we have no signal —
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

    // Flatten, deduplicate by (BookedAt + WebOffer.Id), filter to valid offers.
    // QAMF's spec types WebOffer.Id as string | number and we've seen it flip
    // per-center; normalize to number here so the client can use strict ===
    // against DB-sourced numeric offer IDs without silent type-mismatch.
    const seen = new Set<string>();
    let availabilities = results
      .flatMap((r) => r.Availabilities)
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

    console.log(
      `[avail] centerId=${centerId} date=${startDate} hour=${hourStr} min=${minuteStr} probes=${probeTimes.length} errors=${probeErrors} raw=${results.reduce((n, r) => n + r.Availabilities.length, 0)} filtered=${availabilities.length}`,
    );
    if (availabilities.length > 0) {
      console.log(
        `[avail] first=${availabilities[0].BookedAt} last=${availabilities[availabilities.length - 1].BookedAt}`,
      );
    }

    return NextResponse.json({ Availabilities: availabilities });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[avail] fatal error: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
