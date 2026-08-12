/**
 * The SMS-Timing frame, read for RESULTS — names and best laps — rather than
 * for the clock (that half lives in live-session.tsx, which deliberately skips
 * the driver array).
 *
 * The wire shape, verified against a LIVE finished heat on 2026-08-11 (Mega
 * heat 66, S:4, captured off the real socket):
 *
 *   { N: "[HEAT] 66 - Mega Pro", S: 4, C: 0, D: [
 *       { N: "Kenny rosencrans", B: 63360, A: 64644, T: 63360,
 *         K: "13", L: 6, P: 1, G: "", D: 58509204, R: 5, M: 0, LP: 0 } ] }
 *
 * Per driver: N display name (exactly what /leaderboards shows — the owner's
 * direction is to use these names AS-IS, no BMI person matching), B best lap
 * in ms (0 = no lap set), K kart number, L laps done, P position. The frame
 * keeps serving the FINISHED race's standings until staff load the next heat —
 * that after-window is what end-of-race capture rides.
 *
 * PURE — every decision in the capture chain that can be unit-tested lives
 * here, so the only untestable part is the socket itself.
 */

export interface ResultsDriver {
  /** Display name verbatim from the timing system. */
  name: string;
  /** Best lap in milliseconds; null when the driver never set a lap. */
  bestMs: number | null;
  kart: string;
  laps: number;
  position: number;
}

export interface ResultsFrame {
  /** Heat number parsed from the frame's name, e.g. 66 from "[HEAT] 66 - Mega Pro". */
  heatNumber: number | null;
  /** The frame's raw name with the [HEAT] marker humanised, for logs/UI. */
  heatName: string;
  /** 1 running · 2 paused · >=3 finished — same reading live-session.tsx uses. */
  state: number;
  drivers: ResultsDriver[];
}

/** "{}" (no race), unparseable, or driverless frames all return null — a
 *  capture that has nothing to record must be indistinguishable from no
 *  capture at all. */
export function parseResultsFrame(raw: unknown): ResultsFrame | null {
  if (typeof raw !== "string" || raw === "{}") return null;
  try {
    const data = JSON.parse(raw) as { N?: unknown; S?: unknown; D?: unknown };
    if (!Array.isArray(data.D) || data.D.length === 0) return null;
    const heatName = typeof data.N === "string" ? data.N : "";
    const drivers: ResultsDriver[] = [];
    for (const entry of data.D as Array<Record<string, unknown>>) {
      const name = typeof entry.N === "string" ? entry.N.trim() : "";
      if (!name) continue; // a nameless row is timing-system noise, not a racer
      const best = typeof entry.B === "number" && Number.isFinite(entry.B) ? entry.B : 0;
      drivers.push({
        name,
        bestMs: best > 0 ? best : null,
        kart: typeof entry.K === "string" ? entry.K : "",
        laps: typeof entry.L === "number" ? entry.L : 0,
        position: typeof entry.P === "number" ? entry.P : 0,
      });
    }
    if (drivers.length === 0) return null;
    drivers.sort((a, b) => a.position - b.position);
    return {
      heatNumber: parseHeatNumber(heatName),
      heatName: heatName.replace("[HEAT]", "Heat").trim(),
      state: typeof data.S === "number" ? data.S : 0,
      drivers,
    };
  } catch {
    return null;
  }
}

/** "[HEAT] 66 - Mega Pro" → 66. Group events and custom races carry arbitrary
 *  names; those return null and the heat-match gate skips them — recording a
 *  race we cannot prove is ours would be worse than recording nothing. */
export function parseHeatNumber(heatName: string): number | null {
  const m = /\[HEAT\]\s*(\d+)/.exec(heatName);
  return m ? Number(m[1]) : null;
}

/**
 * The split the welcome-back board shows: who beat the qualifying time and who
 * didn't. `targetMs` null (Pro / Mega — no next level) means no split: everyone
 * lands in `standings` order and the board shows plain results instead.
 */
export interface ResultsSplit {
  levelledUp: ResultsDriver[];
  keepPushing: ResultsDriver[];
}

export function splitByTarget(drivers: ResultsDriver[], targetMs: number | null): ResultsSplit {
  if (targetMs === null) return { levelledUp: [], keepPushing: [...drivers] };
  const levelledUp: ResultsDriver[] = [];
  const keepPushing: ResultsDriver[] = [];
  for (const d of drivers) {
    // Strictly at-or-under, matching the level-up rule: the target IS the time
    // to beat. A driver with no lap at all cannot have qualified.
    if (d.bestMs !== null && d.bestMs <= targetMs) levelledUp.push(d);
    else keepPushing.push(d);
  }
  return { levelledUp, keepPushing };
}
