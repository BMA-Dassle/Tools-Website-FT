/**
 * What does the FastTrax floor actually look like RIGHT NOW?
 *
 * The owner's report: a kiosk booking landed on lane 1 while lane 1 was still Open from a
 * finished session, with seven other lanes free. QAMF auto-assigns off the SCHEDULE, which
 * says a lane is free the moment its booked window ends — the physical lane state is a
 * separate read it does not consult. This prints both so the gap is visible.
 *
 * READ-ONLY.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { listLanes } = await import("@/lib/qamf-bowling");
const { toFloorIntervals } = await import("~/features/lane-plan/grid.server");

const CENTER = Number(process.argv[2] ?? 11542);
const now = Date.now();
const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

const lanes = await listLanes(CENTER);
console.log(`=== center ${CENTER} floor at ${clock(now)} ET ===\n`);
console.log("lane  status      closedAt            reservation");
for (const l of lanes) {
  // NOT a scheduled close: every lane reports ~the same instant, Closed ones included, so
  // this is a state-as-of stamp. Do not read a session's end time out of it.
  const closed = l.ClosedAt ? `${l.ClosedAt}` : "—";
  console.log(
    `${String(l.LaneNumber).padStart(4)}  ${String(l.Status).padEnd(10)}  ${closed.padEnd(28)}  ` +
      `${l.Reservation?.Id ?? "(none)"}${l.Status === "Open" ? "   <-- physically OPEN" : ""}`,
  );
}

const live = lanes.map((l) => ({
  laneNumber: l.LaneNumber,
  status: l.Status,
  closedAtMs: l.ClosedAt ? Date.parse(l.ClosedAt) : null,
  reservationId: l.Reservation?.Id ?? null,
}));
const blocked = toFloorIntervals(live, now);
console.log(
  `\nLanes the ENGINE would refuse on floor state alone: ${
    blocked.map((b) => b.laneNumber).join(", ") || "(none)"
  }`,
);
console.log(
  `Lanes QAMF's schedule would call free: whichever have no booked window now — the floor read is NOT consulted.`,
);
