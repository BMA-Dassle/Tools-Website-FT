/**
 * LIVE SAMPLE of a deal-pack purchase, end to end, WITHOUT the card charge.
 *
 * Owner 2026-08-03: "I'd like to see example in real action." This drives the
 * REAL production fulfilment path — the same `fulfilDealPurchase` the purchase
 * route and the reconcile cron call — so the mint, the email, the SMS and the
 * `/v/{code}` page are all genuinely exercised.
 *
 * WHY NO CHARGE: the packs sell at HeadPinz Fort Myers / Naples, which are
 * REVENUE Square locations, and the standing rule is that test charges only ever
 * touch the probe location (6MZJFTGAYD7TC). So this writes the purchase row and
 * marks it charged with NO Square ids, which is exactly the state a purchase
 * occupies between capture and fulfilment. Everything downstream of the money is
 * real.
 *
 * It writes a real bearer instrument to production Neon and sends real email/SMS,
 * so it is gated behind APPLY=1 and defaults to a dry run. Staff contacts only.
 *
 * Usage:
 *   npx tsx scripts/deal-pack-sample.mts                    # dry run
 *   APPLY=1 npx tsx scripts/deal-pack-sample.mts            # mint + email
 *   APPLY=1 SMS=1 npx tsx scripts/deal-pack-sample.mts      # + text
 *   DEAL=gel-blaster-game-card-pack QTY=2 ...               # overrides
 *
 * Void afterwards:
 *   POST /api/admin/deals { action:"void", token, purchaseId, reason }
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
    /* next */
  }
}
function envVal(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envRaw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
for (const k of [
  "DATABASE_URL",
  "SQUARE_ACCESS_TOKEN",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "TWILIO_SID",
  "TWILIO_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "NEXT_PUBLIC_SITE_URL",
]) {
  if (!process.env[k]) {
    const v = envVal(k);
    if (v) process.env[k] = v;
  }
}
process.env.NEXT_PUBLIC_SITE_URL ||= "https://headpinz.com";

const APPLY = process.env.APPLY === "1";
const WITH_SMS = process.env.SMS === "1";
const SLUG = process.env.DEAL || "laser-tag-game-card-pack";
const QTY = Math.max(1, Math.min(10, Number(process.env.QTY || "1")));
const EMAIL = process.env.EMAIL || "eric@headpinz.com";
const PHONE = process.env.PHONE || "";
const NAME = process.env.NAME || "Eric Osborn";
const LOCATION = (process.env.LOCATION || "headpinz") as "headpinz" | "naples";
/** Default TRUE, matching the buy panel: all packs on one code. */
const COMBINE = process.env.COMBINE !== "0";

const { getDeal, dealValue, dealVoucherSummary, DEAL_LOCATION_INFO } = await import(
  "../src/features/deals/catalog.js"
);
const { insertDealPurchase, markDealPurchaseCharged, getDealPurchase } = await import(
  "../src/features/deals/data/deal-purchases-db.js"
);
const { fulfilDealPurchase, dealScheduleUrl } = await import(
  "../src/features/deals/service/purchase.js"
);
const { quoteDeal } = await import("../src/features/deals/service/quote.js");
const { currentDealOffer } = await import("../src/features/deals/service/offer.js");

const deal = getDeal(SLUG);
if (!deal) throw new Error(`unknown deal ${SLUG}`);
const info = DEAL_LOCATION_INFO[LOCATION];

// Resolve through the SAME offer resolver and price through the SAME Square
// dry-run the page uses, so a sample minted during a limited offer carries the
// bonus and the row reads back exactly like a real purchase would.
const offer = await currentDealOffer(deal);
const quote = await quoteDeal({
  deal,
  location: LOCATION,
  qty: QTY,
  unitPriceCents: offer.unitPriceCents,
});
const value = dealValue(deal, LOCATION, offer.unitPriceCents, offer.bonusItems);

console.log(`\n${deal.name} ×${QTY} @ ${info.label}`);
console.log(`  carries      ${dealVoucherSummary(deal, COMBINE ? QTY : 1, offer.bonusItems)}`);
console.log(`  delivery     ${COMBINE ? `ONE code for all ${QTY} pack(s)` : `${QTY} separate codes`}`);
console.log(`  à la carte   $${(value.compareAtCents / 100).toFixed(2)}  (save ${value.savingsPct}%)`);
console.log(
  `  quoted       $${(quote.subtotalCents / 100).toFixed(2)} + $${(quote.taxCents / 100).toFixed(2)} tax = $${(quote.totalCents / 100).toFixed(2)}`,
);
console.log(`  to           ${EMAIL}${WITH_SMS && PHONE ? ` + SMS ${PHONE}` : ""}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with APPLY=1 to mint + send.\n");
  process.exit(0);
}

const row = await insertDealPurchase({
  dealSlug: deal.slug,
  locationKey: LOCATION,
  centerCode: info.centerCode,
  qty: QTY,
  combine: COMBINE,
  unitPriceCents: offer.unitPriceCents,
  subtotalCents: quote.subtotalCents,
  taxCents: quote.taxCents,
  totalCents: quote.totalCents,
  buyerName: NAME,
  buyerEmail: EMAIL,
  buyerPhone: WITH_SMS ? PHONE : null,
  smsOptIn: WITH_SMS && !!PHONE,
  // Marked so nobody mistakes this for revenue on the sales board.
  idempotencyKey: `sample-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  bonusItems: offer.bonusItems,
  utm: { utm_source: "script", utm_campaign: "deal-pack-sample" },
  clickwrapVersion: "sample-no-charge",
});
console.log(`\npurchase row #${row.id} written (pending)`);

// No Square ids: this is the exact state a purchase sits in between capture and
// fulfilment, and it keeps the row obviously non-revenue.
await markDealPurchaseCharged(row.id, { squareOrderId: null, squarePaymentId: null });
const charged = (await getDealPurchase(row.id))!;

const res = await fulfilDealPurchase(charged);
console.log(`minted: ${res.codes.join(", ") || "(none)"}`);
console.log(`mintPending=${res.mintPending} emailPending=${res.emailPending}`);

const origin = process.env.NEXT_PUBLIC_SITE_URL;
for (const code of res.codes) console.log(`  voucher page  ${origin}/v/${code}`);
const sched = dealScheduleUrl({ deal, location: LOCATION, codes: res.codes });
if (sched) console.log(`  book it       ${origin}${sched}`);
console.log(`  sales board   ${origin}/admin/<ADMIN_CAMERA_TOKEN>/deals\n`);
