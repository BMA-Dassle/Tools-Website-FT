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
const { sweepDay, affectedPairs, replayGreenfield, simulateDay } =
  await import("~/features/lane-plan/policy");
const { DEFAULT_POLICY } = await import("~/features/lane-plan/types");
const { byReservation, freeLanes, lanesAvailableFor, mateOf, wholeFreePairs, occupancyAt } =
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

/**
 * SAFETY INVARIANT: two parties may never share a lane at the same time.
 *
 * Rearranging a board is a PERMUTATION, so a simulated board must contain exactly the
 * collisions the real one did (normally none). This is the bug class that already bit the
 * first `sweepDay` — it seeded its working board with only the frozen set, so one booking
 * could claim a lane another was still sitting on. Never eyeball this; count it.
 */
function laneCollisions(grid: LaneGrid): { lane: number; a: string; b: string; atMs: number }[] {
  const hits: { lane: number; a: string; b: string; atMs: number }[] = [];
  const byLane = new Map<number, BusyInterval[]>();
  for (const b of grid.busy) {
    const list = byLane.get(b.laneNumber);
    if (list) list.push(b);
    else byLane.set(b.laneNumber, [b]);
  }
  for (const [lane, list] of byLane) {
    const sorted = [...list].sort((x, y) => x.startMs - y.startMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].startMs >= sorted[i].endMs) break;
        if (sorted[i].reservationId === sorted[j].reservationId) continue;
        hits.push({
          lane,
          a: sorted[i].reservationId,
          b: sorted[j].reservationId,
          atMs: sorted[j].startMs,
        });
      }
    }
  }
  return hits;
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

/**
 * Can we still SELL a long session? The number any rearrangement should be judged by.
 *
 * Lane count is a permutation and cannot be improved by moving anyone. What CAN change is
 * whether some lane stays clear long enough to take a 90 or 120-minute booking. Measured at
 * FM on 2026-08-15 at 17:00: 13 lanes free, none able to host even 90 minutes.
 *
 * Sums over each hour of the trading day, so one bad hour cannot hide behind ten good ones.
 */
function longSessionCapacity(grid: LaneGrid): {
  slots90: number;
  slots120: number;
  worst: { atMs: number; free: number; can120: number };
} {
  let slots90 = 0;
  let slots120 = 0;
  let worst = { atMs: dayStartMs, free: 0, can120: 0, loss: -1 };
  const from = Date.parse(`${DATE}T12:00:00.000-04:00`);
  const to = Date.parse(`${DATE}T23:00:00.000-04:00`);
  for (let t = from; t < to; t += 60 * 60_000) {
    const free = lanesAvailableFor(grid, t, 15);
    const can90 = lanesAvailableFor(grid, t, 90);
    const can120 = lanesAvailableFor(grid, t, 120);
    slots90 += can90;
    slots120 += can120;
    const loss = free - can120;
    if (loss > worst.loss) worst = { atMs: t, free, can120, loss };
  }
  return { slots90, slots120, worst };
}

/** Apply a reservation -> lanes map to a grid in memory, so outcomes can be measured
 *  without writing anything. */
function applyPlacements(
  grid: LaneGrid,
  target: Map<string, number[]>,
  /** Reservations the simulation could not seat. They are NOT on the simulated board, so
   *  leaving them here at their historic lane would re-create the very double-booking the
   *  engine refused to make, and score it against us. */
  omit?: ReadonlySet<string>,
): LaneGrid {
  const seen = new Map<string, number>();
  const busy: BusyInterval[] = grid.busy
    .filter((b) => !omit?.has(b.reservationId))
    .map((b) => {
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

// THE REAL DESIGN: advance bookings keep QAMF's lane, a morning sweep re-solves what is
// known at open, and same-day bookings are pinned as they arrive. This is what actually
// ships, so it is the number that matters.
const sim = simulateDay(
  before,
  { ...DEFAULT_POLICY, moveConquerorBookings: MOVE_DESK },
  { fromMs: dayStartMs, toMs: dayEndMs, laneGroups, nowMs: dayStartMs, dayStartMs },
);
const simGrid = applyPlacements(before, sim.placed, new Set(sim.unplaced));
const cSim = crowdedSingles(simGrid);
const pSim = pairsAtPeak(simGrid);

// SAME-DAY PINS ONLY — the approved FastTrax pilot (owner, 2026-08-25). Pin bookings as they
// arrive; never move anything already on the books. Strictly less invasive than the sweep:
// no `moveReservationLanes` call at all, so no guest's lane changes after they booked.
const simSD = simulateDay(
  before,
  { ...DEFAULT_POLICY, moveConquerorBookings: MOVE_DESK },
  {
    fromMs: dayStartMs,
    toMs: dayEndMs,
    laneGroups,
    nowMs: dayStartMs,
    dayStartMs,
    sweepAdvance: false,
  },
);
const sdGrid = applyPlacements(before, simSD.placed, new Set(simSD.unplaced));
const cSD = crowdedSingles(sdGrid);
const pSD = pairsAtPeak(sdGrid);

// A REFUSAL MUST BE EXPLAINABLE. QAMF seated every one of these in real life, so if our
// arrangement cannot, that is a defect in the arrangement — not a fact about the house.
// Printing the lane group beside the genuinely-free lanes separates the two causes:
// "the house was full" vs "our derived lane group forbade the only free lanes".
if (sim.unplaced.length) {
  console.log(`\n--- COULD NOT SEAT (${sim.unplaced.length}) — QAMF seated all of these ---`);
  const groupsBefore = byReservation(before);
  for (const id of sim.unplaced) {
    const intervals = groupsBefore.get(id);
    if (!intervals) continue;
    const head = intervals[0];
    const s = Math.min(...intervals.map((i) => i.startMs));
    const e = Math.max(...intervals.map((i) => i.endMs));
    const allowed = (head.webOfferId != null && laneGroups.get(head.webOfferId)) || null;
    const anywhere = freeLanes(simGrid, s, e, id, null);
    const inGroup = freeLanes(simGrid, s, e, id, allowed);
    const verdict =
      anywhere.length < intervals.length
        ? "house genuinely full"
        : inGroup.length < intervals.length
          ? "LANE GROUP blocked it — free lanes existed outside the offer's group"
          : "free lanes existed IN group — policy refused them";
    console.log(
      `  ${id.padEnd(9)} ${clock(s)}-${clock(e)} needs ${intervals.length} · was on ${intervals
        .map((i) => i.laneNumber)
        .join("+")} · offer ${head.webOfferId ?? "—"}`,
    );
    console.log(
      `            group [${allowed ? allowed.join(",") : "any"}] · free anywhere [${
        anywhere.join(",") || "none"
      }] · free in group [${inGroup.join(",") || "none"}]  ->  ${verdict}`,
    );
  }
}

// PIN EVERYTHING: kept only as a contrast. Pins bookings made weeks out against a board
// that was empty at the time — the architecture we rejected. Never quote this as "pinning".
const green = replayGreenfield(
  before,
  { ...DEFAULT_POLICY, moveConquerorBookings: MOVE_DESK },
  { fromMs: dayStartMs, toMs: dayEndMs, laneGroups },
);
const greenGrid = applyPlacements(before, green.placed, new Set(green.unplaced));
const cGreen = crowdedSingles(greenGrid);
const pGreen = pairsAtPeak(greenGrid);

const pct = (c: { crowded: number; total: number }) =>
  c.total ? `${c.crowded}/${c.total} (${((c.crowded / c.total) * 100).toFixed(1)}%)` : "0/0";

console.log(`\n--- QUALITY ---`);
console.log(
  `  how the day was booked: ${sim.leftToQamf.length} in advance (QAMF chose the lane) · ` +
    `${sim.pinned.length} same-day pinned (we chose) · ` +
    `${sim.failedOpen.length} same-day failed open (QAMF chose) · ` +
    `${sim.unplaced.length} could not be seated at all`,
);
if (sim.unplaced.length) console.log(`      could not seat: ${sim.unplaced.join(", ")}`);
console.log(`\n  single-lane parties seated against an occupied PAIR-MATE:`);
console.log(`      as booked today               ${pct(cBefore)}`);
console.log(`      sweep only                    ${pct(cAfter)}`);
console.log(`      SAME-DAY PINS ONLY            ${pct(cSD)}   <- THE APPROVED PILOT`);
console.log(`      sweep + same-day pin          ${pct(cSim)}   <- fuller design, later`);
console.log(`      [contrast] pin everything     ${pct(cGreen)}   <- rejected architecture`);
console.log(
  `  whole free pairs at the busiest moment (${clock(pBefore.atMs)}, ${pBefore.used}/${before.lanes.length} lanes used):`,
);
console.log(
  `      as booked ${pBefore.pairs}   ·   sweep only ${pAfter.pairs}   ·   SAME-DAY ONLY ${pSD.pairs}   ·   sweep+pin ${pSim.pairs}   ·   [contrast] pin everything ${pGreen.pairs}`,
);
if (green.unplaced.length) {
  console.log(
    `  ${green.unplaced.length} could not be placed (house genuinely full) — production fails open to QAMF.`,
  );
}

// Long-session capacity — the only capacity metric a permutation can actually move.
{
  const lB = longSessionCapacity(before);
  const lA = longSessionCapacity(after);
  const lG = longSessionCapacity(simGrid);
  const delta = (a: number, b: number) => (b === a ? "same" : b > a ? `+${b - a}` : `${b - a}`);
  console.log(`\n  LONG SESSIONS still sellable (lane-slots summed over 12pm-11pm):`);
  console.log(
    `      90 min   as booked ${String(lB.slots90).padStart(3)}   after sweep ${String(lA.slots90).padStart(3)} (${delta(lB.slots90, lA.slots90)})   THE DESIGN ${String(lG.slots90).padStart(3)} (${delta(lB.slots90, lG.slots90)})`,
  );
  console.log(
    `     120 min   as booked ${String(lB.slots120).padStart(3)}   after sweep ${String(lA.slots120).padStart(3)} (${delta(lB.slots120, lA.slots120)})   THE DESIGN ${String(lG.slots120).padStart(3)} (${delta(lB.slots120, lG.slots120)})`,
  );
  console.log(
    `      worst hour as booked: ${clock(lB.worst.atMs)} — ${lB.worst.free} lanes free, only ${lB.worst.can120} could take 2 hours`,
  );
  console.log(
    `      a permutation cannot change how many lanes are FREE — only whether any stays clear long enough to sell.`,
  );
}

console.log(`\n  LANE COLLISIONS — two parties on one lane. Must match "as booked" (normally 0);`);
console.log(`  anything a rearrangement ADDS is a board we must never apply:`);
for (const [label, g] of [
  ["as booked", before],
  ["sweep only", after],
  ["SAME-DAY ONLY (pilot)", sdGrid],
  ["sweep + same-day pin", simGrid],
  ["[contrast] pin everything", greenGrid],
] as const) {
  const hits = laneCollisions(g);
  const detail = hits
    .slice(0, 3)
    .map((h) => `lane ${h.lane} ${h.a}/${h.b} @ ${clock(h.atMs)}`)
    .join(" · ");
  console.log(
    `      ${label.padEnd(26)} ${String(hits.length).padStart(3)}${detail ? `   ${detail}` : ""}`,
  );
}

console.log(`\n  crowding by how full the house was (the rule is conditional — at 80%+ there is`);
console.log(`  nowhere to spread, so only the quiet band is a fair test of the policy):`);
const bandsBefore = crowdedByPressure(before);
const bandsSim = crowdedByPressure(simGrid);
const bandsGreen = crowdedByPressure(greenGrid);
for (const band of Object.keys(bandsBefore)) {
  console.log(
    `      ${band.padEnd(20)} as booked ${pct(bandsBefore[band]).padEnd(14)}` +
      `THE DESIGN ${pct(bandsSim[band]).padEnd(14)}` +
      `[contrast] pin everything ${pct(bandsGreen[band])}`,
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
