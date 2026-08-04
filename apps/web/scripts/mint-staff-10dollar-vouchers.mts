/**
 * LIVE MINT: 4 × $10 (100 bonus tokens) HPW vouchers each for Jacob and Eric,
 * emailed as QR codes — owner request 2026-07-31 ("email jacob and eric QRs
 * for a free $10 codes. I need 4 a piece using our internal system").
 *
 * Modeled 1:1 on scripts/gz-voucher-mint-test.mts (the proven staff mint).
 * Writes real bearer instruments to production Neon and sends real email, so
 * it is gated behind APPLY=1. Recipients are hard-coded staff addresses.
 * Each recipient gets their OWN batch so voucher_events attributes redemptions.
 */
import { readFileSync } from "node:fs";

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
const COUNT = 4;
/** $10 of play at the 10¢/token rate — the owner's own convention (grants.ts). */
const TOKENS = 100;
/** Staff only. Never a guest address. */
const RECIPIENTS = [
  { email: "jacob@headpinz.com", name: "Jacob" },
  { email: "eric@headpinz.com", name: "Eric" },
];
const EXPIRES_AT = new Date(Date.now() + 90 * 86_400_000).toISOString();

async function main() {
  const { mintVouchers, gameZoneItem } = await import(
    "../src/features/game-cards/service/native-voucher"
  );
  const { emailMintBatch, voucherRedeemUrl } = await import(
    "../src/features/game-cards/service/voucher-mail"
  );
  const { formatVoucherCode } = await import("../src/features/game-cards/vouchers/codes");

  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} · ${COUNT} × ${TOKENS} bonus tokens ($10) per recipient · ` +
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
    const label = `$10 on us — ${r.name}`;
    const { batchId, vouchers } = await mintVouchers({
      count: COUNT,
      items: [gameZoneItem(TOKENS)],
      batchLabel: label,
      expiresAt: EXPIRES_AT,
      issuedSource: "script:mint-staff-10dollar-vouchers",
      createdBy: "eric@headpinz.com",
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
