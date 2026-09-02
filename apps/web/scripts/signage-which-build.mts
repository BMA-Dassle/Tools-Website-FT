/**
 * READ-ONLY: which BUILD is each signage screen actually running, and when was it seen?
 *
 * "Is that board on current code?" is the question that wastes an hour every time it is
 * asked, because a deploy does not restart a player — the tab keeps running whatever
 * bundle it loaded, for weeks. `stampSeen` in service/feed.ts records the build sha on
 * every feed poll for exactly this.
 *
 * Usage (from apps/web):  npx tsx scripts/signage-which-build.mts
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

async function main() {
  console.log("connecting…");
  const redis = (await import("../lib/redis")).default;
  const { listSignageScreens } = await import("../src/features/signage/data/signage-screens-db");

  const screens = await listSignageScreens();
  console.log(`${screens.length} screens registered`);
  const now = Date.now();

  console.log("\nscreen     age     build      windowed  name");
  console.log("─".repeat(72));
  for (const s of screens.sort((a, b) => a.screenId.localeCompare(b.screenId))) {
    const raw = await redis.get(`signage:seen:${s.screenId}`).catch(() => null);
    if (!raw) {
      console.log(`${s.screenId.padEnd(10)} ${"—".padEnd(7)} ${"(no heartbeat)".padEnd(10)}          ${s.name ?? ""}`);
      continue;
    }
    let seen: { at?: string; build?: string | null; windowed?: boolean } = {};
    try {
      seen = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof seen);
    } catch {
      /* fall through to blanks */
    }
    const ageS = seen.at ? Math.round((now - Date.parse(seen.at)) / 1000) : null;
    const age = ageS == null ? "?" : ageS < 90 ? `${ageS}s` : `${Math.round(ageS / 60)}m`;
    console.log(
      `${s.screenId.padEnd(10)} ${age.padEnd(7)} ${(seen.build ?? "null").slice(0, 9).padEnd(10)} ` +
        `${(seen.windowed ? "WINDOWED" : "").padEnd(9)} ${s.name ?? ""}`,
    );
  }
  console.log("\nA build that is not the current deploy = that tab has not reloaded.\n");
}

// The redis client holds the event loop open, so exit explicitly rather than hanging.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("probe failed:", e.message);
    process.exit(1);
  });
