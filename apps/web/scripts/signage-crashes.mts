/**
 * READ-ONLY: what has thrown on the screens, newest first.
 *
 * The black box recorder for the wall. A panel that crashed used to leave nothing
 * behind but a console nobody reads — this prints the scene, the build, the screen
 * and the stack for anything that has thrown in the last week.
 *
 * "scene" = one scene was skipped and the panel kept running.
 * "route" = the whole panel went down and reloaded itself.
 *
 * Usage (from apps/web):  npx tsx scripts/signage-crashes.mts [count]
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const limit = Number(process.argv[2]) || 20;

async function main() {
  const { readCrashes } = await import("../src/features/signage/crash-log.server");
  const crashes = await readCrashes(limit);

  if (crashes.length === 0) {
    console.log("\nNo crashes recorded. (Nothing has thrown, or nothing has run the reporting build.)\n");
    return;
  }

  console.log(`\n${crashes.length} crash(es), newest first:\n`);
  for (const c of crashes) {
    const where = c.origin === "route" ? "ROUTE (panel rebooted)" : `scene:${c.scene ?? "?"}`;
    console.log("─".repeat(78));
    console.log(`${c.at}  ${c.screen ?? "?"}  build=${c.build ?? "?"}  ${where}`);
    console.log(`  ${c.message}`);
    if (c.digest) console.log(`  digest ${c.digest}`);
    if (c.stack) {
      // The top frames are the ones that name something; the rest is React.
      for (const line of c.stack.split("\n").slice(1, 7)) console.log(`    ${line.trim()}`);
    }
  }
  console.log("─".repeat(78));
  console.log("\nStacks are minified in production — the message and the scene are the signal.\n");
}

// The redis client holds the event loop open, so exit explicitly rather than hanging.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("read failed:", e.message);
    process.exit(1);
  });
