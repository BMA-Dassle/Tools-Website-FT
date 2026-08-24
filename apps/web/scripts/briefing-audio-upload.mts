/**
 * UPLOAD A BRIEFING-ROOM AUDIO CLIP and make it the current one.
 *
 *   npx tsx scripts/briefing-audio-upload.mts <asset-key> <file> [--apply]
 *
 * The board's own uploader does this in two steps — a direct-to-blob PUT from
 * the browser, then a confirm POST that writes the manifest row. If the second
 * step never lands the file exists in blob storage and NOTHING plays it, which
 * is exactly what happened to the 2026-08-24 welcome-back clip: the manifest
 * still pointed at the 2026-08-15 file and the rooms faithfully played it.
 *
 * This does both steps in one process, so there is no window to lose.
 *
 * IT DOES NOT DELETE THE FILE IT REPLACES, deliberately — unlike the route,
 * which prunes to keep storage flat. A clip swapped by hand is one somebody may
 * want back within the hour, and the old URL is printed so it can be restored.
 *
 * DRY BY DEFAULT: prints what it would do and writes nothing without --apply.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const KEYS = ["welcome-back-audio", "welcome-back-linger-audio"] as const;
const key = process.argv[2] as (typeof KEYS)[number];
const file = process.argv[3];
const apply = process.argv.includes("--apply");

if (!KEYS.includes(key) || !file) {
  console.error(`usage: briefing-audio-upload.mts <${KEYS.join("|")}> <file.mp3> [--apply]`);
  process.exit(1);
}

const bytes = readFileSync(file);
const size = statSync(file).size;
console.log(`\n${key}`);
console.log(`  file  ${basename(file)}  ${(size / 1024).toFixed(0)} KB`);

const { put } = await import("@vercel/blob");
const { loadSignageAssetsSafe, saveSignageAsset } = await import(
  "~/features/signage/data/signage-assets-db"
);

const before = await loadSignageAssetsSafe();
console.log(`  now   ${before[key]?.url ?? "(nothing uploaded)"}`);

if (!apply) {
  console.log(`\n  DRY RUN — nothing written. Re-run with --apply.\n`);
  process.exit(0);
}

// Same folder and the same unique-URL strategy the route uses: the players
// compare URLs to decide whether they already hold a file, so a fresh suffix is
// what invalidates every screen's cached copy.
const blob = await put(`briefing/${key}.mp3`, bytes, {
  access: "public",
  addRandomSuffix: true,
  contentType: "audio/mpeg",
  cacheControlMaxAge: 31 * 24 * 60 * 60,
});
const { replacedUrl } = await saveSignageAsset({
  key,
  url: blob.url,
  size,
  // Unused for audio (the TV follows the element's own events, not a stored
  // length) and not worth decoding an mp3 header for.
  durationMs: null,
});

console.log(`  new   ${blob.url}`);
console.log(`  old   ${replacedUrl ?? "(none)"}${replacedUrl ? "  ← kept, not deleted" : ""}`);
console.log(`\n  Live on the next board/TV poll.\n`);
