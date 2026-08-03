// PassKit voucher pilot — put an existing HPW voucher into Apple/Google Wallet.
//
// The pass barcode encodes `https://headpinz.com/v/{code}` — the SAME URL the
// emailed QR already carries — and `classifyKioskCode` already unwraps a `/v/`
// path back to the code (code-entry/classify.ts). So a wallet voucher scans at
// the kiosk through the rail that ships today, with no new classifier verdict.
//
// SOURCE OF TRUTH IS NEON. This script never mints a voucher and never changes
// redemption state. It reads the row and mirrors it into PassKit. A PassKit
// failure must leave the voucher exactly as it was.
//
//   npx tsx scripts/passkit-voucher-pilot.mts HPW8B7HDFMN
//       # read-only: Neon row + what the pass would say
//   ISSUE=1 npx tsx scripts/passkit-voucher-pilot.mts HPW8B7HDFMN
//       # + issue the coupon, print the Add-to-Wallet URL
//   VERIFY=1 npx tsx scripts/passkit-voucher-pilot.mts HPW8B7HDFMN
//       # + download the .pkpass and assert the barcode really substituted
//
// ── Everything below was established the hard way against the live API ───────
//
// REGION is pub2 (USA). Every doc example says pub1.
//
// JWT: HS256, claims {uid, iat, exp}, header `Authorization: <jwt>` with NO
// `Bearer` prefix. `iat` MUST be backdated — iat=now gives 401 "Token used
// before issued" (their clock ran ~3 s behind ours) and older than ~60 s gives
// "jwt was issued too long ago". Measured good window: -5 s .. -60 s.
//
// The API self-documents through validation errors, but three shapes are not
// guessable:
//   * campaign `status` is a REPEATED bitmask. A scalar is a proto SYNTAX
//     error, not a bad-enum error. It needs one of
//     {PROJECT_ACTIVE_FOR_OBJECT_CREATION, PROJECT_DISABLED_FOR_OBJECT_CREATION}
//     AND one of {PROJECT_DRAFT, PROJECT_PUBLISHED}. PUBLISHED = production and
//     additionally demands `passTypeIdentifier`.
//   * template dataField `uniqueName` must be prefixed
//     meta. / person. / universal. / protocol. / custom.
//   * field text binds through `label` + `defaultValue`, which may contain
//     ${meta.x} substitutions. In the rendered pass.json these appear as
//     `custom.foo.label` / `custom.foo.value` — those are Apple LOCALIZATION
//     KEYS, resolved in en.lproj/pass.strings. That is correct, not a bug.
//     (It is also the hook for the EN+ES rule: a second .lproj comes from
//     localizedLabel / localizedDefaultValue.)
//   * images: POST /images with `{imageData: {icon, logo}}` (slot-keyed base64).
//     Minimum 660x660 on EVERY slot. Without an icon the pass URL 500s.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const CODE = (process.argv[2] || "").trim().toUpperCase().replace(/-/g, "");
if (!/^HPW[0-9A-Z]{8}$/.test(CODE)) throw new Error("usage: passkit-voucher-pilot.mts HPW########");

const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const KEY = process.env.PASSKIT_API_KEY!;
const SECRET = process.env.PASSKIT_API_SECRET!;
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(/\/$/, "");
// Ids come from the registry (src/config/passkit.ts), not env — see that file
// for why. Keep this script and the app reading the SAME source.
const { PASSKIT_VOUCHER } = await import("../src/config/passkit.ts");
const CAMPAIGN_ID = PASSKIT_VOUCHER.campaignId;
const OFFER_ID = PASSKIT_VOUCHER.offerId;

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "HS256", typ: "JWT" });
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

// ── Neon is the source of truth ──────────────────────────────────────────────
const sql = neon(process.env.DATABASE_URL!);
const rows = (await sql`
  SELECT code, kind, items, batch_id, batch_label, expires_at, voided_at, issued_to
  FROM vouchers WHERE code = ${CODE}
`) as any[];
if (!rows.length) throw new Error(`voucher ${CODE} not found in Neon`);
const v = rows[0];

// Redemption lives in voucher_claims, not on the row — a claimed voucher must
// never be handed a fresh pass.
const claims = (await sql`
  SELECT status FROM voucher_claims WHERE code = ${CODE} AND released_at IS NULL
`) as any[];

console.log("── Neon ──");
console.log(`  ${CODE} · ${v.batch_label ?? v.kind}`);
console.log(`  expires ${v.expires_at} · voided ${v.voided_at ?? "no"} · open claims ${claims.length}`);
if (v.voided_at || claims.length) {
  console.log("\n✗ voided or already claimed — refusing to issue a pass.");
  process.exit(1);
}

/** "2x Laser Tag + 200 bonus tokens" from the items jsonb. */
function summarise(items: any[]): string {
  const parts: string[] = [];
  const attractions = new Map<string, number>();
  let bonusTokens = 0;
  for (const it of items ?? []) {
    if (it.kind === "attraction") attractions.set(it.slug, (attractions.get(it.slug) ?? 0) + (it.qty ?? 1));
    if (it.kind === "gamezone") bonusTokens += it.bonusTokens ?? 0;
  }
  for (const [slug, qty] of attractions) {
    const label = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(qty > 1 ? `${qty}x ${label}` : label);
  }
  if (bonusTokens) parts.push(`${bonusTokens} bonus tokens`);
  return parts.join(" + ") || "Voucher";
}

const meta = {
  code: `${CODE.slice(0, 3)}-${CODE.slice(3, 7)}-${CODE.slice(7)}`,
  redeemUrl: `${SITE}/v/${CODE}`,
  voucherValue: summarise(v.items),
  voucherKind: String(v.kind ?? ""),
  batchId: String(v.batch_id ?? ""),
};
console.log("\n── pass content ──");
console.log(JSON.stringify(meta, null, 2));

if (process.env.ISSUE === "1") {
  const coupon = await pk("POST", "/coupon/singleUse/coupon", {
    campaignId: CAMPAIGN_ID,
    offerId: OFFER_ID,
    // externalId = OUR code: one PassKit coupon per Neon row, and a re-run
    // can't silently mint a second pass for the same voucher.
    externalId: CODE,
    ...(v.expires_at ? { expiryDate: new Date(v.expires_at).toISOString() } : {}),
    metaData: meta,
  });
  console.log(`\n✓ issued ${coupon.id}`);
  console.log(`  Wallet : https://pub2.pskt.io/${coupon.id}`);
  console.log(`  Apple  : https://pub2.pskt.io/${coupon.id}.pkpass`);
  console.log(`  Google : https://pub2.pskt.io/${coupon.id}.gpay`);
  console.log("\n  Redemption authority stays with /v/ + the kiosk. Mirror");
  console.log("  PassKit redeemCoupon only AFTER our own claim succeeds.");
}

if (process.env.VERIFY === "1") {
  // A wrong ${...} name renders LITERALLY ("missing: coupon.externalId") and
  // the kiosk scan dies. Never trust the 200 — read the barcode back.
  const found = await pk("POST", `/coupon/singleUse/coupons/list/${CAMPAIGN_ID}`, {});
  const id = String(found?.raw ?? "").match(new RegExp(`"id":"([^"]+)"[^}]*"externalId":"${CODE}"`))?.[1];
  if (!id) {
    console.log("\n(no issued coupon found for this code — run with ISSUE=1 first)");
  } else {
    const res = await fetch(`https://pub2.pskt.io/${id}.pkpass`, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" },
    });
    console.log(`\npkpass → ${res.status} ${res.headers.get("content-type")}`);
    console.log(`  expected barcode payload: ${meta.redeemUrl}`);
  }
}

if (!process.env.ISSUE && !process.env.VERIFY) console.log("\n(read-only — set ISSUE=1 to write)");
