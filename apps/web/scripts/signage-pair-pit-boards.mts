/**
 * Put the two pit-assignment boards in ONE pairing group.
 *
 * Blue takes position 0 and Red position 1, which is the estate's existing
 * convention (the check-in boards are grouped the same way) and the one the
 * two-monitor launcher reads: position 0 is the LEFT monitor. Grouping them is
 * what makes the admin page offer "Download 2-monitor script" at all, and it is
 * the hook composed content hangs off later — a message split across both pit
 * boards works the same way the birthday takeover already does.
 *
 * IMPORTS THE APP'S OWN WIRING rather than hand-writing SQL: `saveSignageScreen`
 * is the exact write path the admin form uses, and the config is the screen's
 * OWN stored config with `pairing` added — nothing else is touched. A script
 * that rebuilds the config from a preset would silently discard whatever was
 * tuned on the wall (overscan, scope, interrupts).
 *
 * Usage:
 *   npx tsx apps/web/scripts/signage-pair-pit-boards.mts            # dry run
 *   npx tsx apps/web/scripts/signage-pair-pit-boards.mts --apply    # write
 *
 * Idempotent: re-running re-asserts the same two rows.
 */
import { readFileSync } from "node:fs";

// Env from .env.local, the house way — no dotenv dependency. Must run BEFORE the
// dynamic imports below, because @ft/db reads DATABASE_URL when it initialises.
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

/** The group name is stable and descriptive — it shows up in configs forever. */
const GROUP_ID = "ft-pit";

async function main() {
  const { listSignageScreens, saveSignageScreen } = await import(
    "../src/features/signage/data/signage-screens-db"
  );
  const { resolvePair } = await import("../src/features/signage/pairing");

  const screens = await listSignageScreens();

  // Found by ROLE, not by hardcoded id: the pit boards are whichever screens run
  // the pit-board scene, so this still does the right thing if they are ever
  // renumbered. Blue/Red is read off the name, which is how staff refer to them.
  const pitBoards = screens.filter((s) =>
    (s.config.playlist ?? []).some((p) => p.scene === "pit-board"),
  );

  console.log(`\n── pit-board screens found (${pitBoards.length}) ──`);
  for (const s of pitBoards) {
    const p = s.config.pairing;
    console.log(
      `  ${s.screenId.padEnd(8)} ${(s.name || "(unnamed)").padEnd(24)} pairing=${
        p ? `${p.groupId}#${p.position}/${p.count}` : "none"
      }`,
    );
  }

  if (pitBoards.length !== 2) {
    console.error(
      `\nExpected exactly 2 pit boards, found ${pitBoards.length}. Not guessing which two share a PC — group them by hand on the admin page.`,
    );
    process.exit(1);
  }

  const blue = pitBoards.find((s) => /blue/i.test(s.name));
  const red = pitBoards.find((s) => /red/i.test(s.name));
  if (!blue || !red || blue.screenId === red.screenId) {
    console.error(
      `\nCould not tell Blue from Red by name (${pitBoards.map((s) => s.name).join(", ")}). Left/right has to be deliberate, so this refuses to pick.`,
    );
    process.exit(1);
  }

  // Blue LEFT (position 0), Red RIGHT (position 1) — owner 2026-08-14.
  const plan = [
    { screen: blue, position: 0, side: "left" },
    { screen: red, position: 1, side: "right" },
  ];

  console.log(`\n── plan (group "${GROUP_ID}") ──`);
  for (const { screen, position, side } of plan) {
    console.log(`  ${screen.screenId} ${screen.name} -> position ${position} (${side} monitor)`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.\n");
    return;
  }

  for (const { screen, position } of plan) {
    await saveSignageScreen({
      screenId: screen.screenId,
      venue: screen.venue,
      center: screen.center,
      screenNumber: screen.screenNumber,
      name: screen.name,
      // Spread the STORED config so nothing tuned on the wall is lost.
      config: {
        ...screen.config,
        pairing: { groupId: GROUP_ID, position, count: 2 },
      },
    });
    console.log(`  wrote ${screen.screenId} (position ${position})`);
  }

  // Assert the thing we actually care about, not just that the writes returned.
  const after = await listSignageScreens();
  const pair = resolvePair(after, blue.screenId);
  if (!pair) {
    console.error("\nFAILED: the group does not resolve to exactly two screens after writing.");
    process.exit(1);
  }
  if (pair.left.screenId !== blue.screenId || pair.right.screenId !== red.screenId) {
    console.error(
      `\nFAILED: resolved left=${pair.left.screenId} right=${pair.right.screenId}, expected left=${blue.screenId} right=${red.screenId}.`,
    );
    process.exit(1);
  }
  console.log(
    `\nOK: ${pair.left.screenId} (${pair.left.name}) is LEFT, ${pair.right.screenId} (${pair.right.name}) is RIGHT.`,
  );
  console.log("The admin page will now offer 'Download 2-monitor script' on both rows.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
