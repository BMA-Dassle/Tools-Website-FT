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
import type { TvFeed, VipEntry, WelcomeEntry } from "./types";

export type DemoMode = "event" | "vip" | "race" | "off";

export function parseDemoMode(raw: string | null): DemoMode {
  if (raw === "event" || raw === "vip" || raw === "race") return raw;
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
        vipOnHeat: true,
        vipFirstNames: ["Sarah"],
        checkedIn: 5,
        total: 8,
      },
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
