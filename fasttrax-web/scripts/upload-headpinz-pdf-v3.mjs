/**
 * Upload the updated HeadPinz Group Events PDF (v3, Apr 29 2026) to
 * Vercel Blob, overwriting the previous Sales Booklet at the same path.
 *
 * Run from fasttrax-web/:  node scripts/upload-headpinz-pdf-v3.mjs
 */
import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

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

const src = "C:/Work/HeadPinz Group Events 4-29-26 v3.pdf";
const dest = "documents/HeadPinz-Sales-Booklet.pdf";

console.log(`Uploading ${src} → ${dest} ...`);
const bytes = await readFile(src);
const result = await put(dest, bytes, {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/pdf",
  token,
});
console.log(`OK  ${dest}\n    -> ${result.url}\n`);
