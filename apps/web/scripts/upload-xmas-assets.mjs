/**
 * Upload "Xmas in July" landing-page assets (hero video + poster + gallery photos)
 * to Vercel Blob under events/xmas-in-july/. Reads BLOB_READ_WRITE_TOKEN from
 * apps/web/.env.local. Source files are the ffmpeg-optimized outputs in c:\tmp\xmasvid.
 *
 *   node scripts/upload-xmas-assets.mjs
 *
 * Writes the resolved blob URLs to xmas-blob-mapping.json for wiring into group-events.ts.
 */
import { put } from "@vercel/blob";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ── Load BLOB_READ_WRITE_TOKEN from .env.local ───────────────────────────────
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN missing from .env.local");
  process.exit(1);
}

const SRC = "C:/tmp/xmasvid";
const CT = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".webp": "image/webp" };

// [localFile, blobPath]
const uploads = [
  [`${SRC}/hero-neon-1080.mp4`, "events/xmas-in-july/hero-1080.mp4"],
  [`${SRC}/hero-neon-720.mp4`, "events/xmas-in-july/hero-720.mp4"],
  [`${SRC}/poster-neon.jpg`, "events/xmas-in-july/hero-poster.jpg"],
];
for (let i = 1; i <= 7; i++) {
  const n = String(i).padStart(2, "0");
  uploads.push([`${SRC}/photos/photo-${n}.webp`, `events/xmas-in-july/gallery/${n}.webp`]);
  uploads.push([`${SRC}/photos/photo-${n}.jpg`, `events/xmas-in-july/gallery/${n}.jpg`]);
}

async function main() {
  const mapping = {};
  for (const [localFile, blobPath] of uploads) {
    if (!existsSync(localFile)) {
      console.error(`✗ missing source: ${localFile}`);
      continue;
    }
    const ext = blobPath.slice(blobPath.lastIndexOf("."));
    try {
      const blob = await put(blobPath, readFileSync(localFile), {
        access: "public",
        addRandomSuffix: false,
        contentType: CT[ext],
        token,
      });
      mapping[blobPath] = blob.url;
      console.log(`✓ ${blobPath} → ${blob.url}`);
    } catch (err) {
      console.error(`✗ ${blobPath}: ${err.message}`);
    }
  }
  writeFileSync(join(process.cwd(), "xmas-blob-mapping.json"), JSON.stringify(mapping, null, 2));
  console.log(`\nMapping saved to xmas-blob-mapping.json (${Object.keys(mapping).length} files)`);
}

main().catch(console.error);
