/**
 * Live team names for the World Cup fixtures — SERVER-ONLY (fetch + Redis).
 *
 * The committed fixture table ships knockout matchups as `teams: null` until
 * the bracket resolves. Instead of hand-editing fixtures.ts after every round
 * (owner ask 7/3: "update the TBD teams so I don't have to"), this resolver
 * fills them from ESPN's public World Cup scoreboard feed:
 *
 *   - Matches are correlated by EXACT kickoff instant (fixtureKickoffMs), so
 *     a feed hiccup can never mislabel a different game.
 *   - Live data fills ONLY fixtures whose committed `teams` is null — a
 *     committed string is owner-verified truth and doubles as the manual
 *     override lever if the feed is ever wrong.
 *   - Display-only: booking validation, pricing, and the QAMF window all key
 *     off date/hour and are untouched by this module.
 *   - Fail-soft everywhere: feed down / shape drift / Redis down → `{}` and
 *     the UI shows "Quarterfinal — Teams TBD", exactly as without this module.
 *   - Cached in ONE small Redis key with a TTL (Redis OOM lesson: no key
 *     sprawl), plus a per-lambda memo so hot paths skip Redis entirely.
 *
 * Kill switch: WORLD_CUP_LIVE_TEAMS_ENABLED="false" (server env, no redeploy
 * of copy needed — the committed strings take over).
 */
import redis from "@/lib/redis";
import { WORLD_CUP_FIXTURES, fixtureKickoffMs, type WorldCupFixture } from "./fixtures";

const CACHE_KEY = "worldcup:live-teams";
const CACHE_TTL_SECONDS = 60 * 60; // brackets resolve at most twice a day
const ERROR_TTL_SECONDS = 10 * 60; // don't hammer a failing feed
const MEMO_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;

// Public, keyless scoreboard feed (unofficial but long-stable). One request
// covers the whole remaining window.
const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" +
  "?dates=20260703-20260719&limit=100";

/** The slice of ESPN's scoreboard we read — everything optional, we verify. */
export interface EspnScoreboardEvent {
  date?: string; // kickoff instant, ISO (UTC)
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: string;
      team?: { displayName?: string };
    }>;
  }>;
}

/** Placeholder names ESPN uses while a bracket slot is unresolved. */
function isPlaceholderName(name: string): boolean {
  return /\bTBD\b|\bTBC\b|winner|loser|to be determined/i.test(name);
}

/**
 * Pure mapper: ESPN events → { fixtureId: "Home vs Away" } for fixtures whose
 * committed `teams` is null. Exported for unit tests.
 */
export function mapEspnEventsToOverrides(
  events: EspnScoreboardEvent[],
  fixtures: WorldCupFixture[] = WORLD_CUP_FIXTURES,
): Record<string, string> {
  const byKickoffMs = new Map<number, WorldCupFixture>();
  for (const f of fixtures) {
    if (f.teams === null) byKickoffMs.set(fixtureKickoffMs(f), f);
  }

  const out: Record<string, string> = {};
  for (const ev of events) {
    if (!ev?.date) continue;
    const ms = Date.parse(ev.date);
    if (Number.isNaN(ms)) continue;
    const fixture = byKickoffMs.get(ms);
    if (!fixture) continue;

    const competitors = ev.competitions?.[0]?.competitors ?? [];
    if (competitors.length !== 2) continue;
    const home = competitors.find((c) => c?.homeAway === "home") ?? competitors[0];
    const away = competitors.find((c) => c?.homeAway === "away") ?? competitors[1];
    const homeName = home?.team?.displayName?.trim();
    const awayName = away?.team?.displayName?.trim();
    if (!homeName || !awayName) continue;
    if (isPlaceholderName(homeName) || isPlaceholderName(awayName)) continue;
    if (homeName === awayName) continue;

    out[fixture.id] = `${homeName} vs ${awayName}`;
  }
  return out;
}

let memo: { at: number; value: Record<string, string> } | null = null;

function liveTeamsEnabled(): boolean {
  return process.env.WORLD_CUP_LIVE_TEAMS_ENABLED !== "false";
}

/**
 * fixtureId → "Home vs Away" for resolved brackets. Never throws; `{}` on any
 * failure. Memo → Redis → ESPN, in that order.
 */
export async function liveTeamOverrides(): Promise<Record<string, string>> {
  if (!liveTeamsEnabled()) return {};
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.value;

  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const value = JSON.parse(cached) as Record<string, string>;
      memo = { at: now, value };
      return value;
    }
  } catch {
    // Redis unavailable — fall through to the feed (still memoized).
  }

  let value: Record<string, string> = {};
  let ttl = ERROR_TTL_SECONDS;
  try {
    const res = await fetch(ESPN_SCOREBOARD_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { events?: EspnScoreboardEvent[] };
      value = mapEspnEventsToOverrides(data.events ?? []);
      ttl = CACHE_TTL_SECONDS;
    }
  } catch {
    // Feed down/slow — cache the empty result briefly and move on.
  }

  memo = { at: now, value };
  try {
    await redis.set(CACHE_KEY, JSON.stringify(value), "EX", ttl);
  } catch {
    /* cache write is best-effort */
  }
  return value;
}

/** The fixture table with live team names filled into the null slots. */
export async function fixturesWithLiveTeams(): Promise<WorldCupFixture[]> {
  const overrides = await liveTeamOverrides();
  return WORLD_CUP_FIXTURES.map((f) =>
    f.teams === null && overrides[f.id] ? { ...f, teams: overrides[f.id] } : f,
  );
}

/** One fixture, live-enriched — for reserve-time staff strings/metadata. */
export async function enrichFixture(fixture: WorldCupFixture): Promise<WorldCupFixture> {
  if (fixture.teams !== null) return fixture;
  const overrides = await liveTeamOverrides();
  return overrides[fixture.id] ? { ...fixture, teams: overrides[fixture.id] } : fixture;
}
