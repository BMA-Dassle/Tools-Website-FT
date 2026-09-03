/**
 * Did our refused lane pins leave anything behind?
 *
 * Each failed pinned create is a real POST to QAMF. If the vendor creates the reservation
 * and THEN rejects the lane, we would be littering Temporary holds across the first lanes
 * of every section — which would look to staff exactly like "the first lane is booked and
 * now nothing else can book".
 *
 * READ-ONLY. Lists everything on the board today with what created it and what state it is
 * in, so an orphan is visible rather than inferred.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { searchReservations, toCenterLocalIso } = await import("@/lib/qamf-bowling");

const CENTER = Number(process.argv[2] ?? 9172);
const DATE = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const fromMs = Date.parse(`${DATE}T06:00:00.000-04:00`);
const toMs = Date.parse(`${DATE}T23:59:00.000-04:00`) + 3 * 3600_000;

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

const reservations = await searchReservations(
  CENTER,
  toCenterLocalIso(fromMs),
  toCenterLocalIso(toMs),
);

console.log(`=== centre ${CENTER} · ${DATE} · ${reservations.length} reservations ===\n`);

const byStatus = new Map<string, number>();
const suspects: string[] = [];

for (const r of reservations) {
  const status = String(r.Status ?? "?");
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

  const lanes = (r.Lanes ?? []).map((l) => l.LaneNumber);
  const hasGuest = Boolean(r.Customer?.Guest?.Name);
  const title = (r.Title ?? "").trim();

  // What an orphan from a refused pin would look like: still Temporary, no guest attached,
  // and sitting on one of the low lanes we keep offering.
  const looksOrphaned =
    status === "Temporary" || (!hasGuest && !title) || /^hold \(/i.test(title);

  if (looksOrphaned) {
    const start = Math.min(...(r.Lanes ?? []).map((l) => Date.parse(l.StartTime)));
    suspects.push(
      `  ${r.Id.padEnd(9)} ${status.padEnd(11)} lanes ${lanes.join("+").padEnd(8)} ` +
        `${Number.isFinite(start) ? clock(start) : "?"}  guest=${hasGuest ? "yes" : "NO"}  "${title.slice(0, 30)}"`,
    );
  }
}

console.log("status counts:");
for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${s}`);
}

console.log(`\npossible orphans (Temporary / no guest / "Hold (Np)"): ${suspects.length}`);
if (suspects.length) console.log(suspects.join("\n"));
else console.log("  none — refused pins are not leaving reservations behind");

// What is sitting on the first lane of each section right now.
console.log(`\nfirst-lane occupancy today:`);
for (const lane of [1, 2, 3, 4, 5, 13]) {
  const on = reservations.filter((r) => (r.Lanes ?? []).some((l) => l.LaneNumber === lane));
  console.log(
    `  lane ${String(lane).padStart(2)}  ${on.length} booking(s)` +
      (on.length ? `  ${on.map((r) => `${r.Id}/${r.Status}`).join(" ")}` : ""),
  );
}
