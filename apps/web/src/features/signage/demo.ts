/**
 * Demo fixtures — TEST SCREENS ONLY.
 *
 * A welcome board needs a party booked today and a VIP takeover needs a combo
 * ten minutes from its bowling leg. Waiting for either to occur naturally is a
 * poor way to review a design, so `?demo=…` injects fabricated data on a test
 * screen (number 99).
 *
 * TWO HARD RULES, because fake guest data on a real wall would be a genuine
 * incident:
 *   1. Accepted ONLY on a test screen. `applyDemo` is a no-op anywhere else,
 *      whatever the URL says.
 *   2. Purely client-side. Nothing here is ever written, published, or sent to
 *      the server — it decorates one browser tab's copy of the feed.
 *
 * The fixtures feed the REAL scenes through the REAL code paths (the VIP one is
 * timed so the actual takeover window logic decides to show it), so what you
 * review is the true rendering, not a mock of it.
 */
import type { TvFeed, VipEntry, WelcomeEntry } from "./types";

export type DemoMode = "event" | "vip" | "off";

export function parseDemoMode(raw: string | null): DemoMode {
  if (raw === "event" || raw === "vip") return raw;
  return "off";
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

/** A combo whose bowling leg is 8 minutes out — inside the real takeover
 *  window, so the genuine scheduling logic is what puts it on screen. */
function demoVip(nowMs: number): VipEntry[] {
  return [
    {
      id: "demo-vip",
      title: "Sarah",
      comboName: "The Ultimate VIP Experience",
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
          iso: new Date(nowMs + 8 * 60_000).toISOString(),
          lane: "11",
          location: "HeadPinz Fort Myers",
          durationMin: 90,
        },
      ],
    },
  ];
}

/**
 * Decorate a feed with demo data. Returns the feed untouched unless this is a
 * test screen AND a mode was asked for.
 */
export function applyDemo(
  feed: TvFeed | null,
  mode: DemoMode,
  isTestScreen: boolean,
  nowMs: number,
): TvFeed | null {
  if (!feed || mode === "off" || !isTestScreen) return feed;
  if (mode === "event") return { ...feed, events: demoEvents(nowMs) };
  return { ...feed, vip: demoVip(nowMs) };
}
