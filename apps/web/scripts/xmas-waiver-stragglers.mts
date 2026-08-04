/**
 * The 3 Christmas in July guests whose BMI person record could not be read, so
 * their waiver could NOT be safely backfilled (no readable birthdate = we can't
 * prove they're an adult, and the backfill refuses to guess). Dump everything
 * we know so the front desk can sign them at the kiosk on arrival.
 *
 * Usage (from apps/web): npx tsx scripts/xmas-waiver-stragglers.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SLUG = "xmas-in-july";
const redis = (await import("@/lib/redis")).default;

const targets = [
  "bibianadp@leeschools.net",
  "dclaudio@rocketsoftware.com",
  "hallen@unseenscreens.com",
];

const fmt = (iso?: string) => {
  if (!iso) return "—";
  const tp = iso.replace(/Z$/, "").split("T")[1];
  if (!tp) return iso;
  const [h, m] = tp.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

for (const email of targets) {
  const raw = await redis.get(`groupevent:${SLUG}:rsvp:${email}`);
  if (!raw) {
    console.log(`${email} — no RSVP record\n`);
    continue;
  }
  const r = JSON.parse(raw);
  console.log(`${r.name} <${r.email}>`);
  console.log(`   personId : ${r.personId}`);
  console.log(`   phone    : ${r.phone || "—"}`);
  console.log(`   company  : ${r.company || "—"}`);
  console.log(`   RSVP'd   : ${r.updatedAt}`);
  for (const res of r.reservations || []) {
    console.log(`   booked   : ${res.type}${res.track ? ` · ${res.track} Track` : ""} @ ${fmt(res.time)}${res.billId ? ` (bill ${res.billId})` : ""}`);
  }
  console.log();
}

process.exit(0);
