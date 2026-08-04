/**
 * One-shot probe: is QAMF web offer 166 ("Midnight Madness VIP API Closing",
 * OpenType Unlimited) working at HeadPinz Fort Myers for TONIGHT 1:00 AM
 * (2026-08-02T01:00 ET — Sat-night business day, 2 AM close)?
 *
 * Steps: availability point search at 1 AM → create a Temporary hold on
 * offer 166 → read back → DELETE (finally block). Never confirms; QAMF's
 * ~10-min Temporary TTL is the crash backstop.
 *
 * Uses @/lib/qamf-bowling directly — the repo's standard scripting pattern
 * (auth handled by the lib). Run from apps/web:
 *   npx tsx scripts/offer166-1am-probe.mts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
try {
  const raw = readFileSync(resolve(APP_ROOT, ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  /* rely on ambient env */
}

const { searchAvailability, createReservation, getReservation, deleteReservation } = await import(
  "@/lib/qamf-bowling"
);

const CENTER = 9172; // HeadPinz Fort Myers
const OFFER_ID = 166; // Midnight Madness VIP API Closing (Unlimited option 166)
const BOOKED_AT = "2026-08-02T01:00:00-04:00"; // tonight 1 AM ET (Sat-night tail)
const PROBE_TITLE = "ZZZ API PROBE - auto-deletes";
const PLAYERS = 2;

console.log(`PROBE: offer ${OFFER_ID} @ Fort Myers (${CENTER}) for ${BOOKED_AT}\n`);

// [1] availability point search — does QAMF list offer 166 at 1 AM?
const avail = await searchAvailability(CENTER, {
  BookedAtRange: { StartAt: BOOKED_AT, EndAt: BOOKED_AT },
  TotalPlayers: PLAYERS,
  WebOffer: { Services: ["BookForLater"] },
});
const entries = avail.Availabilities ?? [];
const offerIds = [...new Set(entries.map((a) => String(a.WebOffer?.Id)))];
console.log(`[1] availability @ 1 AM: ${entries.length} entries, offers: [${offerIds.join(", ")}]`);
console.log(`    offer ${OFFER_ID} listed: ${offerIds.includes(String(OFFER_ID)) ? "YES" : "NO"}`);

// [2] create Temporary hold on offer 166 (QAMF is the authority — try even if
// the availability listing omitted it).
console.log(`\n[2] createReservation (Temporary, "${PROBE_TITLE}")`);
let created;
try {
  created = await createReservation(CENTER, {
    BookedAt: BOOKED_AT,
    Title: PROBE_TITLE,
    Notes: "offer166-1am-probe — verifying offer 166 books at 1 AM",
    WebOffer: { Id: OFFER_ID, Options: { Unlimited: [{ Id: 166 }] }, Services: ["BookForLater"] },
    TotalPlayers: PLAYERS,
  });
} catch (err) {
  console.log(`    create FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.log("\nVERDICT: offer 166 is NOT bookable at 1 AM tonight (error above).");
  process.exit(0);
}
console.log(`    Id: ${created.Id}  Status: ${created.Status}  ExpiresAt: ${created.ExpiresAt}`);
console.log(`    Lanes: ${JSON.stringify(created.Lanes?.map((l) => l.LaneNumber))}`);

// [3] read back, then always delete
try {
  const back = await getReservation(CENTER, created.Id);
  console.log(
    `\n[3] read-back: Status=${back.Status} BookedAt=${back.BookedAt} players=${back.TotalPlayers} offer=${back.WebOffer?.Id}`,
  );
  console.log(`\nVERDICT: offer ${OFFER_ID} WORKS at 1 AM tonight — hold ${created.Id} created; deleting now.`);
} finally {
  try {
    await deleteReservation(CENTER, created.Id);
    console.log(`    DELETE ${created.Id} -> ok (cleaned up)`);
  } catch (err) {
    console.log(
      `    DELETE ${created.Id} FAILED (${err instanceof Error ? err.message : String(err)}) — QAMF's ~10-min Temporary TTL will expire it.`,
    );
  }
}
process.exit(0);
