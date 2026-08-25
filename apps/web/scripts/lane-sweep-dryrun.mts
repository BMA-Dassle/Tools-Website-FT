/**
 * Lane sweep DRY RUN — what would the arrangement engine do to a day's board?
 *
 * READ-ONLY. Reads the real grid from QAMF `reservations/search` (which includes
 * front-desk Conqueror bookings, leagues and maintenance — none of which reach Neon),
 * runs the sweep, and prints the proposed moves plus before/after quality metrics.
 *
 * It NEVER writes. Applying the moves is a separate, explicit tool that uses
 * `moveReservationLanes` (PATCH /lanes) and never deletes anything.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/lane-sweep-dryrun.mts                        # next Saturday, FM
 *   npx tsx scripts/lane-sweep-dryrun.mts --center 11542 --date 2026-08-29
 *   npx tsx scripts/lane-sweep-dryrun.mts --date 2026-08-29 --board
 *
 * Local runs need a Redis-cached QAMF token — `QAMF_BOWLING_CLIENT_ID/_SECRET` live only
 * in Vercel, so `getQamfBowlingToken` serves the cache and cannot re-mint here.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { searchReservations, toCenterLocalIso } = await import("@/lib/qamf-bowling");
const { buildGrid } = await import("~/features/lane-plan/grid.server");
const { deriveLaneGroups, toLaneGroupMap } = await import("~/features/lane-plan/lane-groups");
const { buildOccupancyForecast, forecastAt } = await import("~/features/lane-plan/forecast");
const { sweepDay, affectedPairs, replayGreenfield } = await import("~/features/lane-plan/policy");
const { DEFAULT_POLICY } = await import("~/features/lane-plan/types");
const { byReservation, mateOf, wholeFreePairs, occupancyAt } =
  await import("~/features/lane-plan/grid");
type LaneGrid = import("~/features/lane-plan/types").LaneGrid;
type BusyInterval = import("~/features/lane-plan/types").BusyInterval;
type ProposedMove = import("~/features/lane-plan/types").ProposedMove;

/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const CENTER = Number(flag("center") ?? 9172);
const SHOW_BOARD = args.includes("--board");
/** Replay a day that already happened as if planning it that morning. Backtest only. */
const RETRO = args.includes("--retro");
/** Also let the sweep move front-desk (C-prefix) bookings. Off by default: staff may have
 *  placed a guest deliberately and we do not silently overrule them. */
const MOVE_DESK = args.includes("--move-desk");
const CENTER_LABEL: Record<number, string> = {
  9172: "HeadPinz Fort Myers",
  3148: "HeadPinz Naples",
  11542: "FastTrax duckpin",
};

const ymdEt = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

function nextSaturday(): string {
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const dow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(d);
    if (dow === "Sat") return ymdEt(d);
  }
  return ymdEt(new Date());
}

const DATE = flag("date") ?? nextSaturday();
const dayStartMs = Date.parse(`${DATE}T09:00:00.000-04:00`);
const nextYmd = ymdEt(new Date(Date.parse(`${DATE}T12:00:00-04:00`) + 86400000));
const dayEndMs = Date.parse(`${nextYmd}T02:00:00.000-04:00`);

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

/* ------------------------------------------------------------------ */
/*  Quality metrics — the numbers that say whether a sweep helped      */
/* ------------------------------------------------------------------ */

/**
 * The owner's complaint, quantified: how many single-lane parties start with their
 * PAIR-MATE occupied by somebody else? The mate shares a settee and ball return, so it is
 * the adjacency that actually annoys guests — not the lane across the pair boundary.
 */
function crowdedSingles(grid: LaneGrid): { crowded: number; total: number } {
  const groups = byReservation(grid);
  let crowded = 0;
  let total = 0;
  for (const intervals of groups.values()) {
    if (intervals.length !== 1) continue;
    const b = intervals[0];
    if (b.isBlock) continue;
    total++;
    const mate = mateOf(b.laneNumber);
    const mateBusy = grid.busy.some(
      (o) =>
        o.laneNumber === mate &&
        o.reservationId !== b.reservationId &&
        b.startMs < o.endMs &&
        o.startMs < b.endMs,
    );
    if (mateBusy) crowded++;
  }
  return { crowded, total };
}

/** Whole free pairs at the busiest moment — the inventory left for a walk-in big group. */
function pairsAtPeak(grid: LaneGrid): { pairs: number; atMs: number; used: number } {
  let best = { pairs: Number.POSITIVE_INFINITY, atMs: dayStartMs, used: 0 };
  for (let t = dayStartMs; t < dayEndMs; t += 15 * 60_000) {
    const used = occupancyAt(grid, t);
    const pairs = wholeFreePairs(grid, t, t + 60 * 60_000);
    if (used > best.used || (used === best.used && pairs < best.pairs)) {
      best = { pairs, atMs: t, used };
    }
  }
  return best;
}

/**
 * Crowding split by how busy the house was — the honest diagnostic.
 *
 * The owner's rule is conditional ("when we're dead, spread them out"). At 23 of 28 lanes
 * there is nowhere to spread to and being next to someone is unavoidable, so a single
 * blended percentage hides whether the engine is doing its job. Only the low band is a
 * fair test of the policy.
 */
function crowdedByPressure(grid: LaneGrid): Record<string, { crowded: number; total: number }> {
  const bands: Record<string, { crowded: number; total: number }> = {
    "quiet (<50% full)": { crowded: 0, total: 0 },
    "busy (50-80%)": { crowded: 0, total: 0 },
    "slammed (80%+)": { crowded: 0, total: 0 },
  };
  for (const intervals of byReservation(grid).values()) {
    if (intervals.length !== 1) continue;
    const b = intervals[0];
    if (b.isBlock) continue;
    const used = occupancyAt(grid, b.startMs) / grid.lanes.length;
    const key = used < 0.5 ? "quiet (<50% full)" : used < 0.8 ? "busy (50-80%)" : "slammed (80%+)";
    bands[key].total++;
    const mate = mateOf(b.laneNumber);
    const mateBusy = grid.busy.some(
      (o) =>
        o.laneNumber === mate &&
        o.reservationId !== b.reservationId &&
        b.startMs < o.endMs &&
        o.startMs < b.endMs,
    );
    if (mateBusy) bands[key].crowded++;
  }
  return bands;
}

/** Apply a reservation -> lanes map to a grid in memory, so outcomes can be measured
 *  without writing anything. */
function applyPlacements(grid: LaneGrid, target: Map<string, number[]>): LaneGrid {
  const seen = new Map<string, number>();
  const busy: BusyInterval[] = grid.busy.map((b) => {
    const lanes = target.get(b.reservationId);
    if (!lanes) return b;
    const idx = seen.get(b.reservationId) ?? 0;
    seen.set(b.reservationId, idx + 1);
    return { ...b, laneNumber: lanes[idx] ?? b.laneNumber };
  });
  return { ...grid, busy };
}

/** Apply proposed moves to a grid in memory. */
function applyMoves(grid: LaneGrid, moves: readonly ProposedMove[]): LaneGrid {
  return applyPlacements(grid, new Map(moves.map((m) => [m.reservationId, m.to])));
}

/** One row per lane, one cell per 30 min — the board as staff would read it. */
function renderBoard(grid: LaneGrid): string {
  const step = 30 * 60_000;
  const cols = Math.ceil((dayEndMs - dayStartMs) / step);
  const ids = [...new Set(grid.busy.map((b) => b.reservationId))].sort();
  const glyph = (id: string) => {
    if (id.startsWith("C")) return "▓"; // front desk — not ours
    return String.fromCharCode(97 + (ids.indexOf(id) % 26));
  };
  const lines: string[] = [];
  let header = "lane |";
  for (let c = 0; c < cols; c += 2) {
    header += clock(dayStartMs + c * step)
      .replace(/:00/, "")
      .replace(/\s/g, "")
      .padEnd(4);
  }
  lines.push(header);
  for (const lane of grid.lanes) {
    let row = String(lane).padStart(4) + " |";
    for (let c = 0; c < cols; c++) {
      const t = dayStartMs + c * step;
      const hit = grid.busy.find((b) => b.laneNumber === lane && t >= b.startMs && t < b.endMs);
      row += hit ? (hit.isBlock ? "█" : glyph(hit.reservationId)) : "·";
    }
    lines.push(row + (lane % 2 === 0 ? "  ─" : ""));
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */

console.log(
  `\n=== LANE SWEEP DRY RUN — ${CENTER_LABEL[CENTER] ?? CENTER} (${CENTER}) — ${DATE} ===\n`,
);

// Lane groups from 60 days of history — the only way to learn Conqueror's config.
console.log("Deriving lane groups from history…");
const history: Awaited<ReturnType<typeof searchReservations>> = [];
for (let i = 1; i <= 60; i += 5) {
  const a = Date.now() - i * 86400000;
  const b = Date.now() - (i - 5) * 86400000;
  try {
    history.push(...(await searchReservations(CENTER, toCenterLocalIso(a), toCenterLocalIso(b))));
  } catch (e) {
    console.log(`  history chunk ${i} failed: ${e instanceof Error ? e.message : e}`);
  }
}
const groups = deriveLaneGroups(history);
for (const [offer, g] of [...groups].sort((x, y) => x[0] - y[0])) {
  console.log(
    `  offer ${String(offer).padStart(4)}  ${String(g.samples).padStart(4)} samples  ` +
      `${g.confident ? "USE  " : "weak "} lanes [${g.lanes.join(",")}]`,
  );
}
const laneGroups = toLaneGroupMap(groups);

// The day itself.
console.log(`\nReading the board for ${DATE}…`);
const rawGrid = await buildGrid(CENTER, dayStartMs, dayEndMs);

// Walk-in forecast from the same history — without it the engine reads a half-empty
// future board as "quiet" and spreads into pairs the evening will need.
const forecast = buildOccupancyForecast(history, rawGrid.lanes.length);
const before = { ...rawGrid, forecast };
{
  const dowLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(dayStartMs + 6 * 3600_000));
  const samples = [...forecast.daysPerDow.entries()]
    .map(([d, n]) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}:${n}`)
    .join(" ");
  console.log(`  forecast built from ${history.length} historic reservations (${samples})`);
  const marks = [12, 15, 18, 20, 22].map((h) => {
    const t = Date.parse(`${DATE}T${String(h).padStart(2, "0")}:00:00.000-04:00`);
    const v = forecastAt(forecast, t);
    return `${h}:00 ${v == null ? "n/a" : `${(v * 100).toFixed(0)}%`}`;
  });
  console.log(`  expected ${dowLabel} occupancy — ${marks.join(" · ")}`);
}
const reservations = new Set(before.busy.map((b) => b.reservationId));
const blocks = new Set(before.busy.filter((b) => b.isBlock).map((b) => b.reservationId));
console.log(
  `  ${before.lanes.length} lanes · ${reservations.size} reservations on the board ` +
    `(${blocks.size} league/maintenance/non-bookable) · ` +
    `${before.errorLanes.size} lanes in Error · ${before.openLanes.size} currently Open`,
);

const kinds: Record<string, number> = {};
for (const id of reservations) {
  const b = before.busy.find((x) => x.reservationId === id)!;
  kinds[b.kind || "(none)"] = (kinds[b.kind || "(none)"] ?? 0) + 1;
}
console.log(`  types: ${JSON.stringify(kinds)}`);

// Sweep. `nowMs` is set to the morning of the target day so the freeze window behaves as
// it would on the real morning run rather than freezing everything as "too soon".
const sweep = sweepDay(
  before,
  { ...DEFAULT_POLICY, moveConquerorBookings: MOVE_DESK },
  {
    fromMs: dayStartMs,
    toMs: dayEndMs,
    laneGroups,
    nowMs: dayStartMs,
    freezeMinutes: 90,
    replayHistoric: RETRO,
  },
);

const after = applyMoves(before, sweep.moves);

const cBefore = crowdedSingles(before);
const cAfter = crowdedSingles(after);
const pBefore = pairsAtPeak(before);
const pAfter = pairsAtPeak(after);

console.log(`\n--- PROPOSED MOVES (${sweep.moves.length}) ---`);
console.log(
  `considered ${sweep.considered} movable · ${sweep.frozen} frozen (league / already running / front-desk placed / starts too soon)\n`,
);
if (!sweep.moves.length) {
  console.log("  none — the board already scores within moveCost of optimal.");
} else {
  for (const m of [...sweep.moves].sort((a, b) => a.startMs - b.startMs)) {
    console.log(
      `  ${clock(m.startMs).padStart(8)}-${clock(m.endMs).padEnd(8)} ` +
        `${m.reservationId.padEnd(9)} ${(m.title || m.kind).slice(0, 26).padEnd(26)} ` +
        `lane ${m.from.join("+").padStart(5)} -> ${m.to.join("+").padEnd(5)}  ` +
        `+${String(m.gain).padStart(5)}  ${m.reason}`,
    );
  }
  console.log(`\n  pairs touched: ${affectedPairs(sweep.moves).join(", ")}`);
}

// GREENFIELD: what if we had pinned every one of OUR bookings at create time, in the
// order they actually arrived? The sweep repairs a bad board; this measures never building
// one. Only meaningful on a retro day, where the whole day's bookings exist.
const green = replayGreenfield(
  before,
  { ...DEFAULT_POLICY, moveConquerorBookings: MOVE_DESK },
  { fromMs: dayStartMs, toMs: dayEndMs, laneGroups },
);
const greenGrid = applyPlacements(before, green.placed);
const cGreen = crowdedSingles(greenGrid);
const pGreen = pairsAtPeak(greenGrid);

const pct = (c: { crowded: number; total: number }) =>
  c.total ? `${c.crowded}/${c.total} (${((c.crowded / c.total) * 100).toFixed(1)}%)` : "0/0";

console.log(`\n--- QUALITY ---`);
console.log(`  single-lane parties seated against an occupied PAIR-MATE:`);
console.log(`      as booked (QAMF auto-assign)  ${pct(cBefore)}`);
console.log(`      after a sweep                 ${pct(cAfter)}`);
console.log(`      if pinned at create           ${pct(cGreen)}   <- the real lever`);
console.log(
  `  whole free pairs at the busiest moment (${clock(pBefore.atMs)}, ${pBefore.used}/${before.lanes.length} lanes used):`,
);
console.log(
  `      as booked ${pBefore.pairs}   ·   after sweep ${pAfter.pairs}   ·   pinned at create ${pGreen.pairs}`,
);
if (green.unplaced.length) {
  console.log(
    `  ${green.unplaced.length} could not be placed (house genuinely full) — production fails open to QAMF.`,
  );
}

console.log(`\n  crowding by how full the house was (the rule is conditional — at 80%+ there is`);
console.log(`  nowhere to spread, so only the quiet band is a fair test of the policy):`);
const bandsBefore = crowdedByPressure(before);
const bandsGreen = crowdedByPressure(greenGrid);
for (const band of Object.keys(bandsBefore)) {
  console.log(
    `      ${band.padEnd(20)} as booked ${pct(bandsBefore[band]).padEnd(16)} pinned ${pct(bandsGreen[band])}`,
  );
}

if (SHOW_BOARD) {
  console.log(
    `\n--- BOARD BEFORE ---  (letters = reservation, █ = league/maintenance, ▓ = front desk, ─ = pair boundary)`,
  );
  console.log(renderBoard(before));
  console.log(`\n--- BOARD AFTER ---`);
  console.log(renderBoard(after));
}

console.log(`\nDry run only. Nothing was written.\n`);
process.exit(0);
