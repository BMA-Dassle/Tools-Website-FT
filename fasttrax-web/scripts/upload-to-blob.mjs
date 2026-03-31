import { put } from "@vercel/blob";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const IMAGES_DIR = join(process.cwd(), "public", "images");
const BASE_URL = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

function getAllFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...getAllFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  const files = getAllFiles(IMAGES_DIR);
  console.log(`Found ${files.length} files to upload\n`);

  const mapping = {};

  for (const filePath of files) {
    const relativePath = relative(join(process.cwd(), "public"), filePath).replace(/\\/g, "/");
    const blobPath = relativePath; // e.g. "images/hero/hero-kart-3.webp"

    try {
      const fileBuffer = readFileSync(filePath);
      const blob = await put(blobPath, fileBuffer, {
        access: "public",
        addRandomSuffix: false,
      });
      mapping[`/${relativePath}`] = blob.url;
      console.log(`✓ ${relativePath} → ${blob.url}`);
    } catch (err) {
      console.error(`✗ ${relativePath}: ${err.message}`);
    }
  }

  // Output the mapping as JSON
  const outputPath = join(process.cwd(), "blob-mapping.json");
  const { writeFileSync } = await import("fs");
  writeFileSync(outputPath, JSON.stringify(mapping, null, 2));
  console.log(`\nMapping saved to blob-mapping.json (${Object.keys(mapping).length} files)`);
}

main().catch(console.error);
