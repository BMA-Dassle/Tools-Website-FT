/**
 * Provision the two CHECK-IN screens (Blue and Red) — the guide walls between
 * the check-in desk and the briefing rooms.
 *
 * Sibling of signage-provision-results-boards.mts, same discipline: IMPORTS
 * THE APP'S OWN WIRING rather than hand-writing SQL or a config blob.
 * `rolePreset("check-in-guide")` is the exact config the admin form would save,
 * and `saveSignageScreen` is the exact write path, so this cannot drift.
 *
 * TWO THINGS EACH SCREEN NEEDS AND CANNOT WORK OUT FOR ITSELF:
 *   - its TRACK, which decides whose sends light the arrow and whose
 *     qualifying times it advertises. Also set as `scope.resourceIds`, because
 *     the feed builds `raceCheckin` from scope — that is what the takeover
 *     reads.
 *   - which WAY the briefing rooms are. Owner said left (2026-08-15), so both
 *     are seeded left. If the two rooms turn out to be in opposite directions
 *     from these walls, flip one on the admin page — it is a dropdown, not a
 *     deploy.
 *
 * Usage:
 *   npx tsx scripts/signage-provision-checkin-screens.mts            # dry run
 *   npx tsx scripts/signage-provision-checkin-screens.mts --apply    # write
 *
 * Run from apps/web. Idempotent: matched by the guide's track, and
 * saveSignageScreen upserts on screen_id, so a re-run re-asserts the same two
 * rows rather than minting a new id for a TV already on a wall.
 */
import { readFileSync } from "node:fs";

// Env from .env.local, the house way — before the dynamic imports below,
// because the db layer reads DATABASE_URL on init.
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

const SCREENS = [
  { track: "blue" as const, name: "Check In Blue", resourceId: "11208654" },
  { track: "red" as const, name: "Check In Red", resourceId: "11208660" },
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
    const g = s.config.raceGuide ? ` guide=${s.config.raceGuide.track}` : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${g}`);
  }

  const takenFt = new Set(existing.filter((s) => s.venue === "FT").map((s) => s.screenNumber));
  const free: number[] = [];
  for (let n = 1; free.length < SCREENS.length && n < 90; n += 1) {
    if (!takenFt.has(n)) free.push(n);
  }

  const preset = rolePreset("check-in-guide");

  const plan = SCREENS.map((b, i) => {
    const already = existing.find(
      (s) => s.venue === "FT" && s.config.raceGuide?.track === b.track,
    );
    return { ...b, screenNumber: already?.screenNumber ?? free[i], reusing: !!already };
  });

  console.log(`\n── plan ──`);
  for (const p of plan) {
    console.log(
      `  FT:${p.screenNumber}  ${p.name}  track=${p.track}  arrow=left  ${
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
      config: {
        ...preset.config,
        raceGuide: { track: p.track, arrow: "left" },
        // The feed only builds `raceCheckin` — and therefore only knows about
        // the send that fires the arrow — for a screen scoped to a resource.
        scope: { resourceIds: [p.resourceId] },
      },
    });
    console.log(`  ✓ saved FT:${p.screenNumber} — ${p.name}`);
  }

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
      scenes === "race-guide" &&
      row.config.raceGuide?.track === p.track &&
      row.config.raceGuide?.arrow === "left" &&
      row.config.scope?.resourceIds?.[0] === p.resourceId &&
      row.config.interrupts?.celebration?.enabled === false;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row.screenId}  scenes=[${scenes}]  track=${row.config.raceGuide?.track}` +
        `  arrow=${row.config.raceGuide?.arrow}  scope=${row.config.scope?.resourceIds?.[0]}`,
    );
    console.log(`      open: /tv?screen=${row.screenId}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
