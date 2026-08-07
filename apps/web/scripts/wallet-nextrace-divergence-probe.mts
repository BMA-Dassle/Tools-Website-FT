// READ-ONLY probe: why did NEXT RACE not move on a live racing licence?
//
// The pass value can disagree with our records in three places, and only one of
// them is visible from the API. This triangulates all three:
//
//   1. NEON  racer_wallet_passes.next_race   — the change-detection column.
//            `updateLicencePass` suppresses a push when the incoming value
//            equals THIS. If it runs ahead of the pass, the pass is frozen.
//   2. NEON  racer_wallet_passes.meta->>'nextRace' — the base every PUT is
//            built from (`full = {...row.meta, ...changed}`). If `changed` is
//            empty because of (1), THIS is what gets re-sent.
//   3. PASSKIT member metaData.nextRace + the SIGNED pass.json — what the racer
//            actually holds. The API has lied about update state before
//            (lastUpdatedAt stays null across landed writes), so the .pkpass is
//            the only real evidence.
//
// Nothing is written. No APPLY flag exists on purpose.
//
//   npx tsx scripts/wallet-nextrace-divergence-probe.mts
//   PERSON_ID=409523 npx tsx scripts/wallet-nextrace-divergence-probe.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const SPLIT_RE = /\r?\n/;
function loadEnvLocal(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    for (const c of [resolve(dir, ".env.local"), resolve(dir, "apps", "web", ".env.local")]) {
      if (!existsSync(c)) continue;
      for (const l of readFileSync(c, "utf8").split(SPLIT_RE)) {
        const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined)
          process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      }
      return;
    }
    dir = resolve(dir, "..");
  }
  console.error("Could not find .env.local");
  process.exit(1);
}
loadEnvLocal();

const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const KEY = process.env.PASSKIT_API_KEY || "";
const SECRET = process.env.PASSKIT_API_SECRET || "";
const ONLY = process.env.PERSON_ID || "";

function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ uid: KEY, iat: now - 30, exp: now + 50 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function pk(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: jwt(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* NDJSON */
  }
  return { status: res.status, ok: res.ok, body: parsed, raw: text };
}

/**
 * Read the CENTRAL DIRECTORY, not the local headers. PassKit streams its zips
 * with data descriptors, so every local header carries compressedSize = 0 and a
 * local-header walk finds ZERO entries in a perfectly good 590 KB pass.
 */
function unzipEntry(buf: Buffer, want: string): string | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === want) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/** pub2.pskt.io sniffs the User-Agent — anything it does not read as
 *  Safari-on-iPhone gets the HTML landing page as a 200. Assert ZIP magic. */
async function fetchPass(memberId: string): Promise<Buffer | null> {
  const res = await fetch(`https://pub2.pskt.io/${memberId}.pkpass`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      Accept: "application/vnd.apple.pkpass,*/*",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    console.log(`      !! not a zip (${res.headers.get("content-type")}, ${buf.length}B)`);
    return null;
  }
  return buf;
}

/**
 * Resolve an Apple LOCALIZATION KEY.
 *
 * A rendered pass.json carries `"value": "custom.nextRace.value"` — that is NOT
 * the text and NOT an unbound field. Apple looks it up in en.lproj/pass.strings
 * (`"custom.nextRace.value" = "Aug 6 · 9:48 PM · Red";`). Reading pass.json
 * alone makes every field on every pass look broken.
 */
function parseStrings(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of src.split(SPLIT_RE)) {
    const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;\s*$/);
    if (m) out.set(m[1], m[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
  return out;
}

function fieldValue(pass: any, uniqueName: string): string | null {
  for (const style of ["storeCard", "coupon", "generic", "eventTicket", "boardingPass"]) {
    const s = pass?.[style];
    if (!s) continue;
    for (const sec of Object.values(s) as any[]) {
      if (!Array.isArray(sec)) continue;
      const hit = sec.find((f: any) => f?.key === uniqueName);
      if (hit) return String(hit.value ?? "");
    }
  }
  return null;
}

async function main() {
  const { sql } = await import("../lib/db");
  const q = sql();
  const rows = (await q`
    SELECT person_id, member_id, login_code, next_race, checkin_status,
           checkin_session_id, next_race_session_id, meta, issued_at, updated_at
    FROM racer_wallet_passes
    ORDER BY updated_at DESC`) as any[];

  console.log(`racer_wallet_passes: ${rows.length} row(s)\n`);

  for (const r of rows) {
    const pid = String(r.person_id);
    if (ONLY && pid !== ONLY) continue;
    const meta = (r.meta ?? null) as Record<string, string> | null;

    console.log(`── person ${pid}  member ${r.member_id}  (updated ${r.updated_at})`);
    console.log(`   NEON  col next_race       : ${JSON.stringify(r.next_race)}`);
    console.log(`   NEON  meta.nextRace       : ${JSON.stringify(meta?.nextRace ?? null)}`);
    console.log(`   NEON  meta.nextRaceLong   : ${JSON.stringify(meta?.nextRaceLong ?? null)}`);
    console.log(`   NEON  meta.raceLabel      : ${JSON.stringify(meta?.raceLabel ?? null)}`);
    console.log(`   NEON  col checkin_status  : ${JSON.stringify(r.checkin_status)}`);
    console.log(`   NEON  meta.checkinStatus  : ${JSON.stringify(meta?.checkinStatus ?? null)}`);
    console.log(
      `   NEON  sessions           : nextRace=${r.next_race_session_id ?? "—"} checkin=${r.checkin_session_id ?? "—"}`,
    );
    if (meta === null) console.log(`   !! meta IS NULL — updateLicencePass refuses to push at all`);

    // By-id GET is 404 on this account; the externalId form is the one
    // issueLicencePass already uses, so read it the same way.
    const { PASSKIT_LICENCE } = await import("../src/config/passkit");
    const m = await pk(
      "GET",
      `/members/member/externalId/${PASSKIT_LICENCE.programId}/${pid}`,
    );
    const apiMeta = (m.body as any)?.metaData ?? null;
    console.log(`   API   metaData.nextRace   : ${JSON.stringify(apiMeta?.nextRace ?? null)} (${m.status})`);
    console.log(`   API   metaData.checkinStatus: ${JSON.stringify(apiMeta?.checkinStatus ?? null)}`);
    console.log(`   API   metaData keys       : ${apiMeta ? Object.keys(apiMeta).sort().join(",") : "—"}`);

    let passNextRace: string | null = null;
    const buf = await fetchPass(String(r.member_id));
    if (buf) {
      const raw = unzipEntry(buf, "pass.json");
      const loc = parseStrings(unzipEntry(buf, "en.lproj/pass.strings") ?? "");
      if (raw) {
        const pass = JSON.parse(raw);
        const shown = (uniqueName: string): string | null => {
          const v = fieldValue(pass, uniqueName);
          if (v == null) return null;
          return loc.has(v) ? loc.get(v)! : v;
        };
        console.log(`   PASS  custom.nextRace     : ${JSON.stringify(shown("custom.nextRace"))}`);
        console.log(`   PASS  custom.raceLabel    : ${JSON.stringify(shown("custom.raceLabel"))}`);
        console.log(`   PASS  custom.nextRaceLong : ${JSON.stringify(shown("custom.nextRaceLong"))}`);
        console.log(`   PASS  custom.checkinStatus: ${JSON.stringify(shown("custom.checkinStatus"))}`);
        console.log(`   PASS  barcode             : ${JSON.stringify(pass?.barcodes?.[0]?.message ?? pass?.barcode?.message ?? null)}`);
        passNextRace = shown("custom.nextRace");
      }
    }

    // The verdict this probe exists to produce.
    const colVsMeta = String(r.next_race ?? "") !== String(meta?.nextRace ?? "");
    const metaVsApi = String(meta?.nextRace ?? "") !== String(apiMeta?.nextRace ?? "");
    if (colVsMeta)
      console.log(
        `   >> DIVERGED: col next_race != meta.nextRace — change-detection is comparing against a value the pass never received; every future push of that string is suppressed.`,
      );
    if (metaVsApi && apiMeta)
      console.log(`   >> DIVERGED: stored meta != PassKit metaData — a PUT was lost.`);
    const passVsMeta =
      passNextRace != null && passNextRace !== String(meta?.nextRace ?? "");
    if (passVsMeta)
      console.log(
        `   >> DIVERGED: the SIGNED PASS shows ${JSON.stringify(passNextRace)} but we stored ${JSON.stringify(meta?.nextRace ?? null)}`,
      );
    if (!colVsMeta && !(metaVsApi && apiMeta) && !passVsMeta) console.log(`   >> consistent`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
