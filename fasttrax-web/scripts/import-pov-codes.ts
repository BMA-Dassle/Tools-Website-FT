/**
 * Import POV ViewPoint unlock codes into Redis.
 *
 * Usage:
 *   npx tsx scripts/import-pov-codes.ts codes.txt
 *
 * Or pipe codes:
 *   cat codes.txt | npx tsx scripts/import-pov-codes.ts
 *
 * The file should have one code per line (10-char alphanumeric).
 * Codes already in Redis (available or used) are skipped.
 */

import { readFileSync } from "fs";

const API_URL = process.env.API_URL || "http://localhost:3000";

async function main() {
  // Read codes from file arg or stdin
  let raw: string;
  if (process.argv[2]) {
    raw = readFileSync(process.argv[2], "utf-8");
  } else {
    raw = readFileSync(0, "utf-8"); // stdin
  }

  const codes = raw
    .split(/[\n\r]+/)
    .map(c => c.trim())
    .filter(c => /^[A-Z0-9]{8,12}$/.test(c));

  console.log(`Found ${codes.length} valid codes`);

  if (codes.length === 0) {
    console.error("No valid codes found. Codes should be 8-12 char alphanumeric, one per line.");
    process.exit(1);
  }

  // Import in batches of 500
  let totalImported = 0;
  let totalSkipped = 0;

  for (let i = 0; i < codes.length; i += 500) {
    const batch = codes.slice(i, i + 500);
    console.log(`  Importing batch ${Math.floor(i / 500) + 1} (${batch.length} codes)...`);

    const res = await fetch(`${API_URL}/api/pov-codes?action=import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes: batch }),
    });

    const data = await res.json();
    if (data.error) {
      console.error(`  Error: ${data.error}`);
      continue;
    }

    totalImported += data.imported || 0;
    totalSkipped += data.skipped || 0;
    console.log(`  Imported: ${data.imported}, Skipped: ${data.skipped}`);
  }

  console.log(`\nDone! Total imported: ${totalImported}, Total skipped: ${totalSkipped}`);

  // Get stats
  const statsRes = await fetch(`${API_URL}/api/pov-codes?action=stats`);
  const stats = await statsRes.json();
  console.log(`Redis stats: ${stats.available} available, ${stats.used} used, ${stats.total} total`);
}

main().catch(console.error);
