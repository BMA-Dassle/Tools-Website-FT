/**
 * bmi-scan-live-integration — LIVE, READ-ONLY.
 *
 * Runs the two changed modules end to end, for real:
 *
 *   1. scanForNewEvents() from lib/bmi-scan — the caller that was sending
 *      `scan-${Date.now()}` every 60 seconds and is now on a stable id. This is
 *      the exact code path BMI Office is complaining about, so running it is
 *      the only way to know the change holds where it matters.
 *   2. The daily-events Office client reads (getMetadataLookups /
 *      getLiveReservations), whose apiHeaders now defaults to the stable id.
 *
 * WRITE SAFETY. scanForNewEvents is reads only — metadata, dayPlanner, Pandora
 * reservation detail/products, project and person lookups. The WRITES for group
 * functions live in the group-quote-dispatch cron (contract emails, BMI state
 * moves, Square orders) and this script never touches it. The daily-events
 * write rail (officePut on projectLog) is likewise not called.
 *
 * COST: the scan is 12 monthly dayPlanner windows x 2 centers = ~24 heavy
 * reads, i.e. about one minute of what the every-minute cron already spends.
 * One run, deliberately, while BMI is saturated.
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-scan-live-integration.ts
 */

import { scanForNewEvents } from "../lib/bmi-scan";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`   FAIL  ${m}`);
};
const pass = (m: string) => console.log(`   ok    ${m}`);

async function main() {
  console.log("BMI scan + daily-events reads — live integration (READ-ONLY)\n");

  // ── 1. The real scan ────────────────────────────────────────────
  console.log("── 1. scanForNewEvents() — stable scan-{clientKey} id ───");
  const t0 = Date.now();
  let items: Awaited<ReturnType<typeof scanForNewEvents>>;
  try {
    items = await scanForNewEvents();
  } catch (err) {
    fail(`scanForNewEvents threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const ms = Date.now() - t0;
  // The per-center "[bmi-scan] {ck}: N total, M in send-contract state(s)" lines
  // above are the proof the 24 dayPlanner reads all landed. A throw or an auth
  // rejection on the stable id could not have produced them.
  pass(`scan completed in ${(ms / 1000).toFixed(1)}s, ${items.length} item(s) in Send Contract`);
  if (ms > 60_000) {
    console.log(
      `   NOTE  ${(ms / 1000).toFixed(1)}s exceeds the 60s Vercel default — this run would have` +
        ` been killed mid-flight in production, which is the overlap/abandonment` +
        ` problem still open (separate from session ids).`,
    );
  }
  for (const it of items.slice(0, 5)) {
    console.log(`         · ${it.event.number} "${it.event.name}" ${it.centerName}`);
  }

  // ── 2. daily-events reads ───────────────────────────────────────
  console.log("\n── 2. daily-events client — stable events-{clientKey} id ──");
  try {
    const { getMetadataLookups, getLiveReservations } =
      await import("../src/features/daily-events/data/bmi-office");
    // Redis-cached 2h, so this may not touch Office at all — reported, not trusted.
    const lookups = await getMetadataLookups("headpinzftmyers");
    const keys = Object.keys(lookups ?? {});
    if (keys.length) {
      console.log(`   ·     getMetadataLookups → ${keys.length} table(s) (may be Redis-cached)`);
    } else {
      fail("getMetadataLookups returned nothing");
    }

    // This one always hits Office, so it is the call that actually exercises the
    // stable events-{clientKey} session id through the real client.
    const today = new Date().toISOString().slice(0, 10);
    const live = await getLiveReservations("headpinzftmyers", today, lookups);
    pass(`getLiveReservations (uncached Office read) → ${live.length} reservation(s) for ${today}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Redis/env gaps are environmental, not a session-id regression — say which.
    if (/redis|ECONNREFUSED|UPSTASH|ENOTFOUND/i.test(msg)) {
      console.log(`   ?     daily-events needs cache env locally: ${msg.slice(0, 120)}`);
    } else {
      fail(`daily-events reads: ${msg.slice(0, 200)}`);
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — live integration complete`);
}

main()
  .then(() => {
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((e) => {
    console.error("crashed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The token cache and daily-events both hold the shared ioredis client, and
    // its socket is still closing when the process ends. process.exit() there
    // trips a libuv assertion on Windows AFTER a clean PASS, which reads like a
    // failed run. Close it and let the loop drain instead of exiting hard.
    try {
      const { default: redis } = await import("@/lib/redis");
      redis.disconnect();
    } catch {
      // Nothing to close.
    }
  });
