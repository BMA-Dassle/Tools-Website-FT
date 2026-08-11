/**
 * Provision the two briefing-room screens (Red and Blue).
 *
 * IMPORTS THE APP'S OWN WIRING rather than hand-writing SQL or a config blob:
 * `rolePreset("briefing-room")` is the exact config the admin form would save,
 * and `saveSignageScreen` is the exact write path it would use. A script that
 * invents its own JSON is a script that drifts from the form the day either
 * changes (house lesson: probes import the real wiring).
 *
 * Usage:
 *   npx tsx apps/web/scripts/signage-provision-briefing-rooms.mts            # dry run
 *   npx tsx apps/web/scripts/signage-provision-briefing-rooms.mts --apply    # write
 *
 * Idempotent: saveSignageScreen upserts on screen_id, so re-running re-asserts
 * the same two rows rather than creating duplicates.
 */
import { readFileSync } from "node:fs";

// Env from .env.local, the house way — no dotenv dependency (see the other
// scripts in this folder). Must run BEFORE the dynamic imports below, because
// @ft/db reads DATABASE_URL when it initialises.
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

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
    const room = s.config.briefingRoom ? ` briefingRoom=${s.config.briefingRoom}` : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${room}`);
  }

  // Pick the next two free FT numbers, skipping the test screen (99) and
  // anything already taken. Never reuse a number: an in-use id would silently
  // repoint a TV that is already hanging on a wall.
  const takenFt = new Set(
    existing.filter((s) => s.venue === "FT").map((s) => s.screenNumber),
  );
  const freeNumbers: number[] = [];
  for (let n = 1; freeNumbers.length < 2 && n < 90; n += 1) {
    if (!takenFt.has(n)) freeNumbers.push(n);
  }

  // If a briefing screen is ALREADY provisioned for a room, keep its number —
  // re-running must not hand the same physical TV a new id.
  const preset = rolePreset("briefing-room");
  const rooms = [
    { room: "red" as const, name: "Red briefing room" },
    { room: "blue" as const, name: "Blue briefing room" },
  ];

  const plan = rooms.map(({ room, name }, i) => {
    const already = existing.find(
      (s) => s.venue === "FT" && s.config.briefingRoom === room,
    );
    return {
      room,
      name,
      screenNumber: already?.screenNumber ?? freeNumbers[i],
      reusing: !!already,
    };
  });

  console.log(`\n── plan ──`);
  for (const p of plan) {
    console.log(
      `  FT:${p.screenNumber}  ${p.name}  (${p.reusing ? "updating existing" : "new"})`,
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
      // The role preset verbatim (single briefing scene, every interrupt off),
      // plus which room this screen stands in.
      config: { ...preset.config, briefingRoom: p.room },
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
      row.config.briefingRoom === p.room &&
      scenes === "briefing" &&
      row.config.interrupts?.celebration?.enabled === false;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row.screenId}  room=${row.config.briefingRoom}  scenes=[${scenes}]  interrupts-off=${
        row.config.interrupts?.celebration?.enabled === false
      }`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
