/**
 * Lane GRID TRUTH CHECK — does our schedule see everything that is physically on the lanes?
 *
 * READ-ONLY. This is the gate the owner set: "make sure it honors things that are already
 * booked that are not in our database." Nothing may be pinned or moved at a center until
 * this reports zero blocking gaps across a busy weekend.
 *
 * It compares two INDEPENDENT vendor reads:
 *   - `POST /reservations/search`  — the schedule (what is booked)
 *   - `GET  /lanes`                — the floor (what is actually running right now)
 * A lane running a session that the schedule thinks is free is a hole in the grid, and
 * would let us sell that lane twice.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/lane-grid-check.mts                  # all centers, once
 *   npx tsx scripts/lane-grid-check.mts --center 9172
 *   npx tsx scripts/lane-grid-check.mts --watch 10       # re-check every 10 min
 *
 * Run it during PEAK, not on a quiet night — a house with two lanes open proves nothing.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { buildGrid, findGridGaps } = await import("~/features/lane-plan/grid.server");

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const CENTERS = [
  { id: 9172, label: "HeadPinz Fort Myers" },
  { id: 3148, label: "HeadPinz Naples" },
  { id: 11542, label: "FastTrax duckpin" },
];
const only = flag("center") ? Number(flag("center")) : null;
const watchMinutes = flag("watch") ? Number(flag("watch")) : 0;

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));

async function checkOnce(): Promise<number> {
  const now = Date.now();
  let blocking = 0;
  console.log(`\n===== grid truth check — ${clock(now)} ET =====`);
  for (const c of CENTERS) {
    if (only && c.id !== only) continue;
    try {
      // A four-hour window centred on now; buildGrid widens the leading edge itself so a
      // session already running is included.
      const grid = await buildGrid(c.id, now - 2 * 3600_000, now + 2 * 3600_000);
      const gaps = findGridGaps(grid, now);
      const open = grid.liveLanes.filter((l) => l.status === "Open").length;
      const err = grid.liveLanes.filter((l) => l.status === "Error").length;
      const busyNow = new Set(
        grid.busy.filter((b) => now >= b.startMs && now < b.endMs).map((b) => b.laneNumber),
      ).size;
      const hard = gaps.filter((g) => g.severity === "blocking");
      blocking += hard.length;

      console.log(
        `\n  ${c.label} (${c.id}) — ${grid.lanes.length} lanes · floor: ${open} Open, ${err} Error · ` +
          `schedule says ${busyNow} busy now · ${grid.busy.length} lane-intervals in window`,
      );
      if (!gaps.length) {
        console.log(`    OK — the schedule accounts for every running lane.`);
      }
      for (const g of gaps) {
        console.log(
          `    ${g.severity === "blocking" ? "GAP  " : "note "} lane ${String(g.lane).padStart(2)}: ${g.problem}`,
        );
      }
      // A quiet moment cannot prove much — say so rather than banking a false pass.
      if (open === 0) {
        console.log(`    (no lanes open right now — this run proves very little; re-run at peak)`);
      }
    } catch (e) {
      console.log(`\n  ${c.label} (${c.id}) — READ FAILED: ${e instanceof Error ? e.message : e}`);
      blocking++; // a center we cannot read is not a center we can pin lanes at
    }
  }
  console.log(
    `\n  => ${blocking === 0 ? "no blocking gaps this pass" : `${blocking} BLOCKING GAP(S) — do not enable pinning`}`,
  );
  return blocking;
}

await checkOnce();

if (watchMinutes > 0) {
  console.log(`\nWatching every ${watchMinutes} min. Ctrl-C to stop.`);
  setInterval(() => void checkOnce(), watchMinutes * 60_000);
} else {
  process.exit(0);
}
