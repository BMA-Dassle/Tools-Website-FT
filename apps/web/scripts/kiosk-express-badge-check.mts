/**
 * READ-ONLY verification for the kiosk check-in "Express lane" badge.
 *
 * The kiosk browse list used to badge EVERY racing row as Express Lane (it
 * gated on `kind === "racing"`, not on eligibility), so guests who genuinely
 * had to check in were told to skip it. This probe runs the SAME grouping the
 * browse list does — minus the ±3h window, so it works at any hour — and prints
 * the express decision per reservation with the reason, so we can eyeball that
 * the badge now differentiates instead of blanket-applying.
 *
 * Usage (from apps/web):  npx tsx scripts/kiosk-express-badge-check.mts [YYYY-MM-DD] [center]
 *   center = fort-myers (default) | naples
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { listBowlingReservations } = await import("@/lib/bowling-db");
const { displayNameFromFull } = await import("@/lib/display-name");
const { default: redis } = await import("@/lib/redis");
const { isExpressBooking } = await import("~/features/kiosk/checkin/express");

const CENTER_CODES: Record<string, string[]> = {
  "fort-myers": ["TXBSQN0FEKQ11", "LAB52GY480CJF", "fort-myers", "fasttrax"],
  naples: ["PPTR5G2N0QXF7", "naples"],
};

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const center = process.argv[3] || "fort-myers";
console.log(`\nExpress-lane badge check — ${center} — ${date}\n${"─".repeat(78)}`);

const rows = await listBowlingReservations({
  startDate: date,
  endDate: date,
  centerCodes: CENTER_CODES[center],
});

interface Grp {
  billId: string;
  kinds: Set<string>;
  guestName: string;
  earliest: string;
}
const groups = new Map<string, Grp>();
for (const row of rows) {
  if (row.status === "cancelled" || row.status === "no_show") continue;
  if (row.bookingSource === "kiosk") continue;
  const evt = row.eventAt || row.bookedAt || "";
  const billId = row.bmiBillId;
  if (!billId) continue;
  const g = groups.get(billId);
  if (g) {
    g.kinds.add(row.productKind);
    if (!g.guestName && row.guestName) g.guestName = row.guestName;
    if (evt < g.earliest) g.earliest = evt;
  } else {
    groups.set(billId, {
      billId,
      kinds: new Set([row.productKind]),
      guestName: row.guestName ?? "",
      earliest: evt,
    });
  }
}

let express = 0;
let normal = 0;
for (const g of [...groups.values()].sort((a, b) => a.earliest.localeCompare(b.earliest))) {
  if (!g.kinds.has("race")) continue; // racing check-in only, same as the list
  const racingOnly = g.kinds.size === 1;
  const raw = await redis.get(`bookingrecord:${g.billId}`).catch(() => null);
  const record = raw
    ? (JSON.parse(raw) as { fastLane?: boolean; racers?: Array<{ personId?: string | null }> })
    : null;
  const isExpress = isExpressBooking({ record, racingOnly });
  const racers = record?.racers ?? [];
  const unresolved = racers.filter((r) => !r.personId).length;
  const why = !racingOnly
    ? `combo (${[...g.kinds].join("+")}) — still needs the kiosk`
    : !record
      ? "no booking record (phone/office booking or evicted)"
      : record.fastLane !== true
        ? "fastLane not set at checkout"
        : racers.length === 0
          ? "no racers on the record"
          : unresolved > 0
            ? `${unresolved}/${racers.length} racer(s) with no personId → must see Guest Services`
            : `all ${racers.length} racer(s) resolved + waiver on file`;
  if (isExpress) express++;
  else normal++;
  console.log(
    `${isExpress ? "⚡ EXPRESS " : "   check-in"}  ${(g.guestName ? displayNameFromFull(g.guestName) : "Guest").padEnd(16)} ${g.earliest.slice(11, 16)}  ${why}`,
  );
}

console.log(
  `${"─".repeat(78)}\n${express} express (badge shown, no OTP) · ${normal} normal check-in (no badge)\n` +
    `Pre-fix behaviour: all ${express + normal} racing rows showed the badge.\n`,
);
process.exit(0);
