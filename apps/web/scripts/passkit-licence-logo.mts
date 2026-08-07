/**
 * Put the FastTrax mark on the racing licence — the ONE thing the live template
 * is missing.
 *
 * THE SYMPTOM (owner's wallet, 2026-08-06): in the stacked Wallet view every
 * other pass shows a small logo and a name; the racing licence is a blank navy
 * strip.
 *
 * THE TEMPLATE LOOKS FINE, which is why this took unpacking a real pass to see.
 * `imageIds.logo` and `imageIds.appleLogo` are both set. But download a live
 * `.pkpass` and read its manifest and the truth is:
 *
 *     icon.png                                    ← root, correct
 *     strip.png                                   ← root, correct
 *     images.lproj/{imageId}/logo/logo.png        ← NOT WHERE APPLE LOOKS
 *
 * Apple resolves pass images from the bundle ROOT, or from a `<lang>.lproj`
 * directory matching the device's language. `images.lproj` is not a language
 * code, so no device ever matches it and Apple falls back to a root `logo.png`
 * that does not exist. The logo ships in the file and renders nowhere.
 *
 * `logoText` was empty too, so the header row had no text to fall back on
 * either — and pass.json carried no `logoText` key at all. Between them, the
 * collapsed row had literally nothing to draw.
 *
 * SETTING logoText IS THE RELIABLE HALF of this fix: it is text, so it cannot be
 * lost to an image-path quirk and it reads at the size Apple draws that row. The
 * logo re-upload is the other half; verify the manifest afterwards rather than
 * assuming it moved.
 *
 * ── WHY THIS EXISTS ALONGSIDE passkit-licence-pass.mts ──────────────────────
 * That script already contains this fix and would apply it. It also rewrites
 * `data.dataFields` from its own DATA_FIELDS constant, rebuilds the strip, and
 * can create the program — and `PUT /template` REPLACES the template, so
 * anything the live copy has that the constant does not is silently deleted.
 * That is precisely how a template PUT nearly wiped the pass's changeMessage
 * alert on 2026-08-06 (`e44d84b4`). Twenty-eight live passes is the wrong place
 * to find out the constant has drifted.
 *
 * So this touches TWO KEYS and spreads the rest of the live template through
 * untouched, and it prints a full SAME/CHANGE/NEW/REMOVED table before it will
 * write anything.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * A template change re-renders every pass in the programme, so this is one push
 * to each live holder. Apple warned us about update volume on 2026-08-06 — this
 * is a one-time correction, not a loop, but it is not free. The dry run prints
 * the holder count so the number is known before the button is pressed.
 *
 *   DRY:     node --env-file=apps/web/.env.local apps/web/scripts/passkit-licence-logo.mts
 *   EXECUTE: APPLY=1 node --env-file=apps/web/.env.local apps/web/scripts/passkit-licence-logo.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {}
}

const APPLY = process.env.APPLY === "1";
const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const TEMPLATE_ID = "75paqKfII1FIn9kImwIvi2";
/** Card background. The mark is flattened onto this — PassKit composites
 *  transparency onto BLACK, which reads as a dark box on a coloured card. */
const BG = { r: 0x00, g: 0x04, b: 0x18, alpha: 1 };

function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ uid: process.env.PASSKIT_API_KEY, iat: now - 30, exp: now + 60 }),
  ).toString("base64url");
  const sig = createHmac("sha256", process.env.PASSKIT_API_SECRET!)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function pk(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: jwt(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* ndjson or empty */
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

// ── Read the LIVE template. Never build a PUT from a constant. ──────────────
const list = await pk("POST", "/templates/list", {});
const rows = String(list.text)
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Array<{ result?: { template?: Record<string, unknown> } }>;

const live = rows.map((r) => r.result?.template).find((t) => t?.id === TEMPLATE_ID);
if (!live) throw new Error(`template ${TEMPLATE_ID} not found — refusing to write`);

console.log(`template ${TEMPLATE_ID} "${live.name}" revision ${live.revision}`);
console.log(`  imageIds now : ${JSON.stringify(live.imageIds ?? null)}`);
console.log(
  `  logoText now : ${JSON.stringify(
    (live.appleWalletSettings as Record<string, unknown> | undefined)?.logoText ?? null,
  )}\n`,
);

// ── Build the artwork. ──────────────────────────────────────────────────────
// 660 is the hard floor on every slot: below it the pass URL 500s with no
// useful message. The wordmark is 2379x758 (3.14:1) — resize TO that aspect at
// the floor rather than letterboxing it into a square, which would render the
// mark at 660x210 inside 68% empty navy and then let Apple shrink it further.
const sharp = (await import("sharp")).default;
const src = readFileSync(resolve(process.cwd(), "apps/web/public/brand/ft-logo.png"));

const logo = await sharp(src)
  .trim()
  .resize(2072, 660, { fit: "contain", background: BG })
  .flatten({ background: BG })
  .png()
  .toBuffer();

// THE ICON IS NOT TOUCHED. It already ships at the bundle ROOT (`icon.png`,
// `@2x`, `@3x`) and works. With 28 live passes about to re-render, the change
// stays as small as the defect.
console.log(`built  logo 2072x660 (${logo.length}B)   icon left alone`);

// How many holders this will push to.
const holders = await pk("POST", "/members/members/list", {
  filters: { limit: 1, filterGroups: [] },
  programId: "4m1Y7wCXyloclQk0hqvjRS",
}).catch(() => null);
if (holders?.ok) {
  const n = String(holders.text).split("\n").filter(Boolean).length;
  console.log(`live passes in this programme: at least ${n} (each gets one push)\n`);
}

// ── The proposed template: live, plus exactly two keys. ─────────────────────
// Bound to a const: the `if (!live) throw` above narrows the outer binding, but
// that narrowing does not survive into a closure, so tsc rightly flags
// `live.imageIds` here as possibly-undefined.
const base = live;
function proposed(imageIds: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    imageIds: {
      ...((base.imageIds as Record<string, unknown>) ?? {}),
      ...imageIds,
    },
    appleWalletSettings: {
      ...((base.appleWalletSettings as Record<string, unknown>) ?? {}),
      // Renders as TEXT beside the logo in the collapsed stack row, so the card
      // is identifiable even at the size Apple draws it there — and it does not
      // depend on PassKit's squaring of the logo image.
      logoText: "FastTrax",
    },
  };
}

// ── Diff, always, before anything is written. ───────────────────────────────
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  console.log("KEY                          VERDICT");
  console.log("──────────────────────────── ────────");
  for (const k of keys) {
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify(after[k]);
    const verdict =
      a === b ? "same" : !(k in before) ? "NEW" : !(k in after) ? "REMOVED" : "CHANGE";
    console.log(`${k.padEnd(28)} ${verdict}`);
    if (verdict === "CHANGE" || verdict === "NEW") {
      console.log(`    was: ${String(a).slice(0, 160)}`);
      console.log(`    now: ${String(b).slice(0, 160)}`);
    }
    if (verdict === "REMOVED") console.log(`    LOSING: ${String(a).slice(0, 200)}`);
  }
}

if (!APPLY) {
  // Diff against placeholder ids so the shape is reviewable without uploading.
  diff(live, proposed({ logo: "<new-logo-id>", appleLogo: "<new-logo-id>" }));
  console.log("\nDRY RUN — no images uploaded, no template written. Re-run with APPLY=1.");
  process.exit(0);
}

// ── 1. Upload. Template-level images: one template serves every pass, so
// nothing racer-specific may ever go here (a racer's BMI photo leaked into the
// shared template on 2026-08-04). A wordmark is the whole point.
const up = await pk("POST", "/images", {
  imageData: { logo: logo.toString("base64") },
});
console.log(`images → ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`);
if (!up.ok) throw new Error("image upload failed — template NOT touched");

const ids = up.body as Record<string, string>;
const next = proposed({
  ...(ids.logo ? { logo: ids.logo } : {}),
  // USE PASSKIT'S DERIVED appleLogo ID, not the generic `logo` id.
  //
  // `POST /images` returns two ids: the generic `logo` and a separate
  // `appleLogo` it prepared itself. The earlier template pointed appleLogo at
  // the generic id — reasoning that it would keep the wordmark's 3.14:1 aspect
  // instead of letting PassKit square it. Unpacking a live pass shows what that
  // actually bought: the image ships to
  // `images.lproj/{genericId}/logo/logo.png`, which is not a language directory
  // and not the bundle root, so Apple resolves NEITHER and draws no logo at all.
  //
  // A squared logo that renders beats a correctly-proportioned one that does
  // not, and `logoText` now carries the wordmark's job in the header row
  // regardless. Verify against the pass manifest, not this comment.
  ...(ids.appleLogo ? { appleLogo: ids.appleLogo } : {}),
});

console.log("\nWRITING:");
diff(live, next);

const put = await pk("PUT", "/template", next);
console.log(`\ntemplate → ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
if (!put.ok) throw new Error("template PUT failed");

const after = await pk("POST", "/templates/list", {});
const check = String(after.text)
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .map((r) => r?.result?.template)
  .find((t: { id?: string }) => t?.id === TEMPLATE_ID);
console.log(`\nverified imageIds: ${JSON.stringify(check?.imageIds ?? null)}`);
console.log(`verified logoText: ${JSON.stringify(check?.appleWalletSettings?.logoText ?? null)}`);
