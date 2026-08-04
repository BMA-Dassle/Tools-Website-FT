/**
 * TEST RESET: un-redeem the two "100 bonus tokens" (gamezone) items on the
 * owner's test voucher HPW-Z96R-Z4SX (Eric Test 3 Osborn booking) so the
 * redemption flow can be exercised again.
 *
 * Redemption truth = voucher_claims (code, item_index) status. We set the
 * gamezone items' claims back to 'released' — the same state releaseVoucherClaim
 * writes — never DELETE, so the audit trail survives. Dry-run by default;
 * APPLY=1 to write.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const CODE = "HPWZ96RZ4SX"; // HPW-Z96R-Z4SX normalized

let envRaw = "";
try {
  envRaw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
} catch {
  /* fall through to process.env */
}
const m = envRaw.match(/^DATABASE_URL=(.+)$/m);
const dbUrl = process.env.DATABASE_URL || (m ? m[1].trim().replace(/^"|"$/g, "") : "");
if (!dbUrl) throw new Error("DATABASE_URL missing");
const sql = neon(dbUrl);

const APPLY = process.env.APPLY === "1";

async function main() {
  const vouchers = await sql`
    SELECT code, kind, items, bill_id, voided_at, expires_at
    FROM vouchers WHERE code = ${CODE}
  `;
  if (vouchers.length === 0) throw new Error(`voucher ${CODE} not found`);
  const v = vouchers[0];
  const items: { kind: string; bonusTokens?: number }[] =
    typeof v.items === "string" ? JSON.parse(v.items) : v.items;
  console.log(`voucher ${CODE} · kind=${v.kind} · voided_at=${v.voided_at ?? "-"}`);
  items.forEach((it, i) => console.log(`  item ${i}: ${JSON.stringify(it)}`));

  const claims = await sql`
    SELECT id, item_index, status, txn_id, package_id, created_at, released_at, released_reason
    FROM voucher_claims WHERE code = ${CODE} ORDER BY item_index ASC
  `;
  console.log(`\nclaims (${claims.length}):`);
  for (const c of claims) {
    console.log(
      `  #${c.id} item ${c.item_index} · ${c.status} · txn=${c.txn_id} · pkg=${c.package_id} · ${c.created_at}`,
    );
  }

  const kinds = (process.env.TARGET_KINDS ?? "gamezone").split(",");
  const gzIndexes = items
    .map((it, i) => (kinds.includes(it.kind) ? i : -1))
    .filter((i) => i >= 0);
  const targets = claims.filter(
    (c) => gzIndexes.includes(Number(c.item_index)) && c.status !== "released",
  );
  console.log(
    `\ntarget kinds [${kinds.join(", ")}] → item indexes [${gzIndexes.join(", ")}] · claims to release: ${targets.length}`,
  );
  if (targets.length === 0) {
    console.log("Nothing to do — those items are already unclaimed.");
    return;
  }

  if (!APPLY) {
    console.log("\nDRY RUN. Re-run with APPLY=1 to release the claims above.");
    return;
  }

  for (const c of targets) {
    const rows = await sql`
      UPDATE voucher_claims
      SET status = 'released', released_at = NOW(),
          released_reason = 'test reset: un-redeem gz items per Eric 2026-07-31'
      WHERE id = ${c.id} AND code = ${CODE}
      RETURNING id, item_index, status
    `;
    console.log(`  released claim #${c.id} (item ${c.item_index}) → ${rows[0]?.status}`);
  }
  console.log("\nDone. The two token items should now show as available again.");
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
