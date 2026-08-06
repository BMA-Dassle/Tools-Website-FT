// Build / update the HeadPinz voucher pass DESIGN in PassKit.
//
// Separate from passkit-voucher-pilot.mts on purpose: that one issues a coupon
// for a Neon voucher row, this one owns the look. Re-runnable — it rebuilds the
// images and PUTs the template, so the design lives in git rather than in
// whatever someone last clicked in the portal.
//
//   npx tsx scripts/passkit-voucher-template.mts          # dry run, prints plan
//   APPLY=1 npx tsx scripts/passkit-voucher-template.mts  # upload + PUT
//
// ── Layout decisions, and why ────────────────────────────────────────────────
//
// NO PRIMARY FIELD. Apple lays primaryFields OVER the strip image. The first
// version put the offer there and it printed giant white text across four kids'
// faces, with the "YOUR VOUCHER" label rendering UNDER its own value. Everything
// visible now sits below the strip, on flat background, where it's legible.
//
// NO CODE FIELD. The barcode's altText already prints HPW-8B7H-DFMN directly
// under the QR (owner, 2026-08-03: "do we really need code in line text when we
// have it under qr"). One row: what it's worth, and when it expires.
//
// CODE + LOCATIONS LIVE ON THE BACK. The face stays a coupon; the small print
// has room to be a real sentence instead of truncating to "HeadPinz Fort Myers…".
//
// EVERY IMAGE IS FLATTENED ONTO THE PASS BACKGROUND. PassKit composites
// transparent PNGs onto BLACK, which renders as a dark box around a transparent
// logo on a coloured card. Flattening onto BG_HEX makes the seam vanish.
//
// STRIP CROP IS TOP-BIASED. sharp's `position: "attention"` picked a
// centre-weighted crop that sliced the tallest kid's head off.
//
// PassKit constraints, learned the hard way: min 660x660 on EVERY image slot;
// `POST /images` takes `{imageData: {icon, logo, strip}}` slot-keyed base64;
// dataField uniqueName must be prefixed meta./person./universal./protocol./custom.;
// field text binds through `label` + `defaultValue` and may carry ${meta.x}.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import sharp from "sharp";

const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const KEY = process.env.PASSKIT_API_KEY!;
const SECRET = process.env.PASSKIT_API_SECRET!;
const TEMPLATE_ID = (await import("../src/config/passkit")).PASSKIT_VOUCHER.templateId;

/** Pass background. Every image is flattened onto exactly this. */
const BG_HEX = "#0c1226";
const BG = { r: 0x0c, g: 0x12, b: 0x26, alpha: 1 };
const LABEL_HEX = "#ff5a5f";

const LOGO = "public/brand/hp-logo.webp";
const STRIP_PHOTO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg";

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "HS256", typ: "JWT" });
  // Backdated iat — see passkit-voucher-pilot.mts header.
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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function buildImages() {
  const logoSrc = resolve(process.cwd(), LOGO);
  // hp-logo is 2.91:1 — hold that aspect at the 660px floor so it isn't
  // letterboxed down to a stamp.
  const logo = await sharp(logoSrc)
    .trim()
    .resize(1922, 660, { fit: "contain", background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();
  const icon = await sharp(logoSrc)
    .trim()
    .resize(620, 240, { fit: "contain", background: BG })
    .extend({ top: 210, bottom: 210, left: 20, right: 20, background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();

  const W = 1600;
  const H = 620;
  // Scrim: knock the photo back at top and bottom, fade fully into the card at
  // the bottom edge so there's no visible seam where the strip ends.
  const scrim = Buffer.from(
    `<svg width="${W}" height="${H}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%"   stop-color="${BG_HEX}" stop-opacity="0.55"/>
         <stop offset="35%"  stop-color="${BG_HEX}" stop-opacity="0.15"/>
         <stop offset="82%"  stop-color="${BG_HEX}" stop-opacity="0.55"/>
         <stop offset="100%" stop-color="${BG_HEX}" stop-opacity="1"/>
       </linearGradient></defs>
       <rect width="${W}" height="${H}" fill="url(#g)"/>
     </svg>`,
  );
  const photo = Buffer.from(await (await fetch(STRIP_PHOTO)).arrayBuffer());
  const strip = await sharp(photo)
    .resize(W, H, { fit: "cover", position: "top" })
    .composite([{ input: scrim, blend: "over" }])
    .flatten({ background: BG })
    .png()
    .toBuffer();

  return { icon, logo, strip };
}

const field = (o: {
  uniqueName: string;
  label: string;
  value: string;
  section: string;
  priority: number;
  align?: string;
  /**
   * iOS lock-screen text when this field's value changes. `%@` is the new value.
   *
   * THE HELPER MUST EMIT THIS OR THE PUT SILENTLY DELETES IT. `PUT /template`
   * replaces the whole template, so any key this builder omits is dropped from
   * the live design — and that is exactly what nearly happened here: the live
   * template carried "Voucher updated: %@ left" on custom.offer, set outside
   * this script, and the helper had no way to express it. Losing it would kill
   * the notification a guest gets the moment a kiosk takes a leg, which is the
   * whole point of syncing the pass in-request (see voucher-pass.ts rule 1).
   *
   * Exactly ONE field should carry one. Two would mean two notifications for a
   * single redemption.
   */
  changeMessage?: string;
}) => ({
  uniqueName: o.uniqueName,
  templateId: "",
  fieldType: "CUSTOM_FIELDS",
  isRequired: false,
  label: o.label,
  dataType: "TEXT",
  defaultValue: o.value,
  validation: "",
  userCanSetValue: false,
  currencyCode: "",
  appleWalletFieldRenderOptions: {
    textAlignment: o.align ?? "LEFT",
    positionSettings: { section: o.section, priority: o.priority },
    changeMessage: o.changeMessage ?? "",
    dateStyle: "DATE_TIME_STYLE_DO_NOT_USE",
    timeStyle: "DATE_TIME_STYLE_DO_NOT_USE",
    numberStyle: "NUMBER_STYLE_DO_NOT_USE",
    suppressLinkDetection: [],
    ignoreTimezone: false,
    isRelativeDate: false,
  },
  usage: ["USAGE_APPLE_WALLET", "USAGE_GOOGLE_PAY"],
  googlePayFieldRenderOptions: {
    googlePayPosition: "GOOGLE_PAY_TEXT_MODULE",
    textModulePriority: o.priority,
  },
});

const DATA_FIELDS = [
  // "REMAINING", not "YOUR VOUCHER" — the label the LIVE template has always
  // carried, and the deliberate one (pass-content.ts): an untouched voucher's
  // remaining IS everything it was minted with, so one wording works in every
  // state and partial redemption needs no second template. This script was
  // written with "YOUR VOUCHER" and never applied, so the two had silently
  // disagreed since day one; the first APPLY would have flipped it.
  field({
    uniqueName: "custom.offer",
    label: "REMAINING",
    value: "${meta.voucherValue}",
    section: "SECONDARY_FIELDS",
    priority: 0,
    changeMessage: "Voucher updated: %@ left",
  }),
  field({
    uniqueName: "custom.expires",
    label: "EXPIRES",
    value: "${meta.expires}",
    section: "SECONDARY_FIELDS",
    priority: 1,
    align: "RIGHT",
  }),
  // THE FACE CANNOT HOLD A VIP GRANT. custom.offer is capped at 34 chars because
  // Apple elides past that, and "Laser Tag or Gel Blasters" is 25 of them on its
  // own — so every Ultimate VIP Experience voucher, at every party size, renders
  // as "400 Tokens + 2 more". Before this field existed, nothing anywhere on the
  // pass said what the other 2 were. Back fields have no width pressure, so the
  // unabridged list goes here (pass-content.ts `detailRemaining`), derived from
  // the same grouping as the face so the two sides can never disagree.
  field({
    uniqueName: "custom.detail",
    label: "What's on this voucher",
    value: "${meta.voucherDetail}",
    section: "BACK_FIELDS",
    priority: 0,
  }),
  field({
    uniqueName: "custom.howto",
    label: "How to redeem",
    value:
      "Scan this pass at any HeadPinz kiosk, or type the code on the " +
      "'Coupon or voucher?' screen. Game Zone credit loads onto a card right there; " +
      "attraction passes come off your total when you book them.",
    section: "BACK_FIELDS",
    priority: 1,
  }),
  field({
    uniqueName: "custom.where",
    label: "Where",
    value: "HeadPinz Fort Myers · HeadPinz Naples",
    section: "BACK_FIELDS",
    priority: 2,
  }),
  // NOT "one-time use". A voucher carrying nine legs is redeemed IN PIECES —
  // partial redemption is the whole design (voucher-pass.ts), and the old wording
  // told a VIP guest their remaining eight entitlements were gone.
  field({
    uniqueName: "custom.terms",
    label: "Terms",
    value:
      "Each item can be used once. Not transferable, not redeemable for cash. " +
      "Valid until the expiry date shown.",
    section: "BACK_FIELDS",
    priority: 3,
  }),
];

console.log("template :", TEMPLATE_ID);
console.log("barcode  : QR → ${meta.redeemUrl}, altText ${meta.code}");
console.log("colors   :", BG_HEX, "/ labels", LABEL_HEX);

/**
 * DIFF THE PLAN AGAINST WHAT IS LIVE, BEFORE TOUCHING IT.
 *
 * `PUT /template` is a FULL REPLACE, so every field this script does not
 * reproduce is deleted from the live design — silently, and only visible on a
 * guest's phone. The old dry run printed a list of field NAMES, which cannot
 * show either failure mode that actually bit: a label this script had never
 * matched to production ("YOUR VOUCHER" vs the live "REMAINING"), and a
 * changeMessage the helper had no way to express and would have dropped.
 *
 * Read this table before setting APPLY=1. Anything under CHANGE or REMOVED that
 * you did not intend is a regression you are about to ship.
 */
// Fetched HERE, before the APPLY gate, because the dry run's whole job is to
// compare against it. Reused by the apply path below — one read, one truth.
const list = await pk("POST", "/templates/list", {});
const liveFields: any[] = (() => {
  const t = String(list.raw ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)?.result?.template;
      } catch {
        return null;
      }
    })
    .find((t: any) => t?.id === TEMPLATE_ID);
  return t?.data?.dataFields ?? [];
})();

console.log("\nfields (proposed vs live):");
const pos = (f: any) => f.appleWalletFieldRenderOptions.positionSettings;
for (const f of DATA_FIELDS) {
  const l = liveFields.find((x) => x.uniqueName === f.uniqueName);
  const where = `${pos(f).section.replace("_FIELDS", "").toLowerCase()} p${pos(f).priority}`;
  if (!l) {
    console.log(`  NEW     ${f.uniqueName.padEnd(15)} ${where.padEnd(14)} ${f.label}`);
    continue;
  }
  const d: string[] = [];
  if (l.label !== f.label) d.push(`label ${JSON.stringify(l.label)} → ${JSON.stringify(f.label)}`);
  if (l.defaultValue !== f.defaultValue) d.push("value");
  const lc = l.appleWalletFieldRenderOptions?.changeMessage || "";
  const fc = f.appleWalletFieldRenderOptions.changeMessage || "";
  if (lc !== fc) d.push(`changeMessage ${JSON.stringify(lc)} → ${JSON.stringify(fc)}`);
  const lp = l.appleWalletFieldRenderOptions?.positionSettings ?? {};
  if (lp.section !== pos(f).section) d.push(`section ${lp.section} → ${pos(f).section}`);
  if ((lp.priority ?? 0) !== pos(f).priority) d.push(`priority ${lp.priority ?? 0} → ${pos(f).priority}`);
  console.log(
    `  ${d.length ? "CHANGE " : "same   "} ${f.uniqueName.padEnd(15)} ${where.padEnd(14)} ${d.join(" | ")}`,
  );
}
for (const l of liveFields) {
  if (!DATA_FIELDS.find((f) => f.uniqueName === l.uniqueName)) {
    console.log(`  REMOVED ${l.uniqueName} — this field will be DELETED from the live pass`);
  }
}

if (process.env.APPLY !== "1") {
  console.log("\n(dry run — set APPLY=1 to upload images and PUT the template)");
  process.exit(0);
}

const imgs = await buildImages();
console.log(
  `\nimages built: icon ${imgs.icon.length}B, logo ${imgs.logo.length}B, strip ${imgs.strip.length}B`,
);
const ids = await pk("POST", "/images", {
  imageData: {
    icon: imgs.icon.toString("base64"),
    logo: imgs.logo.toString("base64"),
    strip: imgs.strip.toString("base64"),
  },
});
console.log("uploaded:", ids.icon, ids.logo, ids.strip);

// PUT replaces the whole template, so read the current one first — anything
// dropped here is silently deleted from the design.
const tpl = String(list.raw ?? "")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)?.result?.template;
    } catch {
      return null;
    }
  })
  .find((t: any) => t?.id === TEMPLATE_ID);
if (!tpl) throw new Error(`template ${TEMPLATE_ID} not found`);

await pk("PUT", "/template", {
  ...tpl,
  description: "HeadPinz voucher",
  colors: { backgroundColor: BG_HEX, labelColor: LABEL_HEX, textColor: "#ffffff" },
  imageIds: { ...(tpl.imageIds ?? {}), icon: ids.icon, logo: ids.logo, strip: ids.strip },
  barcode: {
    ...tpl.barcode,
    // ${coupon.externalId} does NOT exist — it renders literally as
    // "missing: coupon.externalId" and only fails at a kiosk. Drive both off
    // per-coupon metaData.
    //
    // THE PAYLOAD IS THE URL, NOT THE CODE, so one symbol serves both readers: a
    // phone camera opens /v/{code}, and the kiosk pulls the code back out of the
    // path (code-entry/classify.ts). IF A KIOSK SCANNER EVER FAILS ON THIS, the
    // lever is `payload: "${meta.code}"` — a 27-char URL is a much denser symbol
    // at Wallet's fixed render size than a 13-char code, and the wedge mangling
    // ':' or '/' would drop the whole string to `unknown` (the native-voucher
    // branch is never reached for a string containing slashes). The cost of
    // pulling it is losing the phone-camera deep link. Test before you pull it.
    payload: "${meta.redeemUrl}",
    altText: "${meta.code}",
    format: "QR",
  },
  data: { ...tpl.data, dataFields: DATA_FIELDS },
});
console.log("\ntemplate updated. Verify with:");
console.log("  ISSUE=1 npx tsx scripts/passkit-voucher-pilot.mts <CODE>");
