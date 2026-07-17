/**
 * Upload the two "Christmas in July" business-partner flyers to Vercel Blob
 * under events/xmas-in-july/, so the email blast can reference them by a stable
 * public URL (embedding them inline would blow past Gmail's 102KB clip limit).
 *
 *   node scripts/upload-xmas-flyers.mjs
 *
 * Source flyers live in the gitignored scripts/.data/ dir (PII-adjacent staging):
 *   scripts/.data/flyer-naples.jpg      (HPN 2026.jpg)
 *   scripts/.data/flyer-fortmyers.jpg   (FMFT 2026.jpg)
 *
 * Reads BLOB_READ_WRITE_TOKEN from apps/web/.env.local. addRandomSuffix:false
 * keeps the URL deterministic so lib/xmas-blast.ts can hardcode it.
 */
import { put } from "@vercel/blob";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

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

const uploads = [
  ["scripts/.data/flyer-naples.jpg", "events/xmas-in-july/flyer-naples.jpg"],
  ["scripts/.data/flyer-fortmyers.jpg", "events/xmas-in-july/flyer-fortmyers.jpg"],
];

async function main() {
  for (const [localFile, blobPath] of uploads) {
    const abs = join(process.cwd(), localFile);
    if (!existsSync(abs)) {
      console.error(`✗ missing source: ${abs}`);
      process.exitCode = 1;
      continue;
    }
    try {
      const blob = await put(blobPath, readFileSync(abs), {
        access: "public",
        addRandomSuffix: false,
        contentType: "image/jpeg",
        token,
      });
      console.log(`✓ ${blobPath} → ${blob.url}`);
    } catch (err) {
      console.error(`✗ ${blobPath}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
