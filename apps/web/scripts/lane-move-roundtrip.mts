/**
 * Lane MOVE ROUND-TRIP — prove the write path on one real booking, net zero.
 *
 * Moves ONE of our own reservations to the lane the engine wants, verifies it landed,
 * then moves it straight back and verifies it is exactly where it started. The board ends
 * as it began.
 *
 * MOVE ONLY. `moveReservationLanes` (PATCH /lanes) is the sole mutation. This script never
 * calls `deleteReservation` and never touches the delete+create fallback in
 * qamf-reschedule.ts — a failed PATCH means the booking stays put. Owner rule 2026-08-24.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/lane-move-roundtrip.mts --center 9172 --date 2026-08-29
 *   npx tsx scripts/lane-move-roundtrip.mts --reservation X163651 --center 9172 --apply
 *
 * Without --apply it only previews. With --apply it performs the two PATCHes.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { getReservation, moveReservationLanes, searchReservations, toCenterLocalIso } =
  await import("@/lib/qamf-bowling");
const { buildGrid } = await import("~/features/lane-plan/grid.server");
const { deriveLaneGroups, toLaneGroupMap } = await import("~/features/lane-plan/lane-groups");
const { buildOccupancyForecast } = await import("~/features/lane-plan/forecast");
const { sweepDay } = await import("~/features/lane-plan/policy");
const { DEFAULT_POLICY } = await import("~/features/lane-plan/types");

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const CENTER = Number(flag("center") ?? 9172);
const APPLY = args.includes("--apply");
const EXPLICIT = flag("reservation");
/** The vendor propagates asynchronously and the GET straight after a PATCH echoes the
 *  request, so a same-moment verify false-passes. Always read after a real delay. */
const VERIFY_DELAY_MS = Number(flag("delay") ?? 20_000);

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
const et = (s: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dayStartMs = Date.parse(`${DATE}T09:00:00.000-04:00`);
const nextYmd = ymdEt(new Date(Date.parse(`${DATE}T12:00:00-04:00`) + 86400000));
const dayEndMs = Date.parse(`${nextYmd}T02:00:00.000-04:00`);

console.log(`\n=== LANE MOVE ROUND-TRIP — center ${CENTER} — ${DATE} ===`);
console.log(APPLY ? "MODE: APPLY (two real PATCHes, net zero)\n" : "MODE: preview only\n");

/* ---------- pick the reservation ---------- */

let targetId = EXPLICIT ?? null;
let wantLanes: number[] | null = null;

if (!targetId) {
  console.log("Running the sweep to find a move worth making…");
  const history: Awaited<ReturnType<typeof searchReservations>> = [];
  for (let i = 60; i >= 5; i -= 5) {
    try {
      history.push(
        ...(await searchReservations(
          CENTER,
          toCenterLocalIso(Date.now() - i * 86400000),
          toCenterLocalIso(Date.now() - (i - 5) * 86400000),
        )),
      );
    } catch {
      /* a missing history chunk only weakens the lane groups; keep going */
    }
  }
  const raw = await buildGrid(CENTER, dayStartMs, dayEndMs);
  const grid = { ...raw, forecast: buildOccupancyForecast(history, raw.lanes.length) };
  const { moves } = sweepDay(grid, DEFAULT_POLICY, {
    fromMs: dayStartMs,
    toMs: dayEndMs,
    laneGroups: toLaneGroupMap(deriveLaneGroups(history)),
    nowMs: Date.now(),
    freezeMinutes: 90,
  });
  const ours = moves.filter(
    (m) => m.reservationId.startsWith("X") || m.reservationId.startsWith("K"),
  );
  if (!ours.length) {
    console.log("No move proposed on one of our own bookings — nothing to test. Exiting.");
    process.exit(0);
  }
  targetId = ours[0].reservationId;
  wantLanes = ours[0].to;
  console.log(
    `  picked ${targetId} "${ours[0].title}" — lane ${ours[0].from.join("+")} -> ${ours[0].to.join("+")} (${ours[0].reason})\n`,
  );
}

/* ---------- safety gates ---------- */

const before = await getReservation(CENTER, targetId!, "1.4");
const lanes = before.Lanes ?? [];
console.log(
  `Reservation ${before.Id} — "${before.Title}" · ${before.Status} · ${before.Type?.Description ?? ""}`,
);
for (const l of lanes) {
  console.log(
    `  lane ${l.LaneNumber} · ${l.Status} · ${et(l.StartTime)} -> ${et(l.EndTime)} · id ${l.Id}`,
  );
}

const problems: string[] = [];
if (!before.Id?.startsWith("X") && !before.Id?.startsWith("K")) {
  problems.push("not one of ours (front-desk C-prefix bookings are never touched)");
}
if (!lanes.length) problems.push("no lanes on the reservation");
if (["Arrived", "Completed", "Canceled", "NoShow"].includes(String(before.Status))) {
  problems.push(`reservation status ${before.Status} is not movable`);
}
for (const l of lanes) {
  if (["Running", "Ready", "Completed", "Canceled"].includes(String(l.Status))) {
    problems.push(`lane ${l.LaneNumber} status ${l.Status} is not movable`);
  }
}
const startMs = Math.min(...lanes.map((l) => Date.parse(l.StartTime)));
const hoursOut = (startMs - Date.now()) / 3600_000;
if (hoursOut < 2) problems.push(`starts in ${hoursOut.toFixed(1)}h — too close to touch`);

if (problems.length) {
  console.log(`\nREFUSING:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n  safety: ours, movable, starts in ${hoursOut.toFixed(1)}h — OK`);

/* ---------- work out the target ---------- */

if (!wantLanes) {
  // Explicit reservation with no sweep: shift to the next free lane of the same count.
  const raw = await buildGrid(
    CENTER,
    startMs - 4 * 3600_000,
    Math.max(...lanes.map((l) => Date.parse(l.EndTime))),
  );
  const taken = new Set(
    raw.busy.filter((b) => b.reservationId !== before.Id).map((b) => b.laneNumber),
  );
  const free = raw.lanes.filter((l) => !taken.has(l) && !lanes.some((x) => x.LaneNumber === l));
  wantLanes = free.slice(0, lanes.length);
  if (wantLanes.length < lanes.length) {
    console.log("\nNot enough free lanes to move to. Exiting without writing.");
    process.exit(1);
  }
}

const originalLanes = lanes.map((l) => l.LaneNumber);
console.log(
  `  plan: ${originalLanes.join("+")} -> ${wantLanes.join("+")} -> ${originalLanes.join("+")}\n`,
);

if (!APPLY) {
  console.log("Preview only. Re-run with --apply to perform the round-trip.\n");
  process.exit(0);
}

/* ---------- the round-trip ---------- */

/**
 * Times are passed back VERBATIM from the GET. QAMF returns center-local wall clock with
 * the true offset, which is exactly what the PATCH wants — and reformatting a value that
 * is already correct is pure downside (the wall-clock-read-as-local trap once landed a
 * 15:30 ET booking at 7:30 PM).
 */
const patchTo = (target: number[]) =>
  lanes.map((l, i) => ({
    Id: l.Id,
    LaneNumber: target[i],
    StartTime: l.StartTime,
    EndTime: l.EndTime,
  }));

async function verify(expected: number[], label: string): Promise<boolean> {
  console.log(
    `  waiting ${VERIFY_DELAY_MS / 1000}s before verifying (an immediate GET echoes the request)…`,
  );
  await sleep(VERIFY_DELAY_MS);
  const after = await getReservation(CENTER, targetId!, "1.4");
  const got = (after.Lanes ?? []).map((l) => l.LaneNumber).sort((a, b) => a - b);
  const want = [...expected].sort((a, b) => a - b);
  const ok = got.join(",") === want.join(",");
  console.log(
    `  ${label}: expected ${want.join("+")} · got ${got.join("+")} · ${ok ? "OK" : "MISMATCH"}`,
  );
  // The duration must be untouched — this is a lane swap, never a reschedule.
  for (const l of after.Lanes ?? []) {
    const orig = lanes.find((x) => x.Id === l.Id);
    if (orig && (orig.StartTime !== l.StartTime || orig.EndTime !== l.EndTime)) {
      console.log(`  TIME CHANGED on lane id ${l.Id}: ${et(orig.StartTime)}->${et(l.StartTime)}`);
      return false;
    }
  }
  return ok;
}

let movedOut = false;
try {
  console.log(`STEP 1 — PATCH ${originalLanes.join("+")} -> ${wantLanes.join("+")}`);
  await moveReservationLanes(CENTER, targetId!, patchTo(wantLanes));
  movedOut = true;
  const okOut = await verify(wantLanes, "moved");

  console.log(`\nSTEP 2 — PATCH back ${wantLanes.join("+")} -> ${originalLanes.join("+")}`);
  await moveReservationLanes(CENTER, targetId!, patchTo(originalLanes));
  const okBack = await verify(originalLanes, "restored");
  movedOut = !okBack;

  console.log(
    `\n=== RESULT: move ${okOut ? "WORKED" : "FAILED"} · restore ${okBack ? "WORKED" : "FAILED"} ===`,
  );
  console.log(
    okOut && okBack ? "Board is exactly as we found it.\n" : "CHECK THE BOARD BY HAND.\n",
  );
  process.exit(okOut && okBack ? 0 : 1);
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  if (movedOut) {
    console.error(`Attempting to restore ${targetId} to ${originalLanes.join("+")}…`);
    try {
      await moveReservationLanes(CENTER, targetId!, patchTo(originalLanes));
      const ok = await verify(originalLanes, "restored after failure");
      console.error(ok ? "Restored." : `NOT RESTORED — ${targetId} needs manual attention.`);
    } catch (e2) {
      console.error(
        `RESTORE ALSO FAILED — ${targetId} is on ${wantLanes.join("+")}, expected ${originalLanes.join("+")}. FIX BY HAND.`,
      );
      console.error(e2 instanceof Error ? e2.message : e2);
    }
  } else {
    console.error("Nothing was moved; the booking is untouched.");
  }
  process.exit(1);
}
