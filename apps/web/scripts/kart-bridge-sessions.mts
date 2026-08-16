/**
 * READ-ONLY: the kart bridge's own lifecycle log.
 *
 * Answers the question that used to require Railway access: DID THE BRIDGE HAVE
 * TO RECOVER, or did we restart it?
 *
 *   bootId changes          → the process was replaced (Railway deploy, crash)
 *   bootId same, reconnect# → the socket dropped and the bridge healed itself
 *
 * `reason` names the watchdog that ended the session — "no frame in 45s" is the
 * half-open-socket case that used to need a manual Railway reboot.
 *
 * Populated by kart-timing-bridge → /api/webhooks/kart-bridge-session.
 * Nothing here existed before 2026-08-16; an empty log means the bridge has not
 * redeployed since, NOT that it never restarted.
 *
 *   npx tsx scripts/kart-bridge-sessions.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const redis = (await import("@/lib/redis")).default;

const et = (v: string | null) =>
  v ? new Date(v).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }) : "—";
const dur = (ms: number | null) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

interface Entry {
  event: string;
  bootId: string;
  reconnects: number | null;
  bridgeAt: string | null;
  receivedAt: string | null;
  frames: number | null;
  openMs: number | null;
  healthy: boolean | null;
  reason: string | null;
  nextDelayMs: number | null;
}

const raw = await redis.lrange("kart:bridge:sessions", 0, 399);
if (!raw.length) {
  console.log("kart:bridge:sessions is EMPTY.");
  console.log("Either the bridge has not redeployed since this shipped, or it cannot reach the");
  console.log("session webhook. Check the heartbeat first: kart:bridge:last-event");
  console.log("  last-event =", await redis.get("kart:bridge:last-event"));
  process.exit(0);
}

// LPUSH => index 0 is newest. Walk oldest→newest so boots read in order.
const entries: Entry[] = [];
for (let i = raw.length - 1; i >= 0; i--) {
  try {
    entries.push(JSON.parse(raw[i]) as Entry);
  } catch {
    /* skip */
  }
}

console.log(`${entries.length} lifecycle events (newest last)\n`);
let prevBoot: string | null = null;
for (const e of entries) {
  const when = et(e.bridgeAt ?? e.receivedAt);
  if (e.event === "boot") {
    console.log(`\n=== BOOT ${e.bootId} @ ${when}  (process replaced — deploy or crash) ===`);
    prevBoot = e.bootId;
    continue;
  }
  // A session-end under a bootId we have not seen means we missed its boot
  // report; still a new process, so say so rather than implying self-healing.
  const marker = e.bootId === prevBoot ? "  self-heal" : "  NEW PROCESS";
  prevBoot = e.bootId;
  console.log(
    `${when}  ${marker}  boot=${e.bootId} #${e.reconnects ?? "?"}  ` +
      `up=${dur(e.openMs)} frames=${e.frames ?? "?"} healthy=${e.healthy ?? "?"}  ` +
      `retry=${dur(e.nextDelayMs)}\n      why: ${e.reason ?? "—"}`,
  );
}

const last = entries[entries.length - 1];
const lastAt = last.bridgeAt ?? last.receivedAt;
console.log(
  `\nlast lifecycle event: ${et(lastAt)}` +
    (lastAt ? `  (${dur(Date.now() - new Date(lastAt).getTime())} ago)` : ""),
);
console.log("current heartbeat   :", await redis.get("kart:bridge:last-event"));
process.exit(0);
