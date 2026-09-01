/**
 * READ-ONLY: what would the arena check-in boards be showing right now?
 *
 *   npx tsx scripts/signage-arena-board-probe.mts
 *   npx tsx scripts/signage-arena-board-probe.mts --day 2026-08-30
 *
 * IMPORTS THE APP'S OWN RULES — `classifyArenaBoardSession` and
 * `activeArenaCalls`, not re-implementations of them — so a probe that agrees
 * with the wall proves the wall. Only the vendor call is done here,
 * deliberately: the feed's own reader is a `server-only` module, and a probe
 * bent into importing one would be testing the bend rather than the board.
 *
 * Prints, per HeadPinz venue: what Pandora says is called, which of those rows
 * classify as arena sessions, and which of THOSE the board would actually put on
 * the wall under the ten-minute hold. `--day` additionally lists that business
 * day's whole arena schedule, which is what to reach for when the live call list
 * is empty (it is empty most of the time, and outside opening hours always) and
 * you need to know whether the venue publishes arena sessions at all.
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";

const dayArg = process.argv.indexOf("--day");
const DAY = dayArg >= 0 ? process.argv[dayArg + 1] : null;

interface CurrentRow {
  sessionId?: string | number;
  resourceName?: string;
  type?: string;
  name?: string;
  heatNumber?: number;
  scheduledStart?: string | null;
  calledAt?: string;
}

async function get(url: string): Promise<{ status: number; rows: CurrentRow[]; body: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  try {
    const json = JSON.parse(body) as { data?: unknown };
    return {
      status: res.status,
      rows: Array.isArray(json?.data) ? (json.data as CurrentRow[]) : [],
      body,
    };
  } catch {
    return { status: res.status, rows: [], body };
  }
}

/** ET wall-clock, for a human reading this next to a clock on the wall. */
function et(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function main() {
  // The app's own vocabulary and rules, so this cannot drift from the board.
  const { VENUE_INFO } = await import("../src/features/signage/constants");
  const arena: any = await import("../src/features/signage/arena/arena-board");
  const {
    activeArenaCalls,
    classifyArenaBoardSession,
    ARENA_HOLD_DEFAULT_MS,
    ARENA_ACTIVITY_LABELS,
  } = arena.default ?? arena;

  const now = Date.now();
  console.log(
    `now: ${et(new Date(now).toISOString())} ET   hold: ${ARENA_HOLD_DEFAULT_MS / 60_000} min\n`,
  );

  for (const venue of ["HPFM", "HPN"] as const) {
    const info = VENUE_INFO[venue];
    console.log(`════ ${info.label} — ${venue} (pandora ${info.squareLocationId}) ════`);

    const cur = await get(`${BASE}/bmi/sessions/current/${info.squareLocationId}`);
    console.log(`  sessions/current → ${cur.status}, ${cur.rows.length} called`);
    if (cur.status !== 200) console.log(`    body: ${cur.body.slice(0, 200)}`);

    const calls = [];
    for (const row of cur.rows) {
      // Both fields joined, exactly as the reader does it — a birthday's
      // "- Gel Blaster or Laser Tag" has to be seen whole to resolve to `either`.
      const activity = classifyArenaBoardSession(`${row.type || ""} ${row.name || ""}`);
      const calledAtMs = row.calledAt ? Date.parse(row.calledAt) : NaN;
      console.log(
        `    resource="${row.resourceName}" heat=${row.heatNumber} type="${row.type}" ` +
          `called=${et(row.calledAt)} → ${activity ?? "NOT AN ARENA SESSION (skipped)"}`,
      );
      // Exactly the two rejections the reader makes: not an arena session, and
      // no call time to measure anything from.
      if (!activity || !Number.isFinite(calledAtMs)) continue;
      calls.push({
        sessionId: String(row.sessionId ?? ""),
        activity,
        heatNumber: typeof row.heatNumber === "number" ? row.heatNumber : null,
        scheduledStart: row.scheduledStart ?? null,
        calledAtMs,
      });
    }

    const active = activeArenaCalls(calls, now, ARENA_HOLD_DEFAULT_MS);
    console.log(`  ── the board would show ${active.length} panel(s) ──`);
    for (const c of active) {
      const ageMin = ((now - c.calledAtMs) / 60_000).toFixed(1);
      console.log(
        `    ${ARENA_ACTIVITY_LABELS[c.activity]}  Session ${c.heatNumber ?? "—"}  ` +
          `called ${ageMin} min ago  be checked in by ${et(c.scheduledStart)}`,
      );
    }
    if (active.length === 0) {
      console.log(`    (nothing live — the board is running its films and house adverts)`);
    }

    if (DAY) {
      const sched = await get(
        `${BASE}/bmi/sessions/${info.squareLocationId}` +
          `?startDate=${DAY}T00:00:00&endDate=${DAY}T23:59:59&resourceName=HP%20Arena`,
      );
      console.log(
        `  ── "HP Arena" schedule for ${DAY} → ${sched.status}, ${sched.rows.length} sessions ──`,
      );
      for (const row of sched.rows.slice(0, 12)) {
        console.log(`    ${row.heatNumber}  ${row.name}  (${row.type})  ${et(row.scheduledStart)}`);
      }
      if (sched.rows.length > 12) console.log(`    … and ${sched.rows.length - 12} more`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
