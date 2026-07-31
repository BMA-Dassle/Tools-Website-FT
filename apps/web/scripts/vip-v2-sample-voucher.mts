/**
 * LIVE MINT: one SAMPLE "Ultimate VIP Experience V2" voucher each for Eric and
 * Alex, emailed with the scannable QR — owner 2026-07-31: "Send a sample VIP
 * experience QR to eric and alex to test on kiosk."
 *
 * Shape mirrors the V2 grant for a 2-person booking, using ONLY item kinds the
 * DEPLOYED prod code understands (the `attraction-choice` laser-OR-gel kind
 * ships with feat/vip-v2-voucher-plumbing; until that deploys, the sample
 * carries one laser-tag and one gel-blaster item instead):
 *   2 × Game Zone $10 card (100 bonus tokens)  → kiosk dispenses two cards
 *   1 × laser tag + 1 × gel blaster            → cart-rail legs
 *   1 × Shuffly hour                            → cart-rail leg
 *
 * Writes real bearer instruments to production Neon and sends real email, so
 * it is gated behind APPLY=1 and defaults to a dry run. Staff addresses only.
 *
 * Usage:
 *   npx tsx scripts/vip-v2-sample-voucher.mts            # dry run
 *   APPLY=1 npx tsx scripts/vip-v2-sample-voucher.mts    # mint + email
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
/** Staff only. Never a guest address. */
const RECIPIENTS = [
  { email: "eric@headpinz.com", name: "Eric" },
  { email: "alex@headpinz.com", name: "Alex" },
];
/** Match the real V2 grant: 1 year out (real vouchers run from the race date). */
const EXPIRES_AT = new Date(Date.now() + 365 * 86_400_000).toISOString();

async function main() {
  const { mintVouchers, gameZoneItem } = await import(
    "../src/features/game-cards/service/native-voucher"
  );
  const { sendVoucherToGuest, voucherRedeemUrl, itemsSummary } = await import(
    "../src/features/game-cards/service/voucher-mail"
  );
  const { formatVoucherCode } = await import("../src/features/game-cards/vouchers/codes");

  // Deployed-compatible V2 sample (see header).
  const items = [
    gameZoneItem(100),
    gameZoneItem(100),
    { kind: "attraction" as const, slug: "laser-tag", qty: 1 },
    { kind: "attraction" as const, slug: "gel-blaster", qty: 1 },
    { kind: "attraction" as const, slug: "shuffly", qty: 1 },
  ];

  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} · 1 voucher per recipient · ${itemsSummary(items)} · ` +
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
    const label = `VIP V2 sample — ${r.name}`;
    const { batchId, vouchers } = await mintVouchers({
      count: 1,
      items,
      batchLabel: label,
      expiresAt: EXPIRES_AT,
      issuedSource: "script:vip-v2-sample-voucher",
      createdBy: r.email,
    });
    const code = vouchers[0].code;
    console.log(`\n${r.email} · batch ${batchId}`);
    console.log(`   ${formatVoucherCode(code)}   ${voucherRedeemUrl(code)}`);

    const mail = await sendVoucherToGuest({
      code,
      items,
      email: r.email,
      name: r.name,
      expiresAt: EXPIRES_AT,
    });
    console.log(`   email → ${mail.emailOk ? "SENT" : `FAILED: ${mail.error}`}`);
    if (!mail.emailOk) {
      console.log("   (the voucher IS minted and valid — only the mail failed)");
    }
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
