/**
 * LIVE MINT: issue Game Zone test vouchers and email them to staff.
 *
 * Writes real bearer instruments to production Neon and sends real email, so it
 * is gated behind APPLY=1 and defaults to a dry run that shows exactly what it
 * would do. Recipients are hard-coded to staff addresses — this script must
 * never be pointed at a guest list.
 *
 * Each recipient gets their OWN batch (separate batch_id + batchLabel) so the
 * voucher_events audit attributes every redemption to whose test it was.
 *
 * Usage:
 *   npx tsx scripts/gz-voucher-mint-test.mts            # dry run
 *   APPLY=1 npx tsx scripts/gz-voucher-mint-test.mts    # mint + email
 *   APPLY=1 COUNT=5 TOKENS=200 npx tsx scripts/gz-voucher-mint-test.mts
 *
 * NOTE: the codes are only redeemable once this branch is DEPLOYED — the kiosk
 * voucher tile and /api/game-cards/voucher-redeem don't exist in production yet.
 * The vouchers themselves are valid from the moment they're minted.
 */
import { readFileSync } from "node:fs";

// Env lives in the primary working tree; this script runs from a worktree.
const ENV_CANDIDATES = [
  new URL("../.env.local", import.meta.url),
  new URL("file:///C:/GIT/Tools-Website-FT/apps/web/.env.local"),
];
let envRaw = "";
for (const u of ENV_CANDIDATES) {
  try {
    envRaw = readFileSync(u, "utf8");
    break;
  } catch {
    /* try the next candidate */
  }
}
function envVal(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envRaw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
// Hydrate process.env BEFORE importing anything that reads it at module scope.
for (const k of [
  "DATABASE_URL",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "NEXT_PUBLIC_SITE_URL",
]) {
  const v = envVal(k);
  if (v) process.env[k] = v;
}
process.env.NEXT_PUBLIC_SITE_URL ||= "https://headpinz.com";

const APPLY = process.env.APPLY === "1";
const COUNT = Number(process.env.COUNT ?? 3);
const TOKENS = Number(process.env.TOKENS ?? 100);
/** Staff only. Never a guest address. */
const RECIPIENTS = [
  { email: "eric@headpinz.com", name: "Eric" },
  { email: "alex@headpinz.com", name: "Alex" },
];
/** Bound the blast radius if a test code leaks. */
const EXPIRES_AT = new Date(Date.now() + 90 * 86_400_000).toISOString();

async function main() {
  const { mintVouchers, gameZoneItem } = await import("../src/features/game-cards/service/native-voucher");
  const { emailMintBatch, voucherRedeemUrl } = await import("../src/features/game-cards/service/voucher-mail");
  const { formatVoucherCode } = await import("../src/features/game-cards/vouchers/codes");

  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} · ${COUNT} × ${TOKENS} bonus tokens per recipient · ` +
      `expires ${EXPIRES_AT.slice(0, 10)}`,
  );
  console.log(`recipients: ${RECIPIENTS.map((r) => r.email).join(", ")}`);
  if (!envVal("DATABASE_URL")) throw new Error("DATABASE_URL missing");
  if (!envVal("SENDGRID_API_KEY")) throw new Error("SENDGRID_API_KEY missing");

  if (!APPLY) {
    console.log("\nNothing written. Re-run with APPLY=1 to mint and send.");
    return;
  }

  for (const r of RECIPIENTS) {
    const label = `Kiosk test — ${r.name}`;
    const { batchId, vouchers } = await mintVouchers({
      count: COUNT,
      items: [gameZoneItem(TOKENS)],
      batchLabel: label,
      expiresAt: EXPIRES_AT,
      issuedSource: "script:gz-voucher-mint-test",
      createdBy: r.email,
    });
    const codes = vouchers.map((v) => v.code);
    console.log(`\n${r.email} · batch ${batchId}`);
    for (const c of codes) console.log(`   ${formatVoucherCode(c)}   ${voucherRedeemUrl(c)}`);

    const mail = await emailMintBatch({
      to: r.email,
      codes,
      items: [gameZoneItem(TOKENS)],
      batchLabel: label,
      batchId,
      expiresAt: EXPIRES_AT,
    });
    console.log(`   email → ${mail.ok ? "SENT" : `FAILED: ${mail.error}`}`);
    if (!mail.ok) {
      console.log("   (the vouchers ARE minted and valid — only the mail failed)");
    }
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
