import "server-only";

/**
 * Composes everything a TV needs into ONE payload.
 *
 * ONE endpoint, one poll, one place to cache and to fail open. Splitting this
 * per-scene would multiply the request count by the number of screens times the
 * number of scenes, for data that all comes from the same three sources.
 *
 * FAIL OPEN, ALWAYS. Every section is independently optional and every upstream
 * is wrapped. A TV must never render an error: the worst case is that sections
 * come back null, their playlist entries self-skip, and the screen falls back to
 * house ads — which need no server data at all. There is no code path here that
 * can put a stack trace on a lobby wall.
 *
 * PII posture: first names only, and no ids of any kind in the response. See
 * the note on SignageEvent.
 */
import redis from "@/lib/redis";
import { pausedProductIds } from "~/features/maintenance";
import { businessDayYmdET } from "@/lib/race-business-day";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import { displayNameFromFull } from "@/lib/display-name";
import { loadSignageScreen } from "../data/signage-screens-db";
import { parseScreenKey, VENUE_INFO, type SignageVenue } from "../constants";
import {
  signageEventsKey,
  readSignageEvents,
  reloadRequestedAt,
  demoRequestedFor,
} from "../events.server";
import { resolveScreenConfig, screenShowsScene } from "../defaults";
import { trackFromResourceIds } from "../track";
import { raceCheckinInfo } from "./race-checkin";
import { megaModeActive } from "./mega-mode.server";
import { dedupeGuideRows } from "../race-guide";
import { checkinProgress } from "./checkin-progress";
import { afterResponse } from "../after-response.server";
import { nudgeStaySeated } from "../pit/audio.server";
import { buildPitBoard } from "../pit/service";
import { readPitLanes } from "../pit/lane.server";
import { readFastPitRosters } from "../pit/fast-roster.server";
import { buildWelcomeBoard } from "./welcome";
import { resolveResultsBoard } from "./results-board.server";
import { resolveTopTimes } from "./top-times.server";
import {
  briefingEnabled,
  cameraReturnBarEnabled,
  raceGuideEnabled,
  resultsBoardEnabled,
} from "../flags";
import { loadSignageAssetsSafe } from "../data/signage-assets-db";
import { readBriefingRooms, sessionBriefed } from "../briefing/state.server";
import { resolveWelcomeBack } from "../briefing/welcome-back.server";
import { resolveCameraReturn } from "../briefing/camera-return.server";
import { resolveRoomBlocked } from "../briefing/room-blocked.server";
import type { TvFeed, TvPulse } from "../types";

/** Screens phone home on every poll; the admin page reads these for its
 *  online dots. Never a Neon write per poll — a wall of TVs at 10s each would
 *  be a pointless write storm. */
const SEEN_TTL_SECONDS = 900;

async function stampSeen(
  screenId: string,
  buildSha?: string | null,
  windowed?: boolean,
): Promise<void> {
  try {
    // Record WHICH BUILD the screen is running, not just that it is alive.
    //
    // Every confusing hour tonight came down to "is that board on current
    // code?", and there was no way to answer it without walking to the player.
    // A heartbeat that says "alive" and nothing else is what let a stale board
    // look like a broken feature more than once.
    // `windowed` only when TRUE. An absent key means "filling its panel", which
    // is 17 of 19 screens on an ordinary night — recording the healthy case on
    // every one of ~43,000 daily heartbeats would be pure noise, and it keeps
    // every stamp written before this shipped readable as the healthy default.
    const payload = JSON.stringify({
      at: new Date().toISOString(),
      build: buildSha ?? null,
      ...(windowed ? { windowed: true } : {}),
    });
    await redis.set(`signage:seen:${screenId}`, payload, "EX", SEEN_TTL_SECONDS);
  } catch {
    /* a heartbeat is diagnostics, never a reason to fail a feed */
  }
}

/**
 * Build the feed for one screen.
 *
 * An UNPROVISIONED screen id is not an error — it gets the ads-only shape with
 * `screen: null`, so a mistyped URL on a wall shows house advertising rather
 * than a setup prompt in front of guests. It also gets no guest data at all,
 * which is the security property: names only reach screens someone deliberately
 * registered.
 */
export async function buildTvFeed(
  screenIdRaw: string | null,
  buildSha?: string | null,
  /** The board reports it is not filling its monitor. Diagnostics only — it
   *  changes nothing about what is built, only what the heartbeat records. */
  windowed?: boolean,
): Promise<TvFeed> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);

  const base: TvFeed = {
    now,
    screen: null,
    events: null,
    vip: null,
    kioskEvents: [],
    raceCheckin: null,
    briefing: null,
    briefingRooms: null,
    // PULSE-ONLY, like the fast roster below — the gate behind it is resolved
    // on the 2-second beat, never on the 15s poll.
    roomBlocked: null,
    pitBoard: null,
    pitLanes: null,
    // PULSE-ONLY — the full feed never carries the fast roster; useTvFeed
    // merges the pulse's copy over this null.
    pitRosters: null,
    checkinProgress: null,
    checkinReturning: null,
    raceResults: null,
    topTimes: null,
    raceGuide: null,
    bowlingTonight: null,
    bowlingCheckins: null,
    pausedProductIds: safePaused(),
    nextAvailable: null,
    reloadAt: null,
    demoMode: null,
    degraded: false,
  };

  if (!parsed || !screenIdRaw) return base;

  const screen = await loadSignageScreen(screenIdRaw).catch(() => null);
  if (!screen) return base;

  void stampSeen(screen.screenId, buildSha, windowed);

  const center = VENUE_INFO[parsed.venue]?.center ?? screen.center;

  // Read fresh on every poll, deliberately OUTSIDE any cache: a celebration is
  // about someone standing at a kiosk right now, and it must not wait out a
  // cache TTL. One LRANGE is cheap enough to do per screen per poll.
  const kioskEvents = await readSignageEvents(center).catch(() => []);
  const reloadAt = await reloadRequestedAt(center).catch(() => null);
  const demoMode = await demoRequestedFor(screen.screenId).catch(() => null);

  // Track screens only: who is on the heat checking in right now. Everything
  // else the scene needs it fetches itself from the endpoints the website uses.
  const config = resolveScreenConfig(screen.config, parsed.venue);
  const ymd = businessDayYmdET();
  const track = trackFromResourceIds(config.scope.resourceIds);

  // Only build what this screen actually shows. A track screen has no use for
  // the party board, and a lobby TV has no track — computing both for every
  // screen would double the work for nothing.
  //
  // THE PLAYLIST IS NOT THE WHOLE ANSWER for a wall. TV5 of the front-desk five runs
  // the events board as its WING (`wall.outsideScene`), and the five share one
  // byte-identical playlist that names no wing scene at all — so asking the playlist
  // alone left that panel asking for parties it was never sent, and falling to house
  // ads every night of the year. `screenShowsScene` covers both routes.
  const wantsWelcome = screenShowsScene(config, "event-welcome");
  const wantsBriefing =
    briefingEnabled() &&
    config.briefingRoom !== null &&
    config.playlist.some((p) => p.scene === "briefing");
  // A track-tied camera monitor carries the desk's check-in progress along the
  // bottom of its clock. Gated on the camera's own track rather than on the
  // playlist alone: a lobby camera has no clock pane to hang it under, and the
  // heats it would list are in another building. FT-only — the tracks are.
  const wantsCheckinProgress = parsed.venue === "FT" && config.cameraMonitor?.track != null;
  // WHICH ROOM THIS CAMERA IS WATCHING. A camera monitor is scoped by camera,
  // not by `briefingRoom` (that field belongs to the room's own TV), so the
  // returning group has to be resolved off the camera's own track. Mega has no
  // single room, so a Mega camera carries no returning panel.
  const cameraRoom =
    config.cameraMonitor?.track === "blue" || config.cameraMonitor?.track === "red"
      ? config.cameraMonitor.track
      : null;
  const wantsCameraReturning = briefingEnabled() && parsed.venue === "FT" && cameraRoom !== null;
  // The pit board: its track's staged roster and the lane state.
  const wantsPit = track != null && config.playlist.some((p) => p.scene === "pit-board");
  // The menu board is the only surface that needs the bowling catalog, and it only
  // exists at the bowling venues — FastTrax has no lanes, so a FastTrax screen
  // asking would be one Neon round trip per poll for a section it cannot use.
  const wantsBowling = parsed.venue !== "FT" && config.playlist.some((p) => p.scene === "open-now");
  // The other WING scene, named the same way — see the note on `wantsWelcome`.
  const wantsCheckins = parsed.venue !== "FT" && screenShowsScene(config, "bowling-checkin");
  // The scores wall: the last race on ITS OWN configured track. Not `track`
  // above — that one comes from `scope.resourceIds`, which a results board
  // deliberately does not set (see ScreenConfig.resultsBoard).
  // THE GUIDE WALL IS ONE SCREEN FOR BOTH TRACKS, so it cannot use `track`
  // above (that comes from scope and names exactly one). It asks for each of
  // its configured tracks by name instead.
  const guideTracks =
    raceGuideEnabled() && config.raceGuide && config.playlist.some((p) => p.scene === "race-guide")
      ? config.raceGuide.tracks
      : [];
  const configuredResultsTrack = config.resultsBoard?.track ?? null;
  const wantsResults =
    resultsBoardEnabled() &&
    configuredResultsTrack !== null &&
    config.playlist.some((p) => p.scene === "race-results");
  // THE LAST-RACE BOARD RESOLVES MEGA ITSELF, from the data, so its configured
  // track is passed through untouched. It considers its own track AND Mega and
  // shows whichever race ended most recently — see rankFinished. That is
  // strictly better than force-swapping the track here, which blanked the wall
  // whenever the flag ran ahead of the business day (observed 2026-08-18 00:30:
  // flag true on a Tuesday, but the 8/17 business day was split-track, so a
  // Mega-swapped board found nothing while Heat 60 Blue sat unshown).
  //
  // TOP-TIMES STILL USES THE FLAG, deliberately: a hall of fame is not about
  // one race, so "which race ended last" cannot answer it. "Which circuit is
  // the venue running" is the right question there, and megaModeActive() is
  // exactly that.
  const resultsTrack = configuredResultsTrack;
  const topTimesTrack =
    wantsResults && configuredResultsTrack !== "mega" && (await megaModeActive().catch(() => false))
      ? ("mega" as const)
      : configuredResultsTrack;
  // THE TWO ROLES ARE MUTUALLY EXCLUSIVE, so only one of the two resolvers ever
  // runs for a given screen. `top-times` is the hall-of-fame face of the same
  // scene — see ScreenConfig.resultsBoard.role — and it follows the Mega swap
  // above for the same reason the last-race board does: on a Mega day nobody
  // has raced this screen's own track since morning.
  const wantsTopTimes = wantsResults && config.resultsBoard?.role === "top-times";

  const [
    raceCheckin,
    events,
    nextAvailable,
    briefing,
    checkinRail,
    pitBoard,
    pitLanes,
    cameraReturning,
    raceResults,
    topTimes,
    guideSection,
    bowlingTonight,
    bowlingCheckins,
  ] = await Promise.all([
    track ? raceCheckinInfo(track, ymd).catch(() => null) : Promise.resolve(null),
    wantsWelcome
      ? buildWelcomeBoard(
          parsed.venue,
          config.scope.gfCenterCodes,
          ymd,
          { leadMins: config.welcomeLeadMins, trailMins: config.welcomeTrailMins },
          now,
        ).catch(() => null)
      : Promise.resolve(null),
    config.showNextAvailable
      ? buildNextAvailable(parsed.venue).catch(() => null)
      : Promise.resolve(null),
    wantsBriefing
      ? buildBriefingSection(parsed.venue, config.briefingRoom as "red" | "blue", ymd).catch(
          () => null,
        )
      : Promise.resolve(null),
    wantsCheckinProgress ? checkinProgress(now).catch(() => null) : Promise.resolve(null),
    wantsPit && track ? buildPitBoard(track, ymd, now).catch(() => null) : Promise.resolve(null),
    wantsPit ? readPitLanes().catch(() => null) : Promise.resolve(null),
    // The SAME resolver the room's own wall uses, so the two screens cannot
    // disagree about one return. Fails to null like every other section.
    wantsCameraReturning && cameraRoom
      ? resolveWelcomeBack(parsed.venue, cameraRoom, ymd).catch(() => null)
      : Promise.resolve(null),
    // Cached per venue+track inside the resolver, so two scores walls on the
    // same track cost one build — and cannot show two different answers.
    wantsResults && resultsTrack && !wantsTopTimes
      ? resolveResultsBoard(parsed.venue, resultsTrack, ymd).catch(() => null)
      : Promise.resolve(null),
    // Same deal, and cached harder: a hall of fame only moves when somebody
    // beats a time. See CACHE_TTL_SECONDS in top-times.server.
    wantsTopTimes && topTimesTrack
      ? resolveTopTimes(
          parsed.venue,
          topTimesTrack,
          config.resultsBoard?.ranges ?? ["month"],
        ).catch(() => null)
      : Promise.resolve(null),
    guideTracks.length > 0
      ? buildGuideSection(guideTracks, ymd).catch(() => null)
      : Promise.resolve(null),
    wantsBowling ? buildBowlingTonight(parsed.venue, now).catch(() => null) : Promise.resolve(null),
    wantsCheckins ? buildBowlingCheckins(parsed.venue).catch(() => null) : Promise.resolve(null),
  ]);

  // Has the heat on the track board already been sent to a briefing room? One
  // Redis GET, and only for screens that actually show a track board.
  const briefed = raceCheckin
    ? await sessionBriefed(
        raceCheckin.sessionId != null ? String(raceCheckin.sessionId) : null,
      ).catch(() => null)
    : null;
  const raceCheckinWithBriefing = raceCheckin
    ? { ...raceCheckin, briefedAtMs: briefed?.atMs ?? null, briefedRoom: briefed?.room ?? null }
    : null;

  return {
    ...base,
    screen,
    kioskEvents,
    reloadAt,
    demoMode,
    raceCheckin: raceCheckinWithBriefing,
    events,
    nextAvailable,
    briefing: briefing?.section ?? null,
    briefingRooms: briefing?.rooms ?? null,
    roomBlocked: null,
    pitBoard,
    pitLanes,
    checkinProgress: checkinRail,
    // Only when somebody is actually racing again — a returning group with
    // nobody due back out is not a thing staff need to act on.
    checkinReturning:
      cameraReturning && cameraReturning.racingAgain.length > 0
        ? { fromSession: cameraReturning.heatNumber, groups: cameraReturning.racingAgain }
        : null,
    raceResults,
    topTimes,
    raceGuide: guideSection,
    bowlingTonight,
    bowlingCheckins,
    // `vip` (the bowling-leg takeover) lands with the next scene.
    vip: null,
    // Null events mean we could not ask — the welcome entry then self-skips
    // and the rotation closes over it rather than showing an empty board.
    degraded: wantsWelcome && events === null,
  };
}

/**
 * WHO SELF-CHECKED IN AND WHICH LANE.
 *
 * First names only, and that is not a nicety: this list is printed a foot tall in a
 * public lobby, so it follows the same PII posture as every other board on the estate
 * (see the note on SignageEvent). A surname is dropped even when we hold one.
 *
 * The reader already filters to self check-ins that have a lane; this only reduces a
 * reservation to the three things the glass needs.
 */
async function buildBowlingCheckins(venue: SignageVenue): Promise<TvFeed["bowlingCheckins"]> {
  const { getSelfCheckedInWithLanes, getSelfCheckinEligible } = await import("@/lib/bowling-db");
  const { laneReadyKey, parseLaneReadySet } = await import("../lane-ready");
  const center = VENUE_INFO[venue].squareLocationId;

  // Three independent reads, in parallel. The readiness set comes from Redis — written by
  // the `bowling-lane-ready` cron once a minute — because deciding it needs two QAMF
  // calls, and a vendor read may never sit on a screen's render path.
  const [done, due, readyRaw] = await Promise.all([
    getSelfCheckedInWithLanes(center),
    getSelfCheckinEligible(center),
    redis.smembers(laneReadyKey(center)).catch(() => [] as string[]),
  ]);
  const ready = parseLaneReadySet(readyRaw);

  const checkedIn: NonNullable<TvFeed["bowlingCheckins"]>["checkedIn"] = [];
  for (const r of done) {
    const name = displayNameFromFull(r.guestName ?? "");
    if (!name) continue;
    const lanes = laneList(r.dayofOrderLane);
    if (!lanes) continue;
    checkedIn.push({ name, lanes, laneReady: !!r.laneReadySentAt });
  }

  // ONLY THE ONES WHOSE LANE IS AVAILABLE. A guest who is due but whose lane is not ready
  // cannot complete self check-in, so listing them would send them to a kiosk that turns
  // them away — and the board that sent them is the last thing they trust afterwards.
  //
  // An EMPTY readiness set therefore empties this column, which is deliberate: it means
  // either nobody is ready or the cron has not run, and both of those are "do not invite
  // anybody". The column has designed copy for it.
  const available: NonNullable<TvFeed["bowlingCheckins"]>["available"] = [];
  for (const r of due) {
    const entry = ready.get(r.id);
    if (!entry) continue;
    const name = displayNameFromFull(r.guestName ?? "");
    if (!name) continue;
    // Their booked time in ET wall-clock — the TIME RULE this file documents for the
    // availability cache: `new Date(naive)` parses as the SERVER's zone, which on Vercel
    // shifts an 8:00 PM slot to 4:00 PM.
    const timeLabel = fmtTime12(toEtWallClock(r.bookedAt)) ?? "";
    if (!timeLabel) continue;
    // The cron's lane numbers win: they are what QAMF said at readiness time, whereas
    // `dayof_order_lane` is only written once the lane actually opens.
    available.push({ name, timeLabel, lanes: entry.lanes || laneList(r.dayofOrderLane) });
  }

  // Null only when there is nothing to say on EITHER side. The scene has designed copy for
  // one-empty-one-full, so a half-populated board is content rather than a fault.
  if (checkedIn.length === 0 && available.length === 0) return null;
  return { available, checkedIn };
}

/** "12,13" or " 12 , 13 " -> "12, 13"; empty for nothing usable. QAMF and our own writer
 *  disagree about spacing, so neither is trusted. */
function laneList(raw: string | undefined): string {
  return (raw ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(", ");
}

/** Day of week (0=Sun) AT THE VENUE. A UTC-clocked server has already rolled over
 *  to tomorrow by 8pm ET, which would put Friday's bowling offers on a Thursday
 *  night wall. Same Intl + America/New_York posture as etHourNow. */
const ET_WEEKDAY: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function venueDayOfWeek(nowMs: number): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    }).format(new Date(nowMs));
    const dow = ET_WEEKDAY[name];
    if (dow !== undefined) return dow;
  } catch {
    /* fall through */
  }
  return new Date(nowMs).getDay();
}

/**
 * Does this offer include shoes?
 *
 * Read off the catalog's own `description`, which states it either way on every row
 * — "1.5 hours of unlimited bowling with shoes included" versus a flat "Shoes not
 * included." The NEGATIVE is tested first and wins, because "Shoes not included"
 * also contains the word "shoes" and a naive contains-check would invert every row
 * that says so (Midnight Madness, both hourly rates, both KBF tiers).
 *
 * Returns false when the description is silent: an unstated inclusion is not a
 * promise the wall may make on the desk's behalf.
 */
function offerIncludesShoes(description: string | null): boolean {
  if (!description) return false;
  const text = description.toLowerCase();
  if (/shoes?\s+(are\s+)?not\s+included/.test(text)) return false;
  return /\bshoes?\b/.test(text);
}

/** Cents to a wall price. Whole dollars drop the dead ".00". */
function bowlingPriceLabel(cents: number | undefined): string | null {
  if (typeof cents !== "number" || !(cents > 0)) return null;
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * TONIGHT'S BOWLING — the regular offer and the VIP one, priced.
 *
 * Bowling is the only attraction on this wall with no static price: lanes are
 * dynamic through QAMF and `ATTRACTIONS.bowling` carries `price: 0` deliberately.
 * The real numbers live in the experience catalog in Neon, which is a server read
 * — so this is what makes a priced bowling panel possible at all instead of the
 * wall inventing a lane price.
 *
 * THE SPECIAL IS THE `open` KIND, NOT THE LOWEST SORT ORDER. That was the first
 * version's mistake: `sort_order` puts the everyday hourly lane rate (20-23) ahead of
 * the packages (30+), so a Tuesday showed "Regular $45 per lane" and Fun 4 All never
 * appeared at all (owner 2026-08-18). `kind` is the field that separates them —
 * `hourly` is the baseline lane, `open` is the package — so the wall leads with the
 * package and carries the lane rate underneath it. Within each kind the lowest
 * `sort_order` still wins, so reordering the catalog moves the wall with it.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  - It does not pick by SLUG. Naming `fun-4-all` here would leave the wall quoting
 *    a row somebody had since retired; it asks for "tonight's package" instead.
 *  - It does not ignore `days_of_week`. Fun 4 All is Mon–Thu, Pizza Bowl is Sunday,
 *    Midnight Madness is Fri/Sat. A wall quoting Sunday's package on a Tuesday is
 *    quoting a price the kiosk will refuse.
 *  - It does not compute a lane count or a total. It reports the catalog's own
 *    per-unit price and says WHICH unit — hourly lanes are priced per lane (up to
 *    six bowlers) and open-play packages per person, and conflating those is how
 *    "$35" ends up wrong by a factor of six.
 *
 * `center_code` on the offers table is a SQUARE LOCATION ID, not a center slug, so
 * it is bridged through VENUE_INFO rather than re-derived here.
 */
async function buildBowlingTonight(
  venue: SignageVenue,
  nowMs: number,
): Promise<TvFeed["bowlingTonight"]> {
  const { getBowlingExperiences } = await import("@/lib/bowling-db");
  const { isPerLaneExperience } = await import("~/features/booking/service/bowling-offer");

  const all = await getBowlingExperiences(VENUE_INFO[venue].squareLocationId);
  if (all.length === 0) return null;

  const today = venueDayOfWeek(nowMs);
  const tonight = all
    // An empty list means "every day" (the legacy default the catalog documents).
    .filter((e) => e.daysOfWeek.length === 0 || e.daysOfWeek.includes(today))
    // Kids Bowl Free has its own wizard and its own product, and is not the
    // bowling a walk-up guest is being sold. It also came off this wall on
    // 2026-08-18.
    .filter((e) => !e.slug.startsWith("kbf-"))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const toOffer = (e: (typeof tonight)[number]) => {
    const primary = (e.items ?? []).find((i) => i.sortOrder === 0) ?? (e.items ?? [])[0];
    const mins = e.qamfOfferDurationMinutes;
    return {
      // The wall only ever shows TODAY's offer, so the day range in the catalog
      // label is noise on a screen read from thirty feet ("Regular Mon–Thur" is
      // just "Regular" once the wall has already filtered to tonight).
      label: e.label.replace(DAY_SUFFIX, "").trim() || e.label,
      priceLabel: bowlingPriceLabel(primary?.priceCents),
      unit: isPerLaneExperience(e) ? "per lane" : "per person",
      durationLabel: mins ? `${mins / 60} hours` : null,
      shoesIncluded: offerIncludesShoes(e.description),
    };
  };

  /** The regular + VIP pair of one kind, or null when that kind is not on tonight. */
  const pairOfKind = (kind: "open" | "hourly") => {
    const of = tonight.filter((e) => e.kind === kind);
    const regular = of.find((e) => !e.isVip);
    const vip = of.find((e) => e.isVip);
    if (!regular && !vip) return null;
    return { regular: regular ? toOffer(regular) : null, vip: vip ? toOffer(vip) : null };
  };

  const special = pairOfKind("open");
  const hourly = pairOfKind("hourly");
  if (!special && !hourly) return null;
  return { special, hourly };
}

/** A trailing day range on a catalog label — "Regular Mon–Thur", "VIP Fri–Sun". */
const DAY_SUFFIX = /\s+(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[\u2013\u2014-].*$/i;

/**
 * What a briefing room's TV needs from the slow feed: the films, the poster, and
 * the qualification board for the group that is out racing.
 *
 * The manifest is read on every full poll rather than cached, because the read is
 * one small Neon SELECT and the alternative — a cache between an upload and the
 * wall — is the exact reason a staff member would stand in a briefing room
 * wondering why the video they just uploaded is not playing.
 *
 */
async function buildBriefingSection(
  venue: SignageVenue,
  room: "red" | "blue",
  businessDay: string,
): Promise<{
  section: NonNullable<TvFeed["briefing"]>;
  rooms: TvFeed["briefingRooms"];
}> {
  const [assets, rooms, welcomeBack, cameraReturn] = await Promise.all([
    loadSignageAssetsSafe(),
    readBriefingRooms(venue).catch(() => ({ red: null, blue: null })),
    // The group's return — from the timing system's own actualEnd, read LIVE on
    // every poll (owner: end shows within 15s). Null while they are still out.
    resolveWelcomeBack(venue, room, businessDay).catch(() => null),
    // WHICH POV CAMERAS ARE STILL OUT — venue-wide and identical on both TVs
    // (owner 2026-08-12: a camera lost on Blue is the Red attendant's problem
    // too), so it is deliberately NOT scoped by `room` the way welcomeBack is.
    // Null ONLY when the switch is off — the resolver reports a failed read as
    // `stale` instead, so the strip never collapses and re-expands on the wall.
    cameraReturnBarEnabled()
      ? resolveCameraReturn(venue, Date.now()).catch(() => ({
          stillOut: [],
          incoming: [],
          outCount: 0,
          stale: true,
        }))
      : Promise.resolve(null),
  ]);

  const starter = assets["briefing-video:starter"];
  const intermediate = assets["briefing-video:intermediate"];
  const pro = assets["briefing-video:pro"];
  const poster = assets["briefing-helmet-poster"];

  return {
    section: {
      videos: {
        starter: starter ? { url: starter.url, durationMs: starter.durationMs } : null,
        intermediate: intermediate
          ? { url: intermediate.url, durationMs: intermediate.durationMs }
          : null,
        pro: pro ? { url: pro.url, durationMs: pro.durationMs } : null,
      },
      helmetPosterUrl: poster?.url ?? null,
      welcomeBack: welcomeBack
        ? {
            heatNumber: welcomeBack.heatNumber,
            raceType: welcomeBack.raceType,
            track: welcomeBack.track,
            endedAtMs: welcomeBack.endedAtMs,
            postPlayedAtMs: welcomeBack.postPlayedAtMs,
            arrivedAtMs: welcomeBack.arrivedAtMs,
            lingerAtMs: welcomeBack.lingerAtMs,
            motionHealthy: welcomeBack.motionHealthy,
            greetingByMotion: welcomeBack.greetingByMotion,
            audioUrl: assets["welcome-back-audio"]?.url ?? null,
            lingerAudioUrl: assets["welcome-back-linger-audio"]?.url ?? null,
            results: welcomeBack.results,
            racingAgain: welcomeBack.racingAgain,
          }
        : null,
      cameraReturn,
    },
    rooms,
  };
}

/**
 * The guide wall's send state, for EVERY track it covers.
 *
 * One screen serves the whole check-in area, so it needs Blue and Red at once
 * — which `raceCheckin` cannot give it, being built from `scope.resourceIds`
 * and describing exactly one track. Same two reads per track the track boards
 * already do (the heat, then its briefed marker), and the sessions behind them
 * are cached per track, so a second track is not a second round trip to
 * Pandora.
 *
 * A track that fails to read is DROPPED rather than reported empty: a wall
 * that says nothing about Red is honest, one that implies Red has no session
 * is not. Every failure path leaves the other track's arrow working.
 */
async function buildGuideSection(
  tracks: readonly ("blue" | "red" | "mega")[],
  businessDay: string,
): Promise<NonNullable<TvFeed["raceGuide"]>> {
  const rows = await Promise.all(
    tracks.map(async (track) => {
      const info = await raceCheckinInfo(track, businessDay).catch(() => null);
      if (!info) return null;
      const briefed = await sessionBriefed(
        info.sessionId != null ? String(info.sessionId) : null,
      ).catch(() => null);
      return {
        track,
        // Carried TRANSIENTLY for dedupe below, stripped before the payload
        // leaves — the feed serves walls in public spaces and carries no ids
        // of any kind (see the TvFeed.raceGuide doc).
        sessionId: info.sessionId,
        heatNumber: info.heatNumber,
        raceType: info.raceType,
        briefedAtMs: briefed?.atMs ?? null,
        briefedRoom: briefed?.room ?? null,
      };
    }),
  );
  // On a Mega day both configured tracks resolve to the ONE combined session,
  // and two rows for it would double the takeover chip. dedupeGuideRows keeps
  // one, relabeled mega; identity function on a normal day. The map below is
  // an explicit ALLOWLIST of what leaves the server — the transient sessionId
  // stays behind by construction, not by omission.
  const deduped = dedupeGuideRows(rows.filter((r): r is NonNullable<typeof r> => r !== null));
  return {
    tracks: deduped.map((r) => ({
      track: r.track,
      heatNumber: r.heatNumber,
      raceType: r.raceType,
      briefedAtMs: r.briefedAtMs,
      briefedRoom: r.briefedRoom,
    })),
  };
}

function safePaused(): string[] {
  try {
    return pausedProductIds();
  } catch {
    // An unreadable maintenance config must not stop the screen; the cost of
    // guessing wrong here is one advert for a paused product, not an outage.
    return [];
  }
}

/**
 * The LIVE half of the feed: only the things that change second to second.
 *
 * Redis reads and nothing else — no Neon, no BMI. That is what lets the screens
 * poll it every couple of seconds so a scan lands on the wall while the racer is
 * still standing at the desk, and a briefing reaches a room's TV about two
 * seconds after staff press send, without putting the party board's database work
 * on the same cadence.
 *
 * DELIBERATELY DOES NOT LOAD THE SCREEN ROW. The briefing state is fetched
 * per-VENUE (one MGET for both rooms) and each TV picks its own room out of it
 * client-side, precisely so this stays a fixed handful of Redis reads no matter
 * how many screens are hanging.
 */
export async function buildTvPulse(
  screenIdRaw: string | null,
  buildSha?: string | null,
  /** See buildTvFeed — diagnostics only. */
  windowed?: boolean,
): Promise<TvPulse> {
  const now = Date.now();
  const parsed = parseScreenKey(screenIdRaw);
  if (!parsed || !screenIdRaw) {
    return {
      now,
      kioskEvents: [],
      reloadAt: null,
      demoMode: null,
      briefingRooms: null,
      cameraReturn: null,
      pitLanes: null,
      pitRosters: null,
      roomBlocked: null,
    };
  }

  const center = VENUE_INFO[parsed.venue]?.center ?? "fort-myers";
  // The pulse is the frequent one, so the build stamp rides it.
  void stampSeen(screenIdRaw, buildSha, windowed);
  // Briefing rooms exist at FastTrax only. Asking for them at HeadPinz would be
  // two wasted Redis reads on every pulse of every lobby screen.
  const wantsBriefing = briefingEnabled() && parsed.venue === "FT";
  const [kioskEvents, reloadAt, demoMode, briefingRooms, cameraReturn] = await Promise.all([
    readSignageEvents(center).catch(() => []),
    reloadRequestedAt(center).catch(() => null),
    demoRequestedFor(screenIdRaw).catch(() => null),
    wantsBriefing ? readBriefingRooms(parsed.venue).catch(() => null) : Promise.resolve(null),
    // THE CAMERA STRIP ON THE FAST LANE, so a registration clears in seconds
    // rather than waiting out the 15s full poll (owner 2026-08-12). Normally one
    // Redis GET of the shared per-venue cache; it only pays the three-read
    // rebuild when that cache has aged past CACHE_TTL_SECONDS, whatever the
    // number of screens polling. FastTrax only, like the rooms above.
    wantsBriefing && cameraReturnBarEnabled()
      ? resolveCameraReturn(parsed.venue, now).catch(() => null)
      : Promise.resolve(null),
  ]);
  // The pit lanes ride the pulse for the same reason the briefing rooms do:
  // "send to holding" and "race returned" are staff presses that must reach
  // the wall in seconds. The fast roster rides beside them so the CARDS track
  // the desk too — adds, check-ins and BMI re-grids land within a pulse or
  // two, Pandora-bounded by the fast-roster cache. FT only — the pits are.
  const [pitLanes, pitRosters] =
    parsed.venue === "FT"
      ? await Promise.all([
          readPitLanes().catch(() => null),
          readFastPitRosters(now).catch(() => null),
        ])
      : [null, null];
  // The stay-seated loop rides the pulse because the pulse is the one poll
  // guaranteed to be running while a race is coming in (every wall, 2s, all
  // night) — the pit tablet may be asleep. NX-throttled server-side, so a
  // building of screens still plays it at most once per interval per track;
  // after the response, so the PA round trip never delays a wall repaint.
  if (pitLanes) afterResponse(() => nudgeStaySeated(pitLanes));
  /**
   * IS EITHER ROOM HOLDING UP A RACE THAT IS ALREADY BACK IN THE PIT?
   *
   * Both inputs are in hand already — the rooms MGET above and the lanes beside
   * it — so this adds one Redis GET per occupied `pitIn` slot and nothing at all
   * on a night when no race is waiting. Fails to "nothing is blocked": a wall
   * that cannot read the gate must stay quiet rather than raise a full-screen
   * alarm on a room that may be perfectly clear.
   */
  const roomBlocked =
    wantsBriefing && briefingRooms && pitLanes
      ? await resolveRoomBlocked(briefingRooms, pitLanes).catch(() => null)
      : null;
  return {
    now,
    kioskEvents,
    reloadAt,
    demoMode,
    briefingRooms,
    cameraReturn,
    pitLanes,
    pitRosters,
    roomBlocked,
  };
}

/**
 * "Next available" per product, for the ad slides.
 *
 * Reads the SAME Redis entry the kiosks read (`kiosk:avail:v4:{center}`, the
 * three-minute cache behind /api/kiosk/availability) rather than recomputing.
 * Two reasons, and both matter: the compute fans out across BMI and QAMF and
 * has a 60-second ceiling, which has no business on a screen's poll; and
 * sharing the cache is what guarantees a wall quoting a time and the machine
 * below it selling that time cannot disagree.
 *
 * Never computes on a miss. No cache means no times on the slides — an advert
 * promising a slot the kiosk will then refuse is worse than one with no time
 * on it at all.
 */
async function buildNextAvailable(venue: SignageVenue): Promise<Record<string, string> | null> {
  try {
    const center = VENUE_INFO[venue].center;
    const raw = await redis.get(`kiosk:avail:v4:${center}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      available?: Record<string, boolean>;
      firstOpen?: Record<string, { start?: string; freeSpots?: number }>;
    };
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed.firstOpen ?? {})) {
      if (!entry?.start) continue;
      // A locked tile never gets a time — see the note above.
      if (parsed.available?.[key] === false) continue;
      // TIME RULE (lesson 51a47370). These starts are NAIVE ET wall-clock
      // ("2026-08-11T11:00:00", no zone). `new Date(...)` parses that as the
      // SERVER's zone — UTC on Vercel — and converting the result to ET then
      // shifts it back four hours, which is how an 11:00 AM opening rendered as
      // "Next available 7:00 AM" on the wall. toEtWallClock + fmtTime12 render
      // the wall-clock components as written, and also handle the Z-stamped
      // case correctly, so this is right for either shape.
      const time = fmtTime12(toEtWallClock(entry.start));
      if (!time) continue;
      out[key] = entry.freeSpots ? `${entry.freeSpots} left · ${time}` : time;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export { signageEventsKey };
