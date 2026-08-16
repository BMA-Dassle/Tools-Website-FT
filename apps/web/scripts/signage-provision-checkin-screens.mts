/**
 * Provision THE check-in screen — one wall between the desk and the briefing
 * rooms, covering BOTH tracks.
 *
 * ONE SCREEN, NOT ONE PER TRACK (owner 2026-08-15: "the secondary check in
 * screen was supposed to be ONE screen not separate for blue and red"). An
 * earlier run of this script created FT:11 and FT:12; the `--apply` path now
 * keeps the first and DELETES any other guide screen it finds, so a re-run
 * converges on a single row rather than leaving the mistake behind.
 *
 * Same discipline as its siblings: imports the app's own `rolePreset` and
 * `saveSignageScreen`, so it cannot drift from what the admin form would write.
 *
 * NO `scope.resourceIds`. The wall belongs to the check-in AREA rather than to
 * a track, and the feed builds its `raceGuide` section from the configured
 * tracks by name — scope would also wire in that track's scan events, which
 * this screen has no use for.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/signage-provision-checkin-screens.mts            # dry run
 *   npx tsx scripts/signage-provision-checkin-screens.mts --apply    # write
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");
const NAME = "Check In";

async function main() {
  const { listSignageScreens, saveSignageScreen, deleteSignageScreen } = await import(
    "../src/features/signage/data/signage-screens-db"
  );
  const { rolePreset } = await import("../src/features/signage/defaults");
  const { VENUE_INFO } = await import("../src/features/signage/constants");

  const existing = await listSignageScreens();
  console.log(`\n── already provisioned (${existing.length}) ──`);
  for (const s of existing) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
    const g = s.config.raceGuide
      ? ` guide=[${(s.config.raceGuide.tracks ?? [s.config.raceGuide.track]).join(",")}]`
      : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${g}`);
  }

  // Every guide screen that exists today, oldest number first. The first is
  // the keeper; anything after it is the duplicate this script used to create.
  const guides = existing
    .filter((s) => s.venue === "FT" && !!s.config.raceGuide)
    .sort((a, b) => a.screenNumber - b.screenNumber);

  let keepNumber = guides[0]?.screenNumber;
  if (keepNumber === undefined) {
    const taken = new Set(existing.filter((s) => s.venue === "FT").map((s) => s.screenNumber));
    for (let n = 1; n < 90; n += 1) {
      if (!taken.has(n)) {
        keepNumber = n;
        break;
      }
    }
  }
  const drop = guides.slice(1);

  console.log(`\n── plan ──`);
  console.log(`  KEEP    FT:${keepNumber}  "${NAME}"  tracks=[blue,red]  arrow=left`);
  for (const d of drop) console.log(`  DELETE  ${d.screenId}  ${d.name} (duplicate — one wall now)`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    return;
  }

  const preset = rolePreset("check-in-guide");
  await saveSignageScreen({
    screenId: `FT:${keepNumber}`,
    venue: "FT",
    center: VENUE_INFO.FT.center,
    screenNumber: keepNumber as number,
    name: NAME,
    config: {
      ...preset.config,
      // Both rooms are the same way from this wall (owner), so the arrow is a
      // per-screen fact rather than a per-room one.
      raceGuide: { tracks: ["blue", "red"], arrow: "left" },
    },
  });
  console.log(`  ✓ saved FT:${keepNumber} — ${NAME}`);

  for (const d of drop) {
    await deleteSignageScreen(d.screenId);
    console.log(`  ✓ deleted ${d.screenId}`);
  }

  const after = await listSignageScreens();
  const guidesAfter = after.filter((s) => !!s.config.raceGuide);
  console.log(`\n── verify ──`);
  for (const row of guidesAfter) {
    const scenes = (row.config.playlist ?? []).map((s) => s.scene).join(", ");
    const tracks = row.config.raceGuide?.tracks ?? [];
    const ok =
      scenes === "race-guide" &&
      tracks.length === 2 &&
      tracks.includes("blue") &&
      tracks.includes("red") &&
      row.config.raceGuide?.arrow === "left" &&
      !row.config.scope?.resourceIds?.length;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row.screenId} "${row.name}"  scenes=[${scenes}]  tracks=[${tracks.join(",")}]  arrow=${row.config.raceGuide?.arrow}`,
    );
    console.log(`      open: /tv?screen=${row.screenId}`);
  }
  console.log(
    guidesAfter.length === 1
      ? "\n  ✓ exactly one check-in screen\n"
      : `\n  ✗ expected 1 check-in screen, found ${guidesAfter.length}\n`,
  );
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
