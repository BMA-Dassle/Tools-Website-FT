/**
 * Provision the two briefing-room CAMERA monitor screens (Blue and Red).
 *
 * The sibling of signage-provision-briefing-rooms.mts, and the same discipline:
 * IMPORTS THE APP'S OWN WIRING rather than hand-writing SQL or a config blob.
 * `rolePreset("camera-monitor")` is the exact config the admin form would save
 * (single `camera` scene, every interrupt off), and `saveSignageScreen` is the
 * exact write path — so this cannot drift from the form.
 *
 * Each screen gets its briefing-room camera (an Nx device id) and its track, so
 * the board carries that track's big session + running-behind clocks and the
 * room's briefing session + video countdown.
 *
 * Usage:
 *   npx tsx apps/web/scripts/signage-provision-briefing-cams.mts            # dry run
 *   npx tsx apps/web/scripts/signage-provision-briefing-cams.mts --apply    # write
 *
 * Idempotent: matched by the camera's track, and saveSignageScreen upserts on
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

/** The briefing-room cameras, from the live Nx device list (GET /rest/v4/devices,
 *  verified 2026-08-12). Blue and Red karting briefing rooms at FastTrax. */
const CAMS = [
  {
    track: "blue" as const,
    deviceId: "ae9373a3-f070-b2d6-d109-751c26159b6c",
    label: "Blue Briefing Room",
    name: "Blue briefing room camera",
  },
  {
    track: "red" as const,
    deviceId: "dbecf8d8-d543-419a-bafc-bda19f48b689",
    label: "Red Briefing Room",
    name: "Red briefing room camera",
  },
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
    const cam = s.config.cameraMonitor
      ? ` camera=${s.config.cameraMonitor.track ?? "no-track"}`
      : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${cam}`);
  }

  // Pick free FT numbers, skipping the test screen (99) and anything taken. Never
  // reuse a number: an in-use id would silently repoint a TV already on a wall.
  const takenFt = new Set(existing.filter((s) => s.venue === "FT").map((s) => s.screenNumber));
  const freeNumbers: number[] = [];
  for (let n = 1; freeNumbers.length < CAMS.length && n < 90; n += 1) {
    if (!takenFt.has(n)) freeNumbers.push(n);
  }

  const preset = rolePreset("camera-monitor");

  const plan = CAMS.map((cam, i) => {
    // A camera screen ALREADY provisioned for this track keeps its number, so a
    // re-run updates that same physical TV rather than minting a fresh id.
    const already = existing.find(
      (s) => s.venue === "FT" && s.config.cameraMonitor?.track === cam.track,
    );
    return {
      ...cam,
      screenNumber: already?.screenNumber ?? freeNumbers[i],
      reusing: !!already,
    };
  });

  console.log(`\n── plan ──`);
  for (const p of plan) {
    console.log(
      `  FT:${p.screenNumber}  ${p.name}  cam=${p.label} (${p.track})  ${
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
      // The role preset verbatim (single camera scene, every interrupt off),
      // plus this screen's camera and track.
      config: {
        ...preset.config,
        cameraMonitor: { deviceId: p.deviceId, label: p.label, track: p.track },
      },
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
    const mon = row.config.cameraMonitor;
    const ok =
      scenes === "camera" &&
      mon?.deviceId === p.deviceId &&
      mon?.track === p.track &&
      row.config.interrupts?.celebration?.enabled === false;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row.screenId}  scenes=[${scenes}]  device=${mon?.deviceId?.slice(0, 8)}…  track=${mon?.track}`,
    );
    console.log(`      open: /tv?screen=${row.screenId}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
