/**
 * Mint synthetic HP Arena tickets straight into Redis so the arena
 * /t/{id} and /g/{id} views can be verified without waiting for the
 * cron (PR-2 verification step in the rollout plan).
 *
 * Usage (from apps/web, REDIS_URL from .env.local):
 *   node scripts/mint-test-arena-ticket.mjs                 # pre-session laser tag, single
 *   node scripts/mint-test-arena-ticket.mjs --state past    # session 2h ago
 *   node scripts/mint-test-arena-ticket.mjs --state moved   # superseded ticket
 *   node scripts/mint-test-arena-ticket.mjs --activity gel-blaster
 *   node scripts/mint-test-arena-ticket.mjs --group         # 3-player group ticket
 *   node scripts/mint-test-arena-ticket.mjs --session 50440549 --person 123456
 *
 * To exercise the CheckedIn state, pass a REAL sessionId/personId from
 * a live arena session whose participant has checkedIn set (the view
 * polls /api/pandora/session-participants for it). Synthetic ids
 * exercise PreSession/Past/Moved/group layouts only — the participants
 * poll returns empty for them, which the view treats as "trust prior
 * state" (forgiving), so onSession stays true.
 *
 * Tickets expire in 12h (same TTL as the cron's).
 */
import Redis from "ioredis";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";

// Minimal .env.local loader — avoids a dotenv dependency.
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env.local — rely on the shell env */
}

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const state = argOf("--state", "pre"); // pre | past | moved
const activitySlug = argOf("--activity", "laser-tag"); // laser-tag | gel-blaster
const group = args.includes("--group");
const sessionId = argOf("--session", "99000001");
const personId = argOf("--person", "99000002");

const ACTIVITY_DISPLAY = { "laser-tag": "Laser Tag", "gel-blaster": "Gel Blaster" };
const track = ACTIVITY_DISPLAY[activitySlug];
if (!track) {
  console.error(`Unknown --activity "${activitySlug}" (laser-tag | gel-blaster)`);
  process.exit(1);
}

const HP_FM_LOCATION_ID = "TXBSQN0FEKQ11";
const TICKET_TTL = 60 * 60 * 12;

const offsetMs = state === "past" ? -2 * 60 * 60 * 1000 : 90 * 60 * 1000; // -2h or +90min
const scheduledStart = new Date(Date.now() + offsetMs).toISOString();

function newId() {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

const base = {
  locationId: HP_FM_LOCATION_ID,
  scheduledStart,
  track,
  raceType: track,
  heatNumber: 7,
  activity: activitySlug,
  brand: "headpinz",
};

async function main() {
  if (group) {
    const id = newId();
    const record = {
      id,
      phone: "+15555550100",
      locationId: HP_FM_LOCATION_ID,
      brand: "headpinz",
      createdAt: new Date().toISOString(),
      recipient: "guardian",
      guardianFirstName: "Taylor",
      members: [
        {
          ...base,
          sessionId,
          personId,
          participantId: "99000010",
          firstName: "Avery",
          lastName: "Test",
        },
        {
          ...base,
          sessionId,
          personId: "99000003",
          participantId: "99000011",
          firstName: "Riley",
          lastName: "Test",
        },
        {
          ...base,
          sessionId: String(Number(sessionId) + 1),
          personId: "99000004",
          participantId: "99000012",
          firstName: "Jordan",
          lastName: "Test",
          activity: "gel-blaster",
          track: "Gel Blaster",
          raceType: "Gel Blaster",
          heatNumber: 11,
          scheduledStart: new Date(Date.now() + offsetMs + 60 * 60 * 1000).toISOString(),
        },
      ],
    };
    await redis.set(`group:${id}`, JSON.stringify(record), "EX", TICKET_TTL);
    console.log(`Minted GROUP ticket: /g/${id}`);
    console.log(`  3 players, ${state === "past" ? "past" : "upcoming"} sessions`);
  } else {
    const id = newId();
    const ticket = {
      ...base,
      sessionId,
      personId,
      participantId: "99000010",
      firstName: "Avery",
      lastName: "Test",
      phone: "+15555550100",
      ...(state === "moved"
        ? {
            movedTo: {
              ticketId: "AAAAAAAA",
              group: false,
              sessionId: String(Number(sessionId) + 1),
              heatNumber: 9,
              track,
              raceType: track,
              scheduledStart: new Date(Date.now() + offsetMs + 45 * 60 * 1000).toISOString(),
            },
          }
        : {}),
    };
    await redis.set(`ticket:${id}`, JSON.stringify(ticket), "EX", TICKET_TTL);
    console.log(`Minted SINGLE ${track} ticket (${state}): /t/${id}`);
  }
  console.log(`  sessionId=${sessionId} personId=${personId}`);
  console.log(
    "  Open on http://localhost:3000 (FT chrome) AND with Host=headpinz.com / prod headpinz.com to verify brand handling.",
  );
  await redis.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
