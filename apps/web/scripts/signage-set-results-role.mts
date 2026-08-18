/**
 * Set a results wall's ROLE (and, for a top-times wall, its windows).
 *
 * The sibling of signage-provision-results-boards.mts, and the same discipline:
 * it goes through `saveSignageScreen`, the app's own write path, rather than
 * hand-writing SQL — so it cannot drift from what the admin form does.
 *
 * SURGICAL BY CONSTRUCTION. It reads the existing row and replaces ONLY
 * `config.resultsBoard`, carrying every other key of the blob through
 * untouched. These are live walls; a script that rebuilt the config from a
 * preset would silently drop whatever else had been set on them.
 *
 * Usage:
 *   npx tsx scripts/signage-set-results-role.mts FT:10 top-times today,month
 *   npx tsx scripts/signage-set-results-role.mts FT:10 top-times today,month --apply
 *
 * Idempotent: re-running asserts the same value.
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const [screenId, role, rangesRaw] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");

if (!screenId || (role !== "top-times" && role !== "last-race")) {
  console.error("usage: <screenId> <last-race|top-times> [today,week,month] [--apply]");
  process.exit(1);
}

const ranges = (rangesRaw ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter((r): r is "today" | "week" | "month" => r === "today" || r === "week" || r === "month");

async function main() {
  const { listSignageScreens, saveSignageScreen } = await import(
    "../src/features/signage/data/signage-screens-db"
  );

  const screens = await listSignageScreens();
  const screen = screens.find((s) => s.screenId === screenId);
  if (!screen) {
    console.error(`✗ ${screenId} is not provisioned`);
    process.exit(1);
  }

  const current = screen.config.resultsBoard;
  if (!current?.track) {
    console.error(`✗ ${screenId} has no resultsBoard.track — set a track first`);
    process.exit(1);
  }

  const next = {
    track: current.track,
    role,
    // Windows only mean anything to a top-times wall. Writing them onto a
    // last-race one would be dead config that reads as intent.
    ...(role === "top-times" ? { ranges: ranges.length > 0 ? ranges : (["today"] as const) } : {}),
  };

  console.log(`\n── ${screenId} — ${screen.name} ──`);
  console.log(`  before: ${JSON.stringify(current)}`);
  console.log(`  after:  ${JSON.stringify(next)}`);
  console.log(`  other config keys preserved: ${Object.keys(screen.config).join(", ")}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    process.exit(0);
  }

  await saveSignageScreen({
    screenId: screen.screenId,
    venue: screen.venue,
    center: screen.center,
    screenNumber: screen.screenNumber,
    name: screen.name,
    // Spread FIRST, then override the one key — see the header.
    config: { ...screen.config, resultsBoard: next },
  });

  const after = (await listSignageScreens()).find((s) => s.screenId === screenId);
  const got = after?.config.resultsBoard;
  const ok = got?.role === role && got?.track === current.track;
  console.log(`\n  ${ok ? "✓" : "✗"} read back: ${JSON.stringify(got)}`);
  const scenes = (after?.config.playlist ?? []).map((p) => p.scene).join(", ");
  console.log(`  playlist still: [${scenes}]`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
