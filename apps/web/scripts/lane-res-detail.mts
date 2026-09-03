/** What exactly is one reservation holding, and when? READ-ONLY. */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { getReservation } = await import("@/lib/qamf-bowling");

const CENTER = Number(process.argv[2] ?? 9172);
const ID = process.argv[3];
if (!ID) throw new Error("usage: lane-res-detail.mts <centerId> <reservationId>");

const fmt = (s?: string) =>
  s
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(s))
    : "?";

const r = await getReservation(CENTER, ID);
console.log(`=== ${r.Id} ===`);
console.log(`  status     ${r.Status}`);
console.log(`  title      ${r.Title ?? "—"}`);
console.log(`  type       ${r.Type?.Description ?? "—"}`);
console.log(`  players    ${r.TotalPlayers ?? "?"}`);
console.log(`  offer      ${r.WebOffer?.Id ?? "— (no web offer: front-desk / Conqueror)"}`);
console.log(`  bookedAt   ${fmt(r.BookedAt)}`);
console.log(`  lanes      ${(r.Lanes ?? []).length}`);
for (const l of r.Lanes ?? []) {
  console.log(`    lane ${String(l.LaneNumber).padStart(2)}  ${fmt(l.StartTime)} -> ${fmt(l.EndTime)}  ${l.Status}`);
}
