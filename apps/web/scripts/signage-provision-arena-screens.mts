/**
 * Provision the HP ARENA CHECK-IN SCREENS — one at HeadPinz Fort Myers, one at
 * HeadPinz Naples.
 *
 * BOTH VENUES FROM THE START (owner 2026-09-01: "keeping in mind that we will do
 * one in naples as well"). Naples is not a port of the Fort Myers board — a
 * 10-day live sweep on 2026-09-01 confirmed HP Naples publishes to the same
 * `HP Arena` dayplanner resource with the same session naming ("15 - Nexus Laser
 * Tag", type "Laser Tag") on a lighter day, so it is the identical board with a
 * different Pandora location id. Seeding both together is what stops the second
 * one being a fortnight of drift later.
 *
 * Same discipline as its siblings: imports the app's own `rolePreset` and
 * `saveSignageScreen`, so a seeded screen and one created through the admin form
 * cannot diverge.
 *
 * NO `scope.resourceIds`. There is one arena per venue and both activities run
 * off the one resource, so the venue IS the scope — and a scope would also wire
 * in that venue's kiosk scan events, which this board has no use for.
 *
 * IDEMPOTENT. Re-running finds the arena screen already at a venue by its
 * `arenaBoard` config key and rewrites that row rather than minting a second
 * one; a venue with none gets the lowest free screen number.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/signage-provision-arena-screens.mts            # dry run
 *   npx tsx scripts/signage-provision-arena-screens.mts --apply    # write
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

/** Venue → what the row is called on the admin page and on the .bat file. */
const TARGETS = [
  { venue: "HPFM" as const, name: "Arena Check In" },
  { venue: "HPN" as const, name: "Arena Check In" },
];

/** Ten minutes, the preset's own default — written explicitly so the row says
 *  what it means rather than relying on a resolver default a reader would have
 *  to go and look up. */
const HOLD_MS = 10 * 60_000;

async function main() {
  const { listSignageScreens, saveSignageScreen } =
    await import("../src/features/signage/data/signage-screens-db");
  const { rolePreset } = await import("../src/features/signage/defaults");
  const { VENUE_INFO } = await import("../src/features/signage/constants");

  const existing = await listSignageScreens();
  console.log(`\n── already provisioned (${existing.length}) ──`);
  for (const s of existing) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
    const arena = s.config.arenaBoard ? "  [ARENA]" : "";
    console.log(`  ${s.screenId.padEnd(9)} ${s.name || "(unnamed)"} — ${scenes}${arena}`);
  }

  const preset = rolePreset("arena-checkin");

  const plan: { screenId: string; venue: "HPFM" | "HPN"; screenNumber: number; name: string }[] =
    [];
  // Numbers claimed inside this run as well as before it, so seeding two venues
  // at once cannot hand out the same number twice at one of them.
  const claimed = new Set(existing.map((s) => `${s.venue}:${s.screenNumber}`));

  for (const target of TARGETS) {
    // FOUND BY CONFIG KEY, not by name: `arenaBoard` is what actually makes a
    // screen an arena board, and matching on a staff-editable name would mint a
    // duplicate the first time somebody renamed the row to "Arena TV".
    const already = existing
      .filter((s) => s.venue === target.venue && !!s.config.arenaBoard)
      .sort((a, b) => a.screenNumber - b.screenNumber)[0];

    let screenNumber = already?.screenNumber;
    if (screenNumber === undefined) {
      for (let n = 1; n < 90; n += 1) {
        if (!claimed.has(`${target.venue}:${n}`)) {
          screenNumber = n;
          break;
        }
      }
    }
    if (screenNumber === undefined) {
      console.error(`  ✗ ${target.venue}: no free screen number below 90`);
      process.exitCode = 1;
      continue;
    }
    claimed.add(`${target.venue}:${screenNumber}`);
    plan.push({
      screenId: `${target.venue}:${screenNumber}`,
      venue: target.venue,
      screenNumber,
      name: target.name,
    });
  }

  console.log(`\n── plan ──`);
  for (const p of plan) {
    const verb = existing.some((s) => s.screenId === p.screenId) ? "UPDATE" : "CREATE";
    console.log(
      `  ${verb}  ${p.screenId.padEnd(9)} "${p.name}"  ${VENUE_INFO[p.venue].label}  ` +
        `pandora=${VENUE_INFO[p.venue].squareLocationId}  hold=${HOLD_MS / 60_000}min`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    return;
  }

  for (const p of plan) {
    await saveSignageScreen({
      screenId: p.screenId,
      venue: p.venue,
      center: VENUE_INFO[p.venue].center,
      screenNumber: p.screenNumber,
      name: p.name,
      config: {
        ...preset.config,
        // Written explicitly rather than left to the preset's `{}`, so the row
        // records the hold it is running on. A future preset change then cannot
        // silently retune a board already hanging on a wall.
        arenaBoard: { holdMs: HOLD_MS },
      },
    });
    console.log(`  ✓ saved ${p.screenId} — ${p.name}`);
  }

  const after = await listSignageScreens();
  console.log(`\n── verify ──`);
  let ok = true;
  for (const p of plan) {
    const row = after.find((s) => s.screenId === p.screenId);
    const scenes = (row?.config.playlist ?? []).map((s) => s.scene);
    // The four things that make this board work, checked against what actually
    // landed in Neon rather than against what we meant to write.
    const good =
      !!row &&
      !!row.config.arenaBoard &&
      row.config.arenaBoard.holdMs === HOLD_MS &&
      scenes.includes("arena-promo") &&
      scenes.includes("ads") &&
      // The check-in scene is an INTERRUPT — finding it in a playlist would mean
      // somebody had turned it into a rotation entry, and the board would cut
      // away from a live instruction to show an advert.
      !scenes.includes("arena-checkin") &&
      !row.config.scope?.resourceIds?.length &&
      row.config.interrupts?.celebration?.enabled === false;
    ok &&= good;
    console.log(
      `  ${good ? "✓" : "✗"} ${p.screenId} "${row?.name ?? "(missing)"}"  ` +
        `scenes=[${scenes.join(", ")}]  hold=${(row?.config.arenaBoard?.holdMs ?? 0) / 60_000}min`,
    );
    console.log(`      open: /tv?screen=${p.screenId}`);
    console.log(`      preview the takeover: /tv?screen=${p.screenId}&demo=arena`);
  }

  const arenaRows = after.filter((s) => !!s.config.arenaBoard);
  console.log(
    arenaRows.length === TARGETS.length
      ? `\n  ✓ exactly ${TARGETS.length} arena screens (one per HeadPinz venue)\n`
      : `\n  ✗ expected ${TARGETS.length} arena screens, found ${arenaRows.length}\n`,
  );
  if (!ok || arenaRows.length !== TARGETS.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
