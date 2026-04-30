/**
 * One-off uploader for HeadPinz assets that need to live on Vercel Blob.
 * Mirrors the existing path conventions (images/headpinz/* + documents/*)
 * and prints the resulting public URLs so they can be pasted into page.tsx.
 *
 * Run from fasttrax-web/:  node scripts/upload-headpinz-assets.mjs
 *
 * Reads BLOB_READ_WRITE_TOKEN from .env.local (no extra setup needed).
 */
import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Tiny .env.local reader — avoids pulling dotenv just for one script.
// Handles KEY=VALUE pairs, ignores blank lines and comments, strips
// surrounding quotes if present.
function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (err) {
    console.error("Could not read .env.local:", err.message);
  }
}
loadEnvLocal();

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN missing from .env.local");
  process.exit(1);
}

const uploads = [
  {
    src: "C:/work/GFbackground.png",
    dest: "images/headpinz/group-events-bowling-bg.png",
    contentType: "image/png",
  },
  {
    src: "C:/Work/HeadPinz Sales Booklet.pdf",
    dest: "documents/HeadPinz-Sales-Booklet.pdf",
    contentType: "application/pdf",
  },
];

for (const u of uploads) {
  const bytes = await readFile(u.src);
  const result = await put(u.dest, bytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: u.contentType,
    token,
  });
  console.log(`OK  ${u.dest}\n    -> ${result.url}\n`);
}
