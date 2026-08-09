/**
 * READ-ONLY: did the HealthNet (2026-06-18) / Xmas-in-July (2026-07-30)
 * "Digitally Accepted" backfills actually STORE a signature image in BMI?
 *
 * Owner recalls those working. If they did, Pandora's POST /bmi/waiver CAN
 * store an image, and the difference between them and the kiosk/waiver path is
 * the actual bug — not the vendor.
 *
 * Both backfills went through lib/waiver-digital.tsx signWaiverDigital(), which
 * differs from app/api/pandora/waiver/route.ts in ways that now matter:
 *   - body: new Uint8Array(buf)   vs   body: buf   (Buffer)
 *   - dark-on-white PNG from ImageResponse  vs  the pad's canvas PNG
 *
 * Checked with Office's read-back (kind=5), which neither backfill had.
 *
 * Run from apps/web:  npx tsx scripts/waiver-healthnet-didit-store.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";

async function sigInfo(id: string): Promise<string> {
  try {
    const r = await fetch(
      `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture?personId=${id}&kind=5`,
      { headers: { referer: "https://office.bmileisure.com/" }, signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return `NO (${r.status})`;
    const b = Buffer.from(await r.arrayBuffer());
    return `YES ${b.length}B`;
  } catch {
    return "ERR";
  }
}

/* The two original backfills — method='backfill', BEFORE today's re-legible run. */
const rows = (await sql`
  SELECT person_id, first_name, waiver_id, terms_version, center, ts
  FROM waiver_acceptances
  WHERE method = 'backfill' AND terms_version <> 'relegible-2026-08-08'
  ORDER BY ts DESC LIMIT 30`) as any[];

console.log(`══════ ${rows.length} HealthNet / Xmas backfill rows ══════`);
let yes = 0;
let no = 0;
for (const r of rows) {
  const info = await sigInfo(String(r.person_id));
  if (info.startsWith("YES")) yes++;
  else no++;
  console.log(
    `  ${String(r.person_id).padEnd(18)} "${String(r.first_name ?? "").padEnd(14)}" ${String(r.ts).slice(4, 16)} waiver=${String(r.waiver_id ?? "-").padEnd(10)} → signature ${info}`,
  );
}
console.log(`\n  stored=${yes}  missing=${no}`);

/* Control: the kiosk/waiver pad path, same window. */
console.log(`\n══════ control: pad-signed people (waiver_sign_attempts) ══════`);
const pad = (await sql`
  SELECT DISTINCT ON (person_id) person_id, ts
  FROM waiver_sign_attempts WHERE outcome = 'signed'
  ORDER BY person_id, ts DESC LIMIT 10`) as any[];
let pYes = 0;
let pNo = 0;
for (const p of pad) {
  const info = await sigInfo(String(p.person_id));
  if (info.startsWith("YES")) pYes++;
  else pNo++;
  console.log(`  ${String(p.person_id).padEnd(18)} ${String(p.ts).slice(4, 16)} → signature ${info}`);
}
console.log(`\n  stored=${pYes}  missing=${pNo}`);

console.log(`\n══════ VERDICT ══════`);
if (yes > 0 && pYes === 0) {
  console.log(`  signWaiverDigital STORES the image; the pad path does NOT.`);
  console.log(`  → OUR bug, not the vendor's. Diff the two call sites.`);
} else if (yes === 0 && pYes === 0) {
  console.log(`  NEITHER path stores an image → Pandora discards it for both.`);
  console.log(`  → vendor defect; the HealthNet marks were never visible either.`);
} else {
  console.log(`  mixed — read the rows above before concluding.`);
}
process.exit(0);
