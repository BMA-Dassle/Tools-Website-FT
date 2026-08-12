/**
 * Demo fixtures — TEST SCREENS ONLY.
 *
 * A welcome board needs a party booked today and a VIP takeover needs a combo
 * ten minutes from its bowling leg. Waiting for either to occur naturally is a
 * poor way to review a design, so `?demo=…` injects fabricated data on a test
 * screen (number 99).
 *
 * SAFETY, because fake guest data on a real wall would be a genuine incident:
 *   1. It takes a deliberate `?demo=` in the URL. Nothing enables it by
 *      accident.
 *   2. It does not survive a reload. The boot resolver rewrites the address to
 *      its canonical `/tv?screen=…` form, so the parameter is gone the moment
 *      the page reloads or self-updates — a screen can never be left in demo.
 *   3. Purely client-side. Nothing here is ever written, published, or sent to
 *      the server — it decorates one browser tab's copy of the feed.
 *
 * The fixtures feed the REAL scenes through the REAL code paths (the VIP one is
 * timed so the actual takeover window logic decides to show it), so what you
 * review is the true rendering, not a mock of it.
 */
import type { BriefingRoomState } from "./briefing/types";
import type { TvFeed, VipEntry, WelcomeEntry } from "./types";

export type DemoMode = "event" | "vip" | "race" | "briefing" | "briefing-return" | "off";

export function parseDemoMode(raw: string | null): DemoMode {
  if (
    raw === "event" ||
    raw === "vip" ||
    raw === "race" ||
    raw === "briefing" ||
    raw === "briefing-return"
  ) {
    return raw;
  }
  return "off";
}

/**
 * Which demo mode this screen should run: a preview pushed from the admin page
 * (riding the feed as `demoMode`) beats a `?demo=` typed into the tab — the
 * point is that staff can drive a wall from a phone.
 *
 * THIS IS THE ONE PLACE that decision is made. It used to live inline in TvApp,
 * and the feed decoration there kept using the raw URL mode after a patch
 * silently failed to land — so pushed welcome/VIP previews decorated nothing,
 * on every screen, while the probe (which re-implemented the wiring correctly)
 * kept passing (2026-08-11, "still only ads"). The app and the probe now import
 * this same function, so they cannot disagree about what a screen would do.
 */
export function effectiveDemoMode(feed: TvFeed | null, urlDemo: DemoMode): DemoMode {
  const pushed = parseDemoMode(feed?.demoMode ?? null);
  return pushed !== "off" ? pushed : urlDemo;
}

function demoEvents(nowMs: number): WelcomeEntry[] {
  const at = (mins: number) => new Date(nowMs + mins * 60_000).toISOString();
  const label = (mins: number) =>
    new Date(nowMs + mins * 60_000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  const rows: [string, number, number, string, string, boolean][] = [
    ["Sarah's Party", 12, 14, "First up: HP VIP Lanes", "HeadPinz Fort Myers", true],
    ["Marcus's Party", 35, 22, "First up: Blue Track", "FastTrax Fort Myers", false],
    ["Aaliyah's Party", 58, 9, "First up: HP Arena", "HeadPinz Fort Myers", false],
    ["Diego's Party", 74, 30, "First up: Game Zone", "HeadPinz Fort Myers", false],
  ];
  return rows.map(([title, mins, guests, stop, building, isVip], i) => ({
    id: `demo-${i}`,
    title,
    guestCount: guests,
    firstStopLabel: stop,
    building,
    startsAtIso: at(mins),
    startsAtLabel: label(mins),
    isVip,
  }));
}

/** TWO combos inside the takeover window — the preview shows the multi-party
 *  layout, because that is the case that needs reviewing (owner 2026-08-11:
 *  "show multiple VIPs on screen at same time"). The real scheduling logic is
 *  still what puts them on screen. */
function demoVip(nowMs: number): VipEntry[] {
  const party = (id: string, title: string, lane: string, bowlInMins: number): VipEntry => ({
    id,
    title,
    comboName: "VIP Experience",
    playerCount: 6,
    schedule: [
      {
        label: "Starter Race",
        iso: new Date(nowMs - 40 * 60_000).toISOString(),
        lane: null,
        location: "FastTrax Fort Myers",
        durationMin: 20,
      },
      {
        label: "VIP Bowling",
        iso: new Date(nowMs + bowlInMins * 60_000).toISOString(),
        lane,
        location: "HeadPinz Fort Myers",
        durationMin: 90,
      },
    ],
  });
  // Sarah holds a consecutive RUN of lanes so the "Lanes 1–4" formatting is
  // exactly what a preview shows (owner 2026-08-11).
  return [party("demo-vip-a", "Sarah", "1,2,3,4", 8), party("demo-vip-b", "Marcus", "12", 6)];
}

/**
 * Decorate a feed with demo data. Returns the feed untouched unless this is a
 * test screen AND a mode was asked for.
 */
export function applyDemo(feed: TvFeed | null, mode: DemoMode, nowMs: number): TvFeed | null {
  if (!feed || mode === "off") return feed;

  // A PREVIEW IS DETERMINISTIC: press the button, see that scene.
  //
  // Live events are cleared while one is running, because interrupts outrank
  // the rotation — so a birthday fired in the last ninety seconds would keep
  // the wall and the preview would appear to do nothing at all. That is
  // correct precedence for a guest moment and useless behaviour for a staff
  // tool, and it is exactly what "preview VIP is not working" looks like from
  // the floor. Previews are short-lived and staff-initiated, so nothing real is
  // lost — the rail refills from Redis the moment the preview expires.
  //
  // EXCEPT the race preview, which keeps them: it is exactly when staff press
  // Simulate scan and watch for the name, and the clearing here is what made
  // that button do nothing mid-preview (owner 2026-08-11). The clear runs
  // BEFORE the branches, so the real list must be captured first.
  const realEvents = feed.kioskEvents;
  feed = { ...feed, kioskEvents: [] };
  if (mode === "event") return { ...feed, events: demoEvents(nowMs) };
  // The briefing previews only need the QUALS half fabricated — the room state
  // itself is generated by the scene from the same clock (demoBriefingRooms), so
  // the real phase calculator is what decides what appears. Reviewing a preview
  // therefore exercises the production timeline, not a mock of it.
  if (mode === "briefing" || mode === "briefing-return") {
    return { ...feed, briefing: demoBriefingSection(feed, mode) };
  }
  if (mode === "race") {
    // A VIP is on the heat too, so the in-field banner can be reviewed in the
    // same pass — and the rail/check-in feed gets a burst of fabricated scans,
    // deterministic and scoped to THIS screen's track so its own filter
    // accepts them.
    const resourceId = feed.screen?.config?.scope?.resourceIds?.[0];
    const names = ["Marcus", "Ava", "Kenyon", "Sofia", "Diego", "Aaliyah"];
    const scans = names.map((firstName, i) => ({
      id: `demo-scan-${i}`,
      kind: "racer-scanned" as const,
      center: feed.screen?.center ?? "fort-myers",
      firstName,
      resourceId,
      activityKeys: ["racing"],
      // Ava owes a headsock, so the feed board's action strip has that state
      // to demonstrate too.
      headsockDue: i === 1,
      atMs: nowMs - i * 25_000,
    }));
    return {
      ...feed,
      // MERGE the fixtures with whatever is really happening, real events
      // first. The event/vip previews clear live events for determinism, but a
      // race preview is precisely when staff press "Simulate scan" to watch a
      // name land — replacing the feed made that button do nothing while the
      // preview ran (owner 2026-08-11: "simulate scan button not working on
      // mega").
      kioskEvents: [...realEvents, ...scans.filter((f) => !realEvents.some((e) => e.id === f.id))],
      raceCheckin: {
        track: feed.raceCheckin?.track ?? "blue",
        sessionId: 59,
        // Same heat the previewed session is (demoCurrentRace) — a preview whose
        // header and whose send announcement disagreed would be its own bug report.
        heatNumber: 59,
        raceType: "Pro",
        vipOnHeat: true,
        vipFirstNames: ["Sarah"],
        checkedIn: 5,
        total: 8,
        // Not yet sent to a briefing room, so the preview shows a live board
        // rather than a cleared one.
        briefedAtMs: null,
        briefedRoom: null,
      },
      // The desk's progress, for the camera monitors' check-in rail. THIS
      // room's heat only — the rail shows one, so a fixture with two would
      // review a layout that cannot happen. Called four minutes ago and
      // mid-count, which is the ordinary state; drive it to `ready` or
      // `overdue` by checking everyone in or letting the window run out, since
      // those are the two the real clock decides. Overnight this section is
      // genuinely empty (nothing has been called), which is the only time
      // anyone is standing in front of a board reviewing it.
      checkinProgress: [
        {
          track: feed.screen?.config?.cameraMonitor?.track ?? "blue",
          heatNumber: 59,
          raceType: "Pro",
          sessionId: "demo-59",
          checkedIn: 6,
          total: 14,
          briefed: false,
          calledAtMs: nowMs - 4 * 60_000,
        },
      ],
    };
  }
  return { ...feed, vip: demoVip(nowMs) };
}

/**
 * A fabricated "now checking in" session, for reviewing the track board outside
 * operating hours.
 *
 * /api/pandora/races-current deliberately reports nothing overnight so a stale
 * "Now Checking In" cannot sit on a wall (or an e-ticket) until morning — which
 * is correct, and also means the board cannot be seen working at 2am without
 * this.
 */
/**
 * Is "now" a Mega day (Tuesday, ET)? PREVIEWS ONLY. Live boards follow the
 * megaTrackEnabled signal and the session data — guessing Mega from the
 * calendar was deliberately rejected for live use, because a Tuesday that is
 * not actually run as Mega would strand a board on an empty track. A preview
 * is fabricated anyway, so the calendar is exactly the right authority: press
 * Preview session on a Mega day, see a Mega session (owner 2026-08-11).
 */
export function demoIsMegaDay(nowMs: number): boolean {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(
      new Date(nowMs),
    ) === "Tue"
  );
}

/* ── briefing rooms ───────────────────────────────────────────────────── */

/**
 * A fabricated send, so a briefing room can be reviewed without a real heat.
 *
 * `briefing` puts the room at the START of a timeline — the video plays, then the
 * helmet board, on the real schedule. `briefing-return` skips straight
 * to the qualification board, which is the half staff most want to check and
 * would otherwise have to sit through a five-minute safety film to reach.
 *
 * Both feed the REAL state shape through the REAL phase calculator, so what a
 * preview shows is what a genuine send will show.
 */
/** One anchor per preview pass — see the note inside demoBriefingRooms. Module
 *  state is safe here: this file only ever runs in the browser, per tab. */
let demoBriefingAnchor: { mode: DemoMode; atMs: number } | null = null;

export function demoBriefingRooms(
  nowMs: number,
  feed: TvFeed | null,
  /** The RESOLVED mode, passed in rather than re-read off the feed.
   *
   *  Re-deriving it from `feed.demoMode` would only ever see a mode PUSHED from
   *  the admin page, so a `?demo=briefing-return` typed into a tab would silently
   *  fall back to the full timeline. That is precisely the two-readers-of-one-
   *  decision bug that made pushed previews decorate nothing (2026-08-11), so
   *  the caller's already-resolved value is the only input. */
  mode: DemoMode,
): Record<"red" | "blue", BriefingRoomState | null> {
  const video = feed?.briefing?.videos.starter ?? null;
  const videoMs = video?.durationMs ?? 5 * 60_000;

  /**
   * THE ANCHOR IS MEMOISED, and this line is why preview could never play a film.
   *
   * `triggeredAtMs` used to be `nowMs - 1_000`, recomputed on every call — and this
   * runs on every render, four times a second on the director tick. The scene keys
   * the <video> element on `triggeredAtMs`, so in PREVIEW mode the element was
   * destroyed and recreated 4×/second, forever. It never survived long enough to
   * decode a frame: black screen, a storm of instantly-aborted requests, and a
   * timeline pinned 1s in that never advanced. A REAL send stores its stamp once in
   * Redis, which is why real briefings were fine while every admin-preview test
   * failed (owner 2026-08-11, "this is deploy like 8 now" — every one of those
   * tests went through this path).
   *
   * The anchor lives for one preview pass and re-arms when its timeline has run
   * out, so a preview left up simply plays again — a preview that dies to a blank
   * board would read as the bug it is trying to disprove.
   */
  const fullPassMs = videoMs + 31_000 + 60_000; // film + helmet + a minute of idle
  if (
    !demoBriefingAnchor ||
    demoBriefingAnchor.mode !== mode ||
    nowMs - demoBriefingAnchor.atMs > fullPassMs
  ) {
    demoBriefingAnchor = {
      mode,
      // `briefing` starts at the top so the film can be watched running;
      // `briefing-return` jumps past the film to the post-video boards, which is
      // the half staff most want to check and would otherwise sit through a
      // five-minute film to reach.
      atMs: mode === "briefing-return" ? nowMs - (videoMs + 31_000) : nowMs - 1_000,
    };
  }

  const state: BriefingRoomState = {
    kind: "timeline",
    tier: "starter",
    track: "red",
    raceType: "Starter",
    sessionId: "demo-60",
    heatNumber: 60,
    triggeredAtMs: demoBriefingAnchor.atMs,
    videoUrl: video?.url ?? null,
    videoDurationMs: video?.durationMs ?? null,
  };
  // BOTH rooms, because the preview is pushed to one screen and we do not know
  // which room that screen is configured as.
  return { red: state, blue: state };
}

/** Fabricated assets, so a preview has films and a poster to lay out. */
function demoBriefingSection(feed: TvFeed, mode: DemoMode): TvFeed["briefing"] {
  const real = feed.briefing;
  return {
    videos: real?.videos ?? { starter: null, intermediate: null, pro: null },
    helmetPosterUrl: real?.helmetPosterUrl ?? null,
    welcomeBack:
      mode === "briefing-return"
        ? {
            heatNumber: 58,
            raceType: "Starter",
            track: "red",
            // Fabricated split so the preview lays out the name board — laps
            // straddle the Red Starter→Intermediate cutoff (46.000).
            results: {
              levelledUp: [
                { name: "Marcus Webb", bestMs: 44_812 },
                { name: "Dana Ruiz", bestMs: 45_990 },
              ],
              keepPushing: [
                { name: "Tyler Nguyen", bestMs: 46_431 },
                { name: "Priya Shah", bestMs: 48_102 },
                { name: "Sam Osteen", bestMs: null },
              ],
            },
          }
        : (real?.welcomeBack ?? null),
    // THE CAMERA STRIP, fabricated so the 104 px reserve and both box states can
    // be reviewed off a laptop — on a quiet afternoon the real strip is empty and
    // there is nothing to look at. Deliberately covers the awkward cases:
    // camera 8 is two heats stale (the "returned earlier but still hasn't
    // scanned in" case), 17 and 31 are inside their green hold, and ordering is
    // by assignedAt so a reviewer can watch that a box does not move.
    cameraReturn: {
      boxes: [
        { camera: "8", state: "out", heatNumber: 56, sinceFlagMs: 18 * 60_000, assignedAtMs: 1 },
        { camera: "17", state: "back", heatNumber: 58, sinceFlagMs: 2 * 60_000, assignedAtMs: 2 },
        { camera: "23", state: "out", heatNumber: 58, sinceFlagMs: 2 * 60_000, assignedAtMs: 3 },
        { camera: "26", state: "out", heatNumber: 58, sinceFlagMs: 2 * 60_000, assignedAtMs: 4 },
        { camera: "31", state: "back", heatNumber: 58, sinceFlagMs: 2 * 60_000, assignedAtMs: 5 },
        { camera: "44", state: "out", heatNumber: 58, sinceFlagMs: 30_000, assignedAtMs: 6 },
      ],
      outCount: 4,
    },
  };
}

export function demoCurrentRace(nowMs: number, trackName: string) {
  return {
    trackName,
    raceType: "Pro",
    heatNumber: 59,
    // The e-ticket time is the check-in CUT-OFF, so put it a few minutes out.
    scheduledStart: new Date(nowMs + 6 * 60_000).toISOString(),
    // Called two minutes ago, so a default 8-minute window shows ~6:00 left
    // and can be watched ticking rather than sitting at a round number.
    calledAt: new Date(nowMs - 2 * 60_000).toISOString(),
    sessionId: 59,
  };
}
