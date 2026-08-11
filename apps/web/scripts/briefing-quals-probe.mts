/**
 * PROBE — does a called session's id resolve its scores?
 *
 * THE ONE ASSUMPTION IN THE BRIEFING FEATURE I COULD NOT VERIFY BY READING CODE.
 *
 * The qualification board works like this: when staff send a session to a room we
 * record `CurrentRace.sessionId` (from /api/pandora/races-current), and later we
 * ask Pandora for that session's scores (/api/leagues?action=scores&sessionId=…)
 * to work out who levelled up. Those two endpoints are different Pandora
 * surfaces — `bmi/races/current` and `bmi/records/scores` — and nothing in the
 * repo proves they speak the SAME session-id space. If they do not, the board
 * degrades quietly to helmet sizes and nobody would ever be told why.
 *
 * This probe answers it against production data. It imports nothing from the app
 * (the endpoints are the contract), so it can be pointed at prod safely — every
 * call is a GET.
 *
 * Usage:
 *   npx tsx apps/web/scripts/briefing-quals-probe.mts
 *   BASE=https://fasttraxent.com npx tsx apps/web/scripts/briefing-quals-probe.mts
 *
 * READ THE VERDICT AT THE BOTTOM. If it says the id space does not match, the
 * fix is to resolve the finished session via /api/leagues?action=sessions (which
 * hands back ids from the same space as scores) and match on heat number —
 * quals.server.ts is where that would go.
 */
const BASE = process.env.BASE || "https://fasttraxent.com";
const LOCATION = "LAB52GY480CJF";

interface CurrentRace {
  trackName: string;
  raceType: string;
  heatNumber: number;
  calledAt: string;
  sessionId: number;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function asArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? data : [];
}

async function main() {
  console.log(`Probing ${BASE}\n`);

  /* 1 ── what has been called recently, and what id does it carry? */
  const races = (await getJson(`${BASE}/api/pandora/races-current?prefer=cache`)) as Record<
    string,
    CurrentRace | null
  >;
  const called = Object.entries(races).filter(([, r]) => !!r) as [string, CurrentRace][];

  console.log("── races-current ──");
  if (called.length === 0) {
    console.log("  nothing called right now (out of hours?). Re-run during a race night.");
  }
  for (const [track, race] of called) {
    console.log(
      `  ${track.padEnd(5)} session ${race.sessionId}  heat ${race.heatNumber}  ${race.raceType}  called ${race.calledAt}`,
    );
    // The precision check that matters: an id that survives a JSON round-trip
    // unrounded is safe; one that does not would be corrupted before we ever
    // stored it. (We store as TEXT for exactly this reason.)
    const asText = String(race.sessionId);
    if (!Number.isSafeInteger(race.sessionId)) {
      console.log(`  ⚠ session id ${asText} EXCEEDS Number.MAX_SAFE_INTEGER — see the id rule`);
    }
  }

  /* 2 ── today's FINISHED sessions, from the scores side of Pandora */
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const groups = [
    { track: "Blue Track", name: "Blue Starter" },
    { track: "Blue Track", name: "Blue Intermediate" },
    { track: "Blue Track", name: "Blue Pro" },
    { track: "Red Track", name: "Red Starter" },
    { track: "Red Track", name: "Red Intermediate" },
    { track: "Red Track", name: "Red Pro" },
  ];

  console.log("\n── leagues sessions (the scores id space) ──");
  const finished: { sessionId: number; name: string; group: string; state: number }[] = [];
  for (const g of groups) {
    try {
      const url =
        `${BASE}/api/leagues?action=sessions&location=${LOCATION}` +
        `&track=${encodeURIComponent(g.track)}&scoreGroup=${encodeURIComponent(g.name)}` +
        `&startDate=${encodeURIComponent(`${today}T00:00:00`)}` +
        `&endDate=${encodeURIComponent(`${today}T23:59:59`)}`;
      const rows = asArray(await getJson(url)) as {
        sessionId: number;
        name: string;
        state: number;
      }[];
      for (const s of rows) {
        if (s.state >= 3) finished.push({ ...s, group: g.name });
      }
      console.log(`  ${g.name.padEnd(20)} ${rows.length} sessions today`);
    } catch (err) {
      console.log(`  ${g.name.padEnd(20)} FAILED — ${(err as Error).message}`);
    }
  }

  /* 3 ── THE ANSWER: does a called id appear in the scores id space? */
  console.log("\n── verdict ──");
  const finishedIds = new Set(finished.map((f) => String(f.sessionId)));
  console.log(`  ${finished.length} finished sessions today; ids look like: ${
    finished
      .slice(0, 4)
      .map((f) => f.sessionId)
      .join(", ") || "(none)"
  }`);

  let overlap = 0;
  for (const [track, race] of called) {
    const hit = finishedIds.has(String(race.sessionId));
    if (hit) overlap += 1;
    console.log(
      `  called ${track} session ${race.sessionId} → ${hit ? "FOUND in scores id space ✓" : "not found (may simply not have finished yet)"}`,
    );
  }

  /* 4 ── prove scores are actually readable for a finished session */
  if (finished.length > 0) {
    const sample = finished[0];
    try {
      const scores = asArray(
        await getJson(
          `${BASE}/api/leagues?action=scores&location=${LOCATION}&sessionId=${sample.sessionId}`,
        ),
      ) as { name?: string; bestLap?: number; persId?: number }[];
      console.log(
        `\n  scores for finished session ${sample.sessionId} (${sample.group}): ${scores.length} rows`,
      );
      for (const s of scores.slice(0, 5)) {
        console.log(`    ${(s.name ?? "?").padEnd(24)} bestLap ${s.bestLap ?? "—"}`);
      }
      if (scores.length === 0) {
        console.log("    ⚠ session is finished but has no scores — quals board would stay empty");
      }
    } catch (err) {
      console.log(`\n  ⚠ scores fetch FAILED for ${sample.sessionId} — ${(err as Error).message}`);
    }
  }

  console.log(
    `\n  ${
      overlap > 0
        ? "AT LEAST ONE called id was found in the scores space — the assumption holds."
        : "INCONCLUSIVE: no called session has finished yet. Re-run mid-evening, after a heat has run."
    }`,
  );
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
