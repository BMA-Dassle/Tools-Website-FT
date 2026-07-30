import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { displayNameFromFull, makeDisplayName } from "@/lib/display-name";
import { getReservationDetail } from "~/features/daily-events/service";
import { listJoinsForProject } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import {
  CENTER_TO_BMI_LOCATION_IDS,
  BMI_LOCATION_TO_PANDORA_KEY,
  isValidCenter,
} from "~/features/kiosk/waiver/locations";
import { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";
import {
  waiverValidNow,
  mapWithConcurrency,
  WAIVER_CHECK_CONCURRENCY,
} from "~/features/kiosk/waiver/valid-count";
import { buildWaiverRoster, type WaiverRosterEntry } from "~/features/waiver/roster";
import { WAIVER_LINK_COOKIE, waiverLinkGrantsOrganizerFor } from "@/lib/waiver-short-link";

export const dynamic = "force-dynamic";

/**
 * GET /api/waiver/context?c=<center>&loc=<locationId>&pid=<projectId>
 *
 * The lean, PII-safe summary that lets the reservation-scoped /waiver page show
 * an event-info header WITHOUT exposing the confirmation. This is what makes the
 * link safe to forward to a whole party: it returns only the reservation NAME
 * (online names reduced to "First L."), activity, when, center and guest count —
 * NEVER pricing, deposit, payments, balance, or any guest's full name, email,
 * phone or birthdate (the heavy getReservationDetail carries all of that; we
 * deliberately drop it here).
 *
 * ONLINE bookings (racing / laser / gel) ALSO get `roster` — one row per person on
 * the booking, redacted to "First L." plus whether they are already covered — so
 * the page can preload the party instead of saying "3 of 8 registered" above an
 * empty list and asking the guest to retype all eight (owner 2026-07-30).
 * GROUP FUNCTIONS deliberately get NO roster: a contract party comes back through
 * the contract confirmation page, so their names never need to ride a link that
 * anyone can forward.
 *
 * So the roster IS other guests — redacted, never anonymous. The bound is a given
 * name plus at most ONE initial, enforced twice: `makeDisplayName` maps BMI's raw
 * profile fields, and `buildWaiverRoster` re-reduces every row on the way out so a
 * pre-fix Neon join row cannot smuggle a full name through either. The ShareBlock
 * copy on the page says exactly this — keep the two in step.
 *
 * Two 2026-07-30 leaks are behind that "twice", and the second is a warning about
 * how to think about this rule: (I) the helper returned the first-name FIELD
 * verbatim when the surname was empty, which is how "Mary Jane Watson-Parker" got
 * onto a forwardable link; (II) the fix for I re-split whichever field was
 * populated, so a whole name parked in the SURNAME field started printing as
 * "Watson P." where the original had printed only an initial. Only the GIVEN-name
 * field may ever contribute a printed word — a surname field's token count is not
 * a licence to print one of its tokens. See lib/display-name.ts THE CONTRACT.
 *
 * Cached 120s per (loc, pid): getReservationDetail is several BMI calls, and the
 * summary is effectively static for an event, so a forwarded link that many
 * people open costs ~0 BMI load.
 */

const DIGIT_ID = /^\d+$/;
const CACHE_TTL_SECONDS = 120;
const COUNT_CACHE_TTL_SECONDS = 60;
/**
 * The signed count costs one Pandora read per REGISTERED person (concurrency 5),
 * and real group events are big — the 2026-12-18 Fireservice event has 100. That
 * is ~20 sequential rounds inside the request that draws the event header, so it
 * gets a hard deadline: the header (name + when) must never wait on a count.
 *
 * Missing the deadline is not a failure. The per-person results are cached as they
 * land, so the sweep keeps warming and a later load shows the number. The count is
 * cached separately from the summary for exactly this reason — a slow count must
 * not poison the summary's cache entry with a permanently absent `signed`.
 *
 * The roster rides the SAME deadline and the same cache entry, because it is the
 * same Pandora sweep. So `roster` present ⇒ every row's `waiverValid` is real; on
 * a miss the roster is omitted rather than shipped with every row guessed `false`,
 * which would tell already-signed guests to sign again.
 */
const COUNT_DEADLINE_MS = 2_500;

/** Resolve to undefined rather than hang past `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/** The cached Pandora-sweep result: the count and the roster are ONE value, so a
 *  cache hit can never serve a fraction that contradicts the list. */
interface SignedState {
  signed: number;
  /** ONLINE bookings only — never written for a group function, which is what
   *  keeps a summary-cache hit from inventing a roster for a contract event. */
  roster?: WaiverRosterEntry[];
}

/**
 * Tolerant read of the cached sweep. A missing, corrupt or half-written value is
 * "not counted yet" (recompute), never "zero signed".
 *
 * This JSON.parse is safe for BMI ids: we always WRITE personId as a JSON string,
 * and every field is re-coerced with String() below — so a 17-digit id survives
 * the cache round-trip byte-for-byte. Nothing here ever sees an unquoted BMI id.
 */
function parseSignedState(raw: unknown): SignedState | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { signed?: unknown; roster?: unknown };
    if (typeof parsed.signed !== "number" || !Number.isFinite(parsed.signed)) return undefined;
    if (!Array.isArray(parsed.roster)) return { signed: parsed.signed };
    const roster = (parsed.roster as Array<Record<string, unknown>>).map((r) => ({
      personId: String(r.personId ?? ""),
      displayName: String(r.displayName ?? ""),
      waiverValid: r.waiverValid === true,
    }));
    return { signed: parsed.signed, roster };
  } catch {
    return undefined;
  }
}

const LOCATION_NAMES: Record<number, string> = {
  467486: "FastTrax Fort Myers",
  332160: "HeadPinz Fort Myers",
  332145: "HeadPinz Naples",
};

/** Naive ET stamp "YYYY-MM-DDTHH:mm:ss" → "Sat, Aug 2 · 2:00 PM". */
function formatWhen(when?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(when ?? "");
  if (!m) return "";
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const h = Number(hh);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateLabel} · ${h12}:${mm} ${ampm}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const center = sp.get("c") ?? "";
  const locationId = Number(sp.get("loc") ?? "");
  const projectId = sp.get("pid") ?? "";
  if (
    !isValidCenter(center) ||
    !CENTER_TO_BMI_LOCATION_IDS[center].includes(locationId) ||
    !DIGIT_ID.test(projectId)
  ) {
    return NextResponse.json({ ok: false, error: "Invalid query" }, { status: 400 });
  }

  /**
   * THE organizer gate. Until this existed the roster shipped to anyone holding any
   * waiver link, which is why it had to be name-redacted; now it ships only to the
   * person we sent the ORGANIZER code to, so it can carry real names (owner
   * 2026-07-30: "full names are fine on all now that we do specific links").
   *
   * Read from the HttpOnly `wv_cap` cookie that `/w/{code}` set — never a query
   * param — and resolved through `waiverLinkGrantsOrganizerFor`, which goes to the
   * stored row and binds the code to THIS projectId. So a register code grants
   * nothing, and an organizer cookie left behind by a different reservation (or by
   * another guest on a shared in-center device) grants nothing either.
   *
   * Never throws and fails CLOSED: any unreadable row, outage or unknown code is
   * simply "no roster", never an error page over a working waiver flow.
   */
  const canManage = await waiverLinkGrantsOrganizerFor(
    req.cookies.get(WAIVER_LINK_COOKIE)?.value,
    projectId,
  );

  /**
   * The response now VARIES BY COOKIE, so it must never be shared. `force-dynamic`
   * stops Next caching it, but nothing here previously told a CDN or a browser that
   * — and one cached organizer response replayed to a register-code holder would
   * hand out the whole party list.
   */
  const privateHeaders = {
    "content-type": "application/json",
    "cache-control": "private, no-store",
    vary: "cookie",
  } as const;

  const cacheKey = `waiver:ctx:${locationId}:${projectId}`;
  // v2 because this entry used to hold a bare signed count and now holds
  // { signed, roster? } — a new key name instead of dual-format parsing, so a
  // rolling deploy can never misread the old shape (cost: one cold sweep).
  const stateKey = `waiver:ctx:state:v2:${locationId}:${projectId}`;
  const [cached, cachedState] = await Promise.all([
    redis.get(cacheKey).catch(() => null),
    redis.get(stateKey).catch(() => null),
  ]);
  const state = parseSignedState(cachedState);

  if (typeof cached === "string" && cached) {
    // Summary is cached; merge in whatever the sweep cache knows right now. A
    // fresh count/roster can appear on a later load without re-fetching the summary.
    const summary = JSON.parse(cached) as Record<string, unknown>;
    summary.canManage = canManage;
    if (state) {
      summary.signed = state.signed;
      // Only ONLINE bookings ever put a roster in this entry, so merging what the
      // cache holds cannot leak a group function's party. The ORGANIZER gate is
      // applied here too, and deliberately at RESPONSE time rather than cache time:
      // the cached entry stays capability-free (one entry per reservation, not one
      // per capability), and withholding is a property of the read.
      if (state.roster && canManage) summary.roster = state.roster;
    }
    return new NextResponse(JSON.stringify(summary), {
      status: 200,
      headers: { ...privateHeaders, "x-waiver-cache": "hit" },
    });
  }

  try {
    const [detail, joins] = await Promise.all([
      getReservationDetail(locationId, projectId),
      listJoinsForProject(projectId).catch(() => []),
    ]);

    // Online reservations stuff the guest's FULL name into detail.name — reduce
    // to "First L." (group functions use a real event name, kept as-is).
    const isOnline = (detail.kind || "").toLowerCase().includes("online");
    const rawName = (detail.name || "").trim();
    const label = isOnline
      ? !rawName || rawName.toLowerCase() === "online"
        ? "Your reservation"
        : displayNameFromFull(rawName)
      : rawName || "Your reservation";

    const activities = Array.from(
      new Set(
        (detail.schedules || [])
          .map((s) => ((s as { resourceName?: string }).resourceName || "").trim())
          .filter(Boolean),
      ),
    );

    // "N of M registered" for the event card, and — for an ONLINE booking only —
    // the roster behind that fraction. Same union the kiosk roster uses (Pandora
    // waiverExpiry ∪ our Neon joins) and the same redacted "First L." shape.
    // For a GROUP FUNCTION the names are still dropped on the floor: that link is
    // forwardable and a contract party has its own confirmation page.
    const registered = (detail.persons_list || [])
      .map((p) => ({
        personId: String(p.personId ?? p.id ?? ""),
        displayName: makeDisplayName(p.firstName || "", p.name || ""),
      }))
      .filter((p) => p.personId && p.displayName);
    const pandoraLocationId =
      PANDORA_LOCATION_MAP[BMI_LOCATION_TO_PANDORA_KEY[locationId] ?? ""] ||
      PANDORA_DEFAULT_LOCATION_ID;
    /**
     * FALSE-COMPLETION GUARD. `total` and the roster come from two different BMI
     * fields — `detail.persons` (the headcount) and `detail.persons_list` (the
     * people) — and they disagree. When `persons` was 0 or absent while
     * `persons_list` had names, the clamp below (`total || swept.validCount`) fell
     * back to the signed count, so a party where NOBODY had signed could render as
     * complete: "0 of 0", i.e. all done, over a list of unsigned guests.
     *
     * Taking the MAX makes the denominator at least the number of people we can
     * actually see, so the fraction can never claim more progress than exists.
     */
    const total = Math.max(detail.persons ?? 0, registered.length);

    // The summary is what the header needs; it is cached on its own so a slow
    // count can never keep the event name and date off the screen.
    const summary = {
      ok: true,
      label,
      activity: activities.join(" · ") || null,
      whenLabel: formatWhen(detail.when),
      centerName: LOCATION_NAMES[locationId] ?? "",
      total,
    };
    redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(summary)).catch(() => {});

    let signed = state?.signed;
    let roster = state?.roster;
    if (state === undefined) {
      const swept = await withDeadline(
        mapWithConcurrency(registered, WAIVER_CHECK_CONCURRENCY, (p) =>
          waiverValidNow(p.personId, pandoraLocationId),
        ).then((flags) => buildWaiverRoster(registered, flags, joins)),
        COUNT_DEADLINE_MS,
      );
      if (swept !== undefined) {
        // Never claim more signed than registered — the join union can exceed the
        // BMI headcount when someone signs who was never added to the reservation.
        // (The roster keeps that extra person; only the fraction is clamped.)
        //
        // `total` can no longer be 0 while people exist (see the guard above), so
        // the `|| swept.validCount` fallback now only fires when there is genuinely
        // nobody — where clamping to validCount is a no-op rather than a claim of
        // completion.
        signed = Math.min(swept.validCount, total || swept.validCount);
        // The whole discriminator: online booking → send the party; contract event
        // → don't. `roster` is built either way so the count is one code path.
        roster = isOnline ? swept.roster : undefined;
        const next: SignedState = roster ? { signed, roster } : { signed };
        redis.setex(stateKey, COUNT_CACHE_TTL_SECONDS, JSON.stringify(next)).catch(() => {});
      }
    }

    // `signed` (and with it `roster`) is OMITTED when the sweep didn't land in
    // time — the card then shows "100 registered" with no fraction, rather than a
    // confident, wrong "0 of 100" over a list of people wrongly marked unsigned.
    return new NextResponse(
      JSON.stringify({
        ...summary,
        canManage,
        ...(signed === undefined ? {} : { signed }),
        // Organizer gate — the roster is BUILT either way (the count needs it) and
        // withheld here, so one sweep serves both capabilities.
        ...(roster === undefined || !canManage ? {} : { roster }),
      }),
      {
        status: 200,
        headers: { ...privateHeaders, "x-waiver-cache": "miss" },
      },
    );
  } catch (err) {
    console.error("[waiver-context] error:", err);
    return NextResponse.json({ ok: false, error: "Failed to load reservation" }, { status: 502 });
  }
}
