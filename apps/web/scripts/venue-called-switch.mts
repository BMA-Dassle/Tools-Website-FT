/**
 * THE OFF SWITCH for the venue-driven called heat. One command, no deploy.
 *
 * `off` does two things at once, which together are exactly the behaviour that
 * shipped before 2026-08-19:
 *   1. the venue WebSocket stops writing `pandora:last-race:fasttrax:*`, and
 *   2. `races-current-warm` goes back to stepping once a SECOND instead of 30s,
 *      so Pandora is again the only thing deciding which heat is called.
 *
 * Both flip within ~5s of the key changing (each reader memoises the switch for
 * that long). Nothing needs redeploying and no board needs restarting.
 *
 *   npx tsx scripts/venue-called-switch.mts status
 *   npx tsx scripts/venue-called-switch.mts off     # boards look wrong — revert
 *   npx tsx scripts/venue-called-switch.mts on
 *
 * If Redis itself is the problem, the build-time backstop is
 * `VENUE_CALLED_FAST_PATH=false` in Vercel — but that one needs a redeploy, which
 * is why this key exists.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";

const DISABLED_KEY = "venue:called:disabled";
const TRACKS = ["blue", "red", "mega"] as const;
const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 2 });
const et = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

async function status(): Promise<void> {
  const disabled = await redis.get(DISABLED_KEY);
  console.log(
    disabled === null
      ? "fast path: ON — the venue writes the carry, the poll runs at 30s"
      : `fast path: OFF since ${disabled} — Pandora only, poll back at 1s`,
  );
  console.log("\nwhat each rail currently holds:");
  for (const t of TRACKS) {
    const [carryRaw, venueRaw] = await Promise.all([
      redis.get(`pandora:last-race:fasttrax:${t}`),
      redis.get(`venue:called:${t}`),
    ]);
    const carry = carryRaw ? JSON.parse(carryRaw) : null;
    const venue = venueRaw ? JSON.parse(venueRaw) : null;
    console.log(
      `  ${t.padEnd(5)} carry: ${
        carry
          ? `heat ${carry.heatNumber} ${carry.raceType} called ${et(Date.parse(carry.calledAt))}`
          : "—"
      }`,
    );
    console.log(
      `        venue: ${
        venue
          ? `heat ${venue.heatNumber ?? "?"} ${venue.phase} firing(s) ${venue.firings} at ${et(venue.seenAtMs)}`
          : "—"
      }`,
    );
  }
}

const command = process.argv[2] || "status";
switch (command) {
  case "status":
    await status();
    break;
  case "off":
    await redis.set(DISABLED_KEY, new Date().toISOString());
    console.log("fast path OFF — takes effect within ~5s, no deploy needed.\n");
    await status();
    break;
  case "on":
    await redis.del(DISABLED_KEY);
    console.log("fast path ON.\n");
    await status();
    break;
  default:
    console.log("usage: venue-called-switch.mts [status|off|on]");
    process.exit(1);
}

await redis.quit();
process.exit(0);
