// Voucher OFFER config in PassKit — the expiry policy in particular.
//
// WHY THIS SCRIPT EXISTS. The offer was created with
// `couponExpiryType: AUTO_EXPIRE_OFFER_END_DATE`, which drives every coupon's
// expiry from the OFFER's end date. That looked correct only because the offer
// end date happened to equal the first test voucher's expiry. Real vouchers each
// carry their own `vouchers.expires_at` (a 12-month deal pack bought today
// expires on a different day from one bought next month), so the policy must be
// **EXPIRE_ON_VARIABLE_DATE_TIME** and let the per-coupon `expiryDate` we already
// send govern.
//
// It matters twice over: PassKit deletes a pass record 90 days after expiry, so a
// wrong expiry is also wrong retention — and a guest whose pass greys out early
// has been told their money is gone.
//
//   npx tsx scripts/passkit-voucher-offer.mts          # read + diff, no writes
//   APPLY=1 npx tsx scripts/passkit-voucher-offer.mts  # PUT the corrected offer
//
// PUT replaces the whole offer, so this reads the live object first and changes
// only the expiry settings — anything dropped here would be silently deleted.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { PASSKIT_VOUCHER } = await import("../src/config/passkit");

const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const KEY = process.env.PASSKIT_API_KEY!;
const SECRET = process.env.PASSKIT_API_SECRET!;

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "HS256", typ: "JWT" });
  // Backdated iat — see src/lib/api/passkit.ts for the measured window.
  const b = b64u({ uid: KEY, iat: now - 30, exp: now + 50 });
  const s = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${s}`;
}
async function pk(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: jwt(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Each coupon's own `expiryDate` governs — see the header. */
const WANT = "EXPIRE_ON_VARIABLE_DATE_TIME";

/**
 * The issue window bounds when a coupon may be CREATED, and it was set to the
 * first test voucher's expiry (2027-08-04) — the same mistake as the expiry type,
 * from the same cause. Vouchers are minted continuously, so a pack sold in 2027
 * with a 12-month life would fall outside it and the guest's Add-to-Wallet tap
 * would just fail. Push it far enough out that it is never the thing that breaks;
 * the guard that matters is the per-coupon expiryDate, not this.
 */
const WANT_ISSUE_END = "2035-12-31T23:59:59Z";

const offer = await pk("GET", `/coupon/singleUse/offer/${PASSKIT_VOUCHER.offerId}`);
const current = offer?.couponExpirySettings?.couponExpiryType ?? "(unset)";
console.log(`offer ${PASSKIT_VOUCHER.offerId}`);
console.log(`  title        : ${offer?.offerTitle}`);
console.log(`  expiry type  : ${current}`);
console.log(`  wanted       : ${WANT}`);
console.log(`  issue window : ${offer?.issueStartDate} → ${offer?.issueEndDate}`);
console.log(`  redeem window: ${offer?.redemptionStartDate} → ${offer?.redemptionEndDate}`);

const issueEnd = offer?.issueEndDate ?? "(unset)";
const issueEndOk = issueEnd === WANT_ISSUE_END;
console.log(`  issue end ok : ${issueEndOk} (want ${WANT_ISSUE_END})`);

if (current === WANT && issueEndOk) {
  console.log("\nalready correct — nothing to do");
  process.exit(0);
}
if (process.env.APPLY !== "1") {
  console.log("\n(dry run — set APPLY=1 to write)");
  process.exit(0);
}

// Read-modify-write: keep every other field byte-for-byte.
await pk("PUT", "/coupon/singleUse/offer", {
  ...offer,
  couponExpirySettings: { ...(offer.couponExpirySettings ?? {}), couponExpiryType: WANT },
  issueEndDate: WANT_ISSUE_END,
});

const after = await pk("GET", `/coupon/singleUse/offer/${PASSKIT_VOUCHER.offerId}`);
const now = after?.couponExpirySettings?.couponExpiryType;
console.log(`\nexpiry type now : ${now}`);
console.log(`issue end now   : ${after?.issueEndDate}`);
// A vendor 200 is not proof of effect — re-read and assert BOTH.
if (now !== WANT || after?.issueEndDate !== WANT_ISSUE_END) {
  console.error("✗ PUT returned 200 but a value did not change");
  process.exit(1);
}
console.log("✓ applied");
