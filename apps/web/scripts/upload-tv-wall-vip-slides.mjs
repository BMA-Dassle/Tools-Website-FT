/**
 * Upload the VIP wall slide ARTWORK — the five transparent PNGs that make one
 * picture across the HeadPinz front-desk wall.
 *
 * These are OVERLAYS, not backdrops: every one is a 1920x1080 32-bit PNG whose
 * background is fully transparent, so the scene paints a venue photograph
 * underneath and the gold artwork sits on top of it. That is why they must stay
 * PNG through the pipeline — a JPEG re-encode would flatten the alpha to black
 * and hide the photo the design is built around.
 *
 * Panel N of the filename is WALL POSITION N-1, left to right. The set is one
 * composition: panel 1 names the product, 5 carries the QR, and the three
 * between them are the sentence in the middle. Uploading a partial set would
 * leave a sentence with a hole in it, so the script refuses unless all five
 * resolve.
 *
 * Idempotent by pathname (`addRandomSuffix: false`), so a re-export of one slide
 * overwrites in place and the URL in assets.ts keeps working. That IS an
 * overwrite of a live asset — hence --live, and hence the dry run first.
 *
 * Usage (from the repo root, with BLOB_READ_WRITE_TOKEN in apps/web/.env.local):
 *   node apps/web/scripts/upload-tv-wall-vip-slides.mjs           # dry run
 *   node apps/web/scripts/upload-tv-wall-vip-slides.mjs --live    # upload
 */
import { put } from "@vercel/blob";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    break;
  } catch {
    /* try the next location */
  }
}

const SOURCE_DIR =
  process.env.VIP_SLIDE_DIR ||
  "C:/Users/eric.osborn.CORP/Downloads/Synchronized Landscape TV Wall Design for HeadPinz Lobby";

const LIVE = process.argv.includes("--live");
const PANELS = [1, 2, 3, 4, 5];

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN not found in env or apps/web/.env.local");
  process.exit(1);
}

/**
 * The exported filenames carry the headline (and its dollar signs, en-dashes and
 * double spaces), so they are matched on "Panel <n>" rather than typed out — a
 * re-export from the design tool changes the tail of the name every time the
 * copy changes.
 */
function sourceFor(panel) {
  const matches = readdirSync(SOURCE_DIR).filter(
    // `(?!\d)` and not `\b`: the exports are named "Panel 4_ …", and `_` is a
    // word character, so a word boundary never lands between the digit and it.
    (f) => f.toLowerCase().endsWith(".png") && new RegExp(`panel\\s*${panel}(?!\\d)`, "i").test(f),
  );
  if (matches.length !== 1) {
    throw new Error(
      `panel ${panel}: expected exactly one PNG, found ${matches.length}${matches.length ? ` (${matches.join(", ")})` : ""} in ${SOURCE_DIR}`,
    );
  }
  return join(SOURCE_DIR, matches[0]);
}

async function main() {
  const files = PANELS.map((panel) => ({ panel, file: sourceFor(panel) }));
  console.log(`${LIVE ? "LIVE" : "DRY-RUN"} — ${files.length} slides from ${SOURCE_DIR}\n`);

  for (const { panel, file } of files) {
    const body = readFileSync(file);
    // 32-bit PNG or the alpha is already gone before we start; a 24-bit export
    // would upload cleanly and then paint an opaque black rectangle over the
    // photograph on the glass, which is the one failure nobody catches locally.
    const colorType = body[25];
    if (colorType !== 6 && colorType !== 4) {
      throw new Error(
        `panel ${panel}: PNG colour type ${colorType} carries no alpha channel — re-export with transparency (${file})`,
      );
    }
    const pathname = `images/tv-wall/vip-s1-p${panel}.png`;
    console.log(`panel ${panel}  ${(body.length / 1024 / 1024).toFixed(1)} MB → ${pathname}`);
    if (!LIVE) continue;

    const blob = await put(pathname, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/png",
    });
    console.log(`  ✓ ${blob.url}`);
  }

  if (!LIVE) console.log("\nDry-run only — re-run with --live to upload.");
}

main().catch((err) => {
  console.error("upload failed:", err.message);
  process.exit(1);
});
