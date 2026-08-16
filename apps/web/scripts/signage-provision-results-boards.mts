/**
 * Provision the two race RESULTS screens (Blue and Red).
 *
 * The sibling of signage-provision-briefing-cams.mts, and the same discipline:
 * IMPORTS THE APP'S OWN WIRING rather than hand-writing SQL or a config blob.
 * `rolePreset("results-board")` is the exact config the admin form would save
 * (single `race-results` scene, every interrupt off), and `saveSignageScreen`
 * is the exact write path — so this cannot drift from the form.
 *
 * Each screen gets ONE track. Heat numbers repeat across tracks (Blue 59 and
 * Red 59 are different races), so a board with no track is a board that cannot
 * say which race it is reporting — hence `resultsBoard.track` rather than the
 * shared `scope.resourceIds` the check-in boards use. Scope also decides which
 * scan events reach a screen, and a scores wall has no business lighting up
 * because somebody checked in for the next heat.
 *
 * Usage:
 *   npx tsx apps/web/scripts/signage-provision-results-boards.mts            # dry run
 *   npx tsx apps/web/scripts/signage-provision-results-boards.mts --apply    # write
 *
 * Idempotent: matched by the board's track, and saveSignageScreen upserts on
 * screen_id, so re-running re-asserts the same two rows — never a duplicate and
 * never a new id for a TV already on a wall.
 */
import { readFileSync } from "node:fs";

// Env from .env.local, the house way — no dotenv dependency. Must run BEFORE the
// dynamic imports below, because the db layer reads DATABASE_URL on init.
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

const BOARDS = [
  { track: "blue" as const, name: "Blue results board" },
  { track: "red" as const, name: "Red results board" },
];

async function main() {
  const { listSignageScreens, saveSignageScreen } = await import(
    "../src/features/signage/data/signage-screens-db"
  );
  const { rolePreset } = await import("../src/features/signage/defaults");
  const { VENUE_INFO } = await import("../src/features/signage/constants");

  const existing = await listSignageScreens();
  console.log(`\n── already provisioned (${existing.length}) ──`);
  for (const s of existing) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
    const res = s.config.resultsBoard ? ` results=${s.config.resultsBoard.track}` : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${res}`);
  }

  // Pick free FT numbers, skipping the test screen (99) and anything taken. Never
  // reuse a number: an in-use id would silently repoint a TV already on a wall.
  const takenFt = new Set(existing.filter((s) => s.venue === "FT").map((s) => s.screenNumber));
  const freeNumbers: number[] = [];
  for (let n = 1; freeNumbers.length < BOARDS.length && n < 90; n += 1) {
    if (!takenFt.has(n)) freeNumbers.push(n);
  }

  const preset = rolePreset("results-board");

  const plan = BOARDS.map((b, i) => {
    // A results screen ALREADY provisioned for this track keeps its number, so a
    // re-run updates that same physical TV rather than minting a fresh id.
    const already = existing.find(
      (s) => s.venue === "FT" && s.config.resultsBoard?.track === b.track,
    );
    return {
      ...b,
      screenNumber: already?.screenNumber ?? freeNumbers[i],
      reusing: !!already,
    };
  });

  console.log(`\n── plan ──`);
  for (const p of plan) {
    console.log(
      `  FT:${p.screenNumber}  ${p.name}  track=${p.track}  ${
        p.reusing ? "updating existing" : "new"
      }`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to create these.\n");
    return;
  }

  for (const p of plan) {
    await saveSignageScreen({
      screenId: `FT:${p.screenNumber}`,
      venue: "FT",
      center: VENUE_INFO.FT.center,
      screenNumber: p.screenNumber,
      name: p.name,
      // The role preset verbatim (single race-results scene, every interrupt
      // off), plus this screen's track.
      config: { ...preset.config, resultsBoard: { track: p.track } },
    });
    console.log(`  ✓ saved FT:${p.screenNumber} — ${p.name}`);
  }

  // Read back, so the script proves the write rather than assuming it.
  const after = await listSignageScreens();
  console.log(`\n── verify ──`);
  for (const p of plan) {
    const row = after.find((s) => s.screenId === `FT:${p.screenNumber}`);
    if (!row) {
      console.log(`  ✗ FT:${p.screenNumber} NOT FOUND after write`);
      continue;
    }
    const scenes = (row.config.playlist ?? []).map((s) => s.scene).join(", ");
    const ok =
      scenes === "race-results" &&
      row.config.resultsBoard?.track === p.track &&
      row.config.interrupts?.celebration?.enabled === false;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row.screenId}  scenes=[${scenes}]  track=${row.config.resultsBoard?.track}  interrupts-off=${row.config.interrupts?.celebration?.enabled === false}`,
    );
    console.log(`      open: /tv?screen=${row.screenId}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
