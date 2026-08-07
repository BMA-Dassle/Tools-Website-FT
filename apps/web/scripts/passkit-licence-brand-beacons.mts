/**
 * One FastTrax mark, and both beacons, on the ONE racing licence.
 *
 * ── BRANDING (owner 2026-08-06) ─────────────────────────────────────────────
 * The card was carrying the mark THREE times: a header logo, the word
 * "FastTrax" as `logoText` beside it, and the wordmark composited into the
 * bottom-right of the strip photo. The strip mark was a workaround from when the
 * header logo did not render at all — it shipped to `images.lproj/{id}/logo/`,
 * which is neither the bundle root nor a language directory, so Apple resolved
 * nothing and the card was a blank strip in the stacked Wallet view. That is
 * fixed, so the workaround and the duplicate text both go.
 *
 *   header logo   KEPT   — the one mark
 *   logoText      REMOVED
 *   strip mark    REMOVED — strip rebuilt from the photo + scrim only
 *
 * ── BEACONS (owner 2026-08-06) ──────────────────────────────────────────────
 * Same UUID, two physical beacons in the building, BOTH on the licence:
 *
 *   maj 1 / min 12   kiosk         "Welcome to FastTrax — scan at the kiosk to sign in"
 *   maj 1 / min  5   race check-in "Race check-in — have this ready to scan"
 *
 * ONE LICENCE, BOTH PLACES — confirmed with the owner. The racing licence is a
 * single universal credential that scans at the kiosk, the race check-in desk
 * and the BMI register, so both prompts belong on the same pass.
 *
 * A second template exists in the account, "FastTrax Racing Licence (ticket)"
 * (`DEAD_TICKET_ID` below, SINGLE_USE_COUPON) — and it is DEAD. Nothing in the
 * app references that id; it was created by `scripts/passkit-licence-ticket.mts`,
 * which is still uncommitted. Deliberately NOT touched: putting beacons on a
 * template no pass is ever issued from is work that looks like coverage and
 * is not.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * `PUT /template` REPLACES the template. The write is built by spreading the
 * LIVE template and overriding named keys, and a full CHANGE/NEW/REMOVED table
 * prints before anything is sent — the failure this guards against is a PUT
 * built from a stale constant silently deleting live content (`e44d84b4`).
 *
 * A template change re-renders every pass in the programme, so this is one push
 * per live holder. One-time correction, not a loop.
 *
 *   DRY:     node --env-file=apps/web/.env.local apps/web/scripts/passkit-licence-brand-beacons.mts
 *   EXECUTE: APPLY=1 node --env-file=apps/web/.env.local apps/web/scripts/passkit-licence-brand-beacons.mts
 */
import { readFileSync } from "node:fs";
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
const LICENCE_ID = "75paqKfII1FIn9kImwIvi2";
/** DEAD — see the header. Named only so the next person searching for this id
 *  finds the explanation instead of wiring it up. */
const DEAD_TICKET_ID = "5v2sZdz34uXBz2veQ61XUs";

/**
 * BEACONS ARE THEIR OWN OBJECTS, not inline template config. A template PUT
 * carrying a beacon without an `id` is rejected outright:
 *
 *   400 validation error: Key: 'PassTemplate.Beacons[0].Id' ... required
 *
 * So each beacon is saved through `POST|PUT /beacon` first and the template then
 * references it. Endpoint shapes, measured: `POST /beacon` creates (returns an
 * id), `PUT /beacon` updates, `POST /beacons/list` reads. `POST /beacons` is 501
 * and `/beacons/beacon` is 404.
 */
const BEACON_UUID = "51c5b1cc-dd3c-425c-a7fe-ac019bbf8209";

/** One record per beacon. `name` is the natural key — a re-run updates the
 *  existing record rather than minting a duplicate to reap by hand. Copy is
 *  short because Apple truncates it and it is read at a glance by someone
 *  walking up to a counter. */
const BEACON_SPECS = [
  {
    name: "FastTrax Kiosk",
    major: 1,
    minor: 12,
    lockScreenMessage: "Welcome to FastTrax — scan at the kiosk to sign in",
  },
  {
    name: "FastTrax Race Check-In",
    major: 1,
    minor: 5,
    lockScreenMessage: "Race check-in — have this ready to scan",
  },
] as const;

const BG_HEX = "#000418";
const BG = { r: 0x00, g: 0x04, b: 0x18, alpha: 1 };
const STRIP_W = 1600;
const STRIP_H = 620;
const STRIP_PHOTO =
  process.env.STRIP_PHOTO ||
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06577.webp";

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
    /* ndjson */
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

/** Split an ndjson stream into parsed rows, unwrapping PassKit's `result`. */
function ndjson(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of String(text).split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      out.push((parsed?.result ?? parsed) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function liveTemplate(id: string): Promise<Record<string, unknown> | null> {
  const list = await pk("POST", "/templates/list", {});
  for (const row of ndjson(list.text)) {
    const t = (row as { template?: Record<string, unknown> }).template;
    if (t?.id === id) return t;
  }
  return null;
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let dirty = false;
  for (const k of keys) {
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify(after[k]);
    if (a === b) continue;
    dirty = true;
    const verdict = !(k in before) ? "NEW" : !(k in after) ? "REMOVED" : "CHANGE";
    console.log(`   ${verdict.padEnd(8)} ${k}`);
    if (verdict === "REMOVED") {
      console.log(`      LOSING: ${String(a).slice(0, 220)}`);
    } else {
      console.log(`      was: ${String(a).slice(0, 200)}`);
      console.log(`      now: ${String(b).slice(0, 200)}`);
    }
  }
  if (!dirty) console.log("   (no change)");
}

// ── The strip, WITHOUT the composited wordmark. ─────────────────────────────
// Photo + scrim only. The scrim is load-bearing, not decoration: Apple lays
// PRIMARY_FIELDS *over* the strip, so it stays light at the top where the track
// reads and drives to near-solid navy by the bottom third where the racer's
// name actually sits. Dropping the mark changes the composite step and nothing
// else about those stops.
async function buildStrip(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const scrim = Buffer.from(
    `<svg width="${STRIP_W}" height="${STRIP_H}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%"   stop-color="${BG_HEX}" stop-opacity="0.42"/>
         <stop offset="30%"  stop-color="${BG_HEX}" stop-opacity="0.22"/>
         <stop offset="68%"  stop-color="${BG_HEX}" stop-opacity="0.72"/>
         <stop offset="100%" stop-color="${BG_HEX}" stop-opacity="0.97"/>
       </linearGradient></defs>
       <rect width="${STRIP_W}" height="${STRIP_H}" fill="url(#g)"/>
     </svg>`,
  );
  const photo = Buffer.from(await (await fetch(STRIP_PHOTO)).arrayBuffer());
  return sharp(photo)
    .resize(STRIP_W, STRIP_H, { fit: "cover", position: "centre" })
    .composite([{ input: scrim, blend: "over" }])
    .flatten({ background: BG })
    .png()
    .toBuffer();
}

interface SavedBeacon extends Record<string, unknown> {
  id: string;
  uuid: string;
  name: string;
  major: number;
  minor: number;
  lockScreenMessage: string;
}

/** Create or update each spec, keyed by name. Returns the saved objects with
 *  their PassKit ids — the only form the template will accept. */
async function reconcileBeacons(): Promise<SavedBeacon[]> {
  const existing = ndjson((await pk("POST", "/beacons/list", {})).text).filter(
    (b) => typeof b.id === "string",
  ) as unknown as SavedBeacon[];

  const saved: SavedBeacon[] = [];
  for (const spec of BEACON_SPECS) {
    const want = { uuid: BEACON_UUID, ...spec };
    const hit = existing.find((b) => b.name === spec.name);

    if (hit) {
      const same =
        hit.uuid === want.uuid &&
        hit.major === want.major &&
        hit.minor === want.minor &&
        hit.lockScreenMessage === want.lockScreenMessage;
      console.log(`  "${spec.name}" ${hit.id} — ${same ? "already correct" : "UPDATE"}`);
      if (!same) {
        console.log(`     was: ${JSON.stringify(hit.lockScreenMessage)}`);
        console.log(`     now: ${JSON.stringify(want.lockScreenMessage)}`);
        if (APPLY) {
          const put = await pk("PUT", "/beacon", { ...hit, ...want, id: hit.id });
          if (!put.ok) {
            throw new Error(`beacon update failed ${put.status} ${put.text.slice(0, 200)}`);
          }
        }
      }
      saved.push({ ...hit, ...want, id: hit.id });
      continue;
    }

    console.log(`  "${spec.name}" — CREATE (maj ${spec.major} / min ${spec.minor})`);
    console.log(`     msg: ${JSON.stringify(want.lockScreenMessage)}`);
    if (!APPLY) {
      saved.push({ ...want, id: "<new-beacon-id>" });
      continue;
    }
    const created = await pk("POST", "/beacon", want);
    if (!created.ok) {
      throw new Error(`beacon create failed ${created.status} ${created.text.slice(0, 200)}`);
    }
    saved.push({ ...want, id: (created.body as { id: string }).id });
  }
  return saved;
}

// ── Plan ────────────────────────────────────────────────────────────────────
const live = await liveTemplate(LICENCE_ID);
if (!live) throw new Error(`template ${LICENCE_ID} not found — refusing to write`);
console.log(`licence template ${LICENCE_ID} "${live.name}"`);
console.log(`not touching dead template ${DEAD_TICKET_ID} — see header\n`);

console.log("beacons:");
const beacons = await reconcileBeacons();
console.log("");

const strip = await buildStrip();
console.log(`strip rebuilt ${STRIP_W}x${STRIP_H}, no wordmark (${strip.length}B)\n`);

function plan(stripId: string): Record<string, unknown> {
  return {
    ...live,
    appleWalletSettings: {
      ...((live!.appleWalletSettings as Record<string, unknown>) ?? {}),
      // The header logo is the one mark now; the word beside it was a duplicate.
      logoText: "",
    },
    imageIds: {
      ...((live!.imageIds as Record<string, unknown>) ?? {}),
      strip: stripId,
    },
    beacons: beacons.map((b, position) => ({ ...b, position })),
  };
}

if (!APPLY) {
  diff(live, plan("<new-strip-id>"));
  console.log("\nDRY RUN — nothing uploaded, nothing written. Re-run with APPLY=1.");
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
const up = await pk("POST", "/images", { imageData: { strip: strip.toString("base64") } });
if (!up.ok) throw new Error(`strip upload failed ${up.status} — template NOT touched`);
const stripId = (up.body as Record<string, string>).strip;
console.log(`strip uploaded → ${stripId}\n`);

const next = plan(stripId);
diff(live, next);
const put = await pk("PUT", "/template", next);
console.log(`\nPUT → ${put.status}${put.ok ? "" : " " + String(put.text).slice(0, 400)}`);
if (!put.ok) throw new Error("template PUT failed");

// ── Verify from a FRESH read, never the PUT's own echo. ─────────────────────
const after = await liveTemplate(LICENCE_ID);
const aw = (after?.appleWalletSettings ?? {}) as Record<string, unknown>;
const im = (after?.imageIds ?? {}) as Record<string, string>;
console.log(`\nverified logoText  ${JSON.stringify(aw.logoText)}`);
console.log(`verified strip     ${im.strip}`);
console.log(`verified logo      ${im.logo}   appleLogo ${im.appleLogo}`);
for (const b of (after?.beacons ?? []) as Array<Record<string, unknown>>) {
  console.log(`verified beacon    maj${b.major}/min${b.minor}  "${b.lockScreenMessage}"`);
}
