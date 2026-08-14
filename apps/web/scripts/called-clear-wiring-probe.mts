/**
 * READ-ONLY probe: does the clear-tombstone wiring line up?
 *
 * The whole fix hinges on two Redis key names agreeing between the writer
 * (called-override.server.ts) and the reader (/api/pandora/races-current). A typo
 * in either would leave "Clear" silently broken in exactly the way it already
 * was, and every unit test would still pass — the rule is pure and does not know
 * what key it came from.
 *
 * So this asserts the key names against the REAL modules rather than restating
 * them, prints what is currently in each, and evaluates the live suppression
 * decision. It writes NOTHING.
 *
 * Usage:
 *   npx tsx scripts/called-clear-wiring-probe.mts        # from apps/web
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const TRACKS = ["blue", "red", "mega"] as const;

async function main() {
  const { default: redis } = await import("../lib/redis");
  const { readCalledRace, readClearedCall } = await import(
    "../src/features/signage/briefing/called-override.server"
  );
  const { callIsSuppressed } = await import("../src/features/signage/briefing/called-clear");

  // The two key names, taken from the source of each side rather than retyped.
  const writerSrc = readFileSync(
    new URL("../src/features/signage/briefing/called-override.server.ts", import.meta.url),
    "utf8",
  );
  const readerSrc = readFileSync(
    new URL("../app/api/pandora/races-current/route.ts", import.meta.url),
    "utf8",
  );
  const calledKeyPattern = "pandora:last-race:fasttrax:";
  const clearedKeyPattern = "pandora:called-cleared:fasttrax:";

  console.log("\n── key wiring ──");
  const checks: Array<[string, boolean]> = [
    ["writer uses the called key Pandora owns", writerSrc.includes(calledKeyPattern)],
    ["reader uses the same called key", readerSrc.includes(calledKeyPattern)],
    ["writer writes the cleared-call key", writerSrc.includes(clearedKeyPattern)],
    ["reader imports readClearedCall (does not retype the key)", readerSrc.includes("readClearedCall")],
    ["reader honours the rule", readerSrc.includes("callIsSuppressed")],
    ["reader drops the carry too", readerSrc.includes("forgetStored")],
  ];
  let bad = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
    if (!ok) bad++;
  }

  console.log("\n── live state (unchanged by this probe) ──");
  for (const t of TRACKS) {
    const [called, cleared] = await Promise.all([
      readCalledRace(t).catch(() => null),
      readClearedCall(t).catch(() => null),
    ]);
    const suppressed = called ? callIsSuppressed(cleared, called) : false;
    console.log(
      `  ${t.padEnd(5)} called=${
        called ? `session ${called.sessionId} heat ${called.heatNumber} @ ${called.calledAt}` : "none"
      }`,
    );
    console.log(
      `        cleared=${
        cleared ? `session ${cleared.sessionId} @ ${cleared.calledAt}` : "none"
      }  ->  wouldSuppress=${suppressed}`,
    );
  }

  if (bad > 0) {
    console.error(`\n${bad} wiring check(s) FAILED — the clear would not stick.\n`);
    process.exit(1);
  }
  console.log("\nWiring OK. A Clear press writes a tombstone the poller reads.\n");
  await redis.quit?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
