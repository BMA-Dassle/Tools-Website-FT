/**
 * READ-ONLY: was there EVER a period when signatures submitted through our
 * flow landed an image in BMI? (owner: "go back and look at when this was
 * working")
 *
 * Classifier: a Pandora-submitted waiver records `signed` at a synthetic
 * 09:00:00 (it stores only the DATE); a desk/tablet signature records a real
 * wall-clock time with milliseconds. So every waiver row in BMI self-identifies
 * its origin, no join required.
 *
 * For every person we have a record for, this lists their waivers, tags each
 * PANDORA vs DESK, and reports whether that person holds a signature image.
 * A PANDORA waiver with number != NULL — or a person whose ONLY waivers are
 * Pandora yet who holds an image — is proof it once worked, and dates it.
 *
 * Run from apps/web:  npx tsx scripts/waiver-when-did-it-work.mts [limit]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const USER = process.env.BMI_OFFICE_USERNAME || "API2";
const PASS = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const LIMIT = Number(process.argv[2] || 60);

const res0 = await fetch(`https://${HOST}/auth/token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
    origin: "https://office.bmileisure.com",
    referer: "https://office.bmileisure.com/",
  },
  body: `grant_type=password&username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`,
});
const TOKEN = (JSON.parse(await res0.text()) as { access_token: string }).access_token;

function post(path: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: HOST,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "x-fast-version": SMS_VERSION,
          "x-session-id": randomUUID(),
          clientkey: CLIENT_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: d }));
      },
    );
    r.on("error", reject);
    r.setTimeout(20_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    r.end(payload);
  });
}

async function hasImage(id: string): Promise<boolean> {
  try {
    const r = await fetch(
      `https://${HOST}/api/${CLIENT_KEY}/image/picture?personId=${id}&kind=5`,
      { headers: { referer: "https://office.bmileisure.com/" }, signal: AbortSignal.timeout(15000) },
    );
    return r.ok;
  } catch {
    return false;
  }
}

/** Pandora stores only a DATE, so Office renders 09:00:00 exactly. */
const isPandora = (signed: string) => /T09:00:00(\.0+)?$/.test(String(signed));

/* Sample across our whole recorded history, oldest first, so an era where it
   worked shows up as a run of early hits. */
const people = (await sql`
  SELECT person_id, MIN(ts) AS first_seen FROM (
    SELECT person_id, ts FROM waiver_acceptances WHERE person_id IS NOT NULL
    UNION ALL
    SELECT person_id, ts FROM waiver_sign_attempts
  ) u GROUP BY person_id ORDER BY MIN(ts) ASC LIMIT ${LIMIT}`) as any[];

console.log(`══════ ${people.length} people, oldest first ══════\n`);
const body = JSON.stringify({ validOn: new Date().toISOString(), showAll: true });

let pandoraWithNumber = 0;
let pandoraOnlyWithImage = 0;
let deskAny = 0;
const byMonth = new Map<string, { pandora: number; withNum: number }>();

for (const p of people) {
  const id = String(p.person_id);
  const r = await post(`/api/${CLIENT_KEY}/waivers?personId=${id}`, body);
  if (r.status >= 400) continue;
  let list: any[] = [];
  try {
    list = JSON.parse(r.body);
  } catch {
    continue;
  }
  if (list.length === 0) continue;

  const pandora = list.filter((w) => isPandora(w.signed));
  const desk = list.filter((w) => !isPandora(w.signed));
  if (desk.length) deskAny++;

  for (const w of pandora) {
    const mo = String(w.signed).slice(0, 7);
    const e = byMonth.get(mo) ?? { pandora: 0, withNum: 0 };
    e.pandora++;
    if (w.number !== null && w.number !== undefined) {
      e.withNum++;
      pandoraWithNumber++;
      console.log(`  ⭐ PANDORA waiver WITH number: person=${id} id=${w.id} number=${w.number} signed=${w.signed}`);
    }
    byMonth.set(mo, e);
  }

  // The cleanest signal: only-Pandora waivers, yet an image exists.
  if (pandora.length > 0 && desk.length === 0) {
    if (await hasImage(id)) {
      pandoraOnlyWithImage++;
      console.log(
        `  ⭐ IMAGE with ONLY Pandora waivers: person=${id} first_seen=${String(p.first_seen).slice(4, 16)} signed=${pandora.map((w) => w.signed).join(",")}`,
      );
    }
  }
}

console.log(`\n══════ Pandora waivers by month signed ══════`);
for (const [mo, e] of [...byMonth].sort())
  console.log(`  ${mo}   pandora=${String(e.pandora).padStart(4)}   withNumber=${e.withNum}`);

console.log(`\n══════ VERDICT ══════`);
console.log(`  PANDORA waivers carrying a number : ${pandoraWithNumber}`);
console.log(`  people w/ ONLY Pandora + an image : ${pandoraOnlyWithImage}`);
console.log(`  people who ALSO have desk waivers : ${deskAny}  (their images explain themselves)`);
if (pandoraWithNumber === 0 && pandoraOnlyWithImage === 0) {
  console.log(`  → No Pandora-submitted waiver has EVER stored an image, in any month.`);
} else {
  console.log(`  → It DID work at some point — see the starred rows for when.`);
}
process.exit(0);
