/**
 * NFL schedule sync — SERVER ONLY.
 *
 * The schedule is DATA, not a committed table. World Cup could hand-maintain 16
 * knockout fixtures in a TypeScript array; the NFL plays ~272 regular-season
 * games plus playoffs, and — the part that actually forces this — the league
 * MOVES Sunday kickoffs during the season (flex scheduling, weeks 5-17). A
 * hand-edited array would be wrong within a fortnight.
 *
 * Source: ESPN's public keyless scoreboard, the same feed and the same
 * fail-soft discipline as features/world-cup/live-teams.ts. Verified live
 * 2026-08-25: it accepts a DATE RANGE (`dates=YYYYMMDD-YYYYMMDD`), so the whole
 * booking horizon is one request rather than forty-five.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID. A nightly sync that blindly wrote the
 * incoming kickoff would MOVE SOMEBODY'S LANES when a game gets flexed. So once
 * a game has a live booking its kickoff is frozen (`kickoff_locked`), and a sync
 * that sees a different time reports it for a human instead of writing. Losing
 * a schedule update is recoverable; silently moving a paid booking is not.
 */

import { sql, isDbConfigured } from "@/lib/db";
import { ensureNflSchema } from "./claims.server";
import { nflIncludePreseason } from "./flags";
import type { NflGame, NflSeasonType } from "./schedule";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** ET calendar date for an instant, YYYY-MM-DD. */
function etDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function ymdCompact(ymd: string): string {
  return ymd.replace(/-/g, "");
}

interface EspnCompetitor {
  homeAway?: string;
  team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string };
}
interface EspnEvent {
  id?: string;
  date?: string;
  week?: { number?: number };
  season?: { year?: number; type?: number };
  competitions?: Array<{
    competitors?: EspnCompetitor[];
    broadcasts?: Array<{ names?: string[] }>;
  }>;
}

/**
 * Team name for a card. `shortDisplayName` is the nickname ("Chiefs"), which is
 * what a matchup line wants — `displayName` gives "Kansas City Chiefs" and two
 * of those do not fit a tile. Falls back rather than dropping the game.
 */
function teamName(c: EspnCompetitor | undefined): string | null {
  return c?.team?.shortDisplayName || c?.team?.displayName || c?.team?.abbreviation || null;
}

/** Parse one ESPN event into our shape, or null when it is unusable. */
export function parseEspnEvent(raw: EspnEvent): NflGame | null {
  const id = raw.id;
  const kickoffIso = raw.date;
  if (!id || !kickoffIso || !Number.isFinite(Date.parse(kickoffIso))) return null;

  const comp = raw.competitions?.[0];
  const away = teamName(comp?.competitors?.find((c) => c.homeAway === "away"));
  const home = teamName(comp?.competitors?.find((c) => c.homeAway === "home"));
  if (!away || !home) return null;

  const seasonType = (raw.season?.type ?? 2) as NflSeasonType;
  return {
    id,
    kickoffIso: new Date(kickoffIso).toISOString(),
    dateEt: etDate(kickoffIso),
    awayTeam: away,
    homeTeam: home,
    network: comp?.broadcasts?.[0]?.names?.join("/") || null,
    week: raw.week?.number ?? null,
    season: raw.season?.year ?? new Date(kickoffIso).getUTCFullYear(),
    seasonType,
  };
}

/** Fetch a date range from ESPN. Never throws — returns [] and says why. */
export async function fetchEspnRange(
  fromYmd: string,
  toYmd: string,
): Promise<{ games: NflGame[]; error: string | null }> {
  const url = `${SCOREBOARD}?dates=${ymdCompact(fromYmd)}-${ymdCompact(toYmd)}&limit=400`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { games: [], error: `ESPN ${res.status}` };
    const body = (await res.json()) as { events?: EspnEvent[] };
    const games = (body.events ?? [])
      .map(parseEspnEvent)
      .filter((g): g is NflGame => g !== null)
      .filter((g) => (nflIncludePreseason() ? true : g.seasonType !== 1));
    return { games, error: null };
  } catch (err) {
    return { games: [], error: err instanceof Error ? err.message : "fetch failed" };
  }
}

export interface SyncResult {
  ok: boolean;
  error: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  deactivated: number;
  /** Games whose kickoff MOVED after they were already booked — needs a human. */
  lockedConflicts: Array<{ gameId: string; label: string; stored: string; incoming: string }>;
}

/**
 * Sync `[fromYmd, toYmd]` into `nfl_games`.
 *
 * Upserts on the ESPN event id. A row whose kickoff is locked and whose stored
 * time differs from the feed is left ALONE and reported — see the file header.
 *
 * Games that disappear from the feed inside the synced range (postponed,
 * relocated, cancelled) are marked inactive rather than deleted, so an existing
 * booking keeps its foreign key and its history.
 */
export async function syncNflSchedule(args: {
  fromYmd: string;
  toYmd: string;
}): Promise<SyncResult> {
  const result: SyncResult = {
    ok: false,
    error: null,
    fetched: 0,
    inserted: 0,
    updated: 0,
    deactivated: 0,
    lockedConflicts: [],
  };

  await ensureNflSchema();
  if (!isDbConfigured()) {
    result.error = "DATABASE_URL not configured";
    return result;
  }

  const { games, error } = await fetchEspnRange(args.fromYmd, args.toYmd);
  if (error) {
    result.error = error;
    return result;
  }
  result.fetched = games.length;
  const q = sql();

  // Locked rows in range, so a flexed kickoff is reported not written.
  const lockedRows = await q`
    SELECT game_id, kickoff_at, away_team, home_team
      FROM nfl_games
     WHERE kickoff_locked = TRUE
       AND date_et BETWEEN ${args.fromYmd}::date AND ${args.toYmd}::date
  `;
  const locked = new Map(
    lockedRows.map((r) => [
      r.game_id as string,
      {
        kickoff: new Date(r.kickoff_at as string).toISOString(),
        label: `${r.away_team} at ${r.home_team}`,
      },
    ]),
  );

  for (const g of games) {
    const lock = locked.get(g.id);
    if (lock && lock.kickoff !== g.kickoffIso) {
      result.lockedConflicts.push({
        gameId: g.id,
        label: lock.label,
        stored: lock.kickoff,
        incoming: g.kickoffIso,
      });
      continue; // never move a booked game's lanes
    }

    const rows = await q`
      INSERT INTO nfl_games
        (game_id, kickoff_at, date_et, away_team, home_team, network, week,
         season, season_type, is_active, synced_at)
      VALUES
        (${g.id}, ${g.kickoffIso}, ${g.dateEt}, ${g.awayTeam}, ${g.homeTeam},
         ${g.network}, ${g.week}, ${g.season}, ${g.seasonType}, TRUE, NOW())
      ON CONFLICT (game_id) DO UPDATE SET
        kickoff_at  = EXCLUDED.kickoff_at,
        date_et     = EXCLUDED.date_et,
        away_team   = EXCLUDED.away_team,
        home_team   = EXCLUDED.home_team,
        network     = EXCLUDED.network,
        week        = EXCLUDED.week,
        season      = EXCLUDED.season,
        season_type = EXCLUDED.season_type,
        is_active   = TRUE,
        synced_at   = NOW()
      RETURNING (xmax = 0) AS inserted
    `;
    if (rows[0]?.inserted) result.inserted++;
    else result.updated++;
  }

  // Vanished from the feed → inactive, never deleted.
  //
  // GUARDED ON A NON-EMPTY FEED. `NOT (game_id = ANY('{}'))` is TRUE for every
  // row, so running this sweep against an empty result would deactivate the
  // ENTIRE horizon — and a 200 carrying no events is exactly what a healthy
  // request looks like during the off-season or an upstream blip. An empty feed
  // is not evidence that every game was cancelled, so it is treated as no
  // information rather than as a verdict.
  const seen = games.map((g) => g.id);
  if (seen.length > 0) {
    const gone = await q`
      UPDATE nfl_games
         SET is_active = FALSE
       WHERE date_et BETWEEN ${args.fromYmd}::date AND ${args.toYmd}::date
         AND is_active = TRUE
         AND NOT (game_id = ANY(${seen}))
      RETURNING game_id
    `;
    result.deactivated = gone.length;
  }

  result.ok = true;
  return result;
}

/** Freeze a game's kickoff — called the first time it takes a booking. */
export async function lockGameKickoff(gameId: string): Promise<void> {
  await ensureNflSchema();
  if (!isDbConfigured()) return;
  const q = sql();
  await q`UPDATE nfl_games SET kickoff_locked = TRUE WHERE game_id = ${gameId}`;
}

/**
 * A `DATE` column back to YYYY-MM-DD.
 *
 * The Neon driver hands back a JS Date for a DATE column, constructed at
 * midnight in the PROCESS timezone. `toISOString().slice(0, 10)` therefore rolls
 * back a day anywhere ahead of UTC — right on Vercel (UTC) and on an ET laptop,
 * silently wrong on a UTC+n box. Reading the local parts is correct everywhere.
 */
function dateOnly(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rowToGame(r: Record<string, unknown>): NflGame {
  return {
    id: r.game_id as string,
    kickoffIso: new Date(r.kickoff_at as string).toISOString(),
    dateEt: dateOnly(r.date_et),
    awayTeam: r.away_team as string,
    homeTeam: r.home_team as string,
    network: (r.network as string) ?? null,
    week: (r.week as number) ?? null,
    season: r.season as number,
    seasonType: r.season_type as NflSeasonType,
  };
}

/** Active games with a kickoff in `[fromYmd, toYmd]`, ascending. */
export async function listNflGames(fromYmd: string, toYmd: string): Promise<NflGame[]> {
  await ensureNflSchema();
  if (!isDbConfigured()) return [];
  const q = sql();
  const rows = await q`
    SELECT game_id, kickoff_at, date_et, away_team, home_team, network, week, season, season_type
      FROM nfl_games
     WHERE is_active = TRUE
       AND date_et BETWEEN ${fromYmd}::date AND ${toYmd}::date
     ORDER BY kickoff_at
  `;
  return rows.map((r) => rowToGame(r as Record<string, unknown>));
}

/** One game by ESPN id, or null. */
export async function getNflGame(gameId: string): Promise<NflGame | null> {
  await ensureNflSchema();
  if (!isDbConfigured()) return null;
  const q = sql();
  const rows = await q`
    SELECT game_id, kickoff_at, date_et, away_team, home_team, network, week, season, season_type
      FROM nfl_games
     WHERE game_id = ${gameId} AND is_active = TRUE
  `;
  return rows.length ? rowToGame(rows[0] as Record<string, unknown>) : null;
}
