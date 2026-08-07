// READ-ONLY. Two questions, one probe:
//
//  1. WINDOW. pre-race-tickets only pushes NEXT RACE for sessions inside
//     [now-5min, now+2h]. Heats routinely run 8-17 min LATE (licence-clear.ts
//     documents both directions from real data). So how long AFTER its scheduled
//     start is a heat actually called for check-in? Every minute past 5 is a
//     minute where checkin-alerts pushes "Check in now" for a heat that
//     pre-race-tickets has already stopped covering.
//
//  2. ROSTER. For every pass carrying a live field, is that racer STILL on the
//     roster of the session we wrote onto their pass? Nothing in the wallet code
//     asks this — a racer scratched after the push keeps "Check in now" until
//     the heat runs.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SPLIT_RE = /\r?\n/;
function loadEnvLocal(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    for (const c of [resolve(dir, ".env.local"), resolve(dir, "apps", "web", ".env.local")]) {
      if (!existsSync(c)) continue;
      for (const l of readFileSync(c, "utf8").split(SPLIT_RE)) {
        const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined)
          process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      }
      return;
    }
    dir = resolve(dir, "..");
  }
  process.exit(1);
}
loadEnvLocal();

const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";

async function pandora(path: string): Promise<any> {
  const res = await fetch(`${PANDORA}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

const fmt = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", timeStyle: "short", dateStyle: "short" })
    : "—";

async function main() {
  const ymd =
    process.env.YMD || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // ── 1. Scheduled vs actual start, every heat today.
  const sessions = new Map<string, any>();
  for (const resourceName of ["Blue Track", "Red Track", "Mega Track"]) {
    const j = await pandora(
      `/bmi/sessions/${LOC}?resourceName=${encodeURIComponent(resourceName)}` +
        `&startDate=${ymd}T00:00:00&endDate=${ymd}T23:59:59`,
    );
    for (const s of (j?.data ?? []) as any[]) sessions.set(String(s.sessionId), s);
  }
  console.log(`sessions on ${ymd}: ${sessions.size}\n`);

  const lateness: number[] = [];
  console.log("heat   sched     actualStart   late(min)  actualEnd");
  for (const s of [...sessions.values()].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  )) {
    if (!s.actualStart) continue;
    const late = (new Date(s.actualStart).getTime() - new Date(s.scheduledStart).getTime()) / 60000;
    lateness.push(late);
    console.log(
      `${String(s.heatNumber ?? "?").padStart(4)}   ${fmt(s.scheduledStart).padEnd(9)} ${fmt(s.actualStart).padEnd(13)} ${late.toFixed(1).padStart(9)}  ${fmt(s.actualEnd)}`,
    );
  }
  if (lateness.length) {
    const over5 = lateness.filter((l) => l > 5).length;
    console.log(
      `\n  ${lateness.length} heats started · ${over5} (${Math.round((100 * over5) / lateness.length)}%) started MORE THAN 5 MIN LATE` +
        ` · max ${Math.max(...lateness).toFixed(1)} min · median ${lateness.slice().sort((a, b) => a - b)[Math.floor(lateness.length / 2)].toFixed(1)} min`,
    );
    console.log(
      `  WINDOW_SKEW_BEHIND_MS is 5 min — every heat above that line left the pre-race window BEFORE it was called.\n`,
    );
  }

  // ── 2. Is each pass-holder still on the roster we wrote onto their pass?
  const { sql } = await import("../lib/db");
  const q = sql();
  const rows = (await q`
    SELECT person_id, next_race, checkin_status, checkin_session_id, next_race_session_id
    FROM racer_wallet_passes
    WHERE (checkin_status IS NOT NULL AND checkin_status <> '' AND checkin_status <> 'Not checking in yet')
       OR (next_race_session_id IS NOT NULL)
    ORDER BY updated_at DESC`) as any[];

  const rosters = new Map<string, Set<string>>();
  async function roster(sessionId: string): Promise<Set<string>> {
    if (rosters.has(sessionId)) return rosters.get(sessionId)!;
    const j = await pandora(`/bmi/session-participants/${LOC}/${sessionId}`);
    const set = new Set<string>((j?.data ?? []).map((p: any) => String(p.personId)));
    rosters.set(sessionId, set);
    return set;
  }

  console.log(`\n── roster check on ${rows.length} live pass row(s)`);
  let orphanCheckin = 0;
  let orphanNext = 0;
  for (const r of rows) {
    const pid = String(r.person_id);
    const notes: string[] = [];
    if (r.checkin_session_id) {
      const set = await roster(String(r.checkin_session_id));
      if (set.size && !set.has(pid)) {
        notes.push(`NOT on checkin session ${r.checkin_session_id} roster (pass says "${r.checkin_status}")`);
        orphanCheckin++;
      }
    }
    if (r.next_race_session_id) {
      const set = await roster(String(r.next_race_session_id));
      if (set.size && !set.has(pid)) {
        notes.push(`NOT on nextRace session ${r.next_race_session_id} roster (pass says "${r.next_race}")`);
        orphanNext++;
      }
    }
    if (notes.length) console.log(`  person ${pid}: ${notes.join(" | ")}`);
  }
  console.log(
    `\n  ${orphanCheckin} pass(es) telling a racer to check into a heat they are NOT on.`,
  );
  console.log(`  ${orphanNext} pass(es) showing a NEXT RACE they are NOT on.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
