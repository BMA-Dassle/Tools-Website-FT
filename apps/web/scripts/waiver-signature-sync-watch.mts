/**
 * READ-ONLY: does the signature image appear in Office AFTER a delay?
 *
 * Pandora writes straight to BMI's Firebird DB; Office is the SMS-Timing layer
 * on top. If those replicate on a schedule, a fresh waiver's signature could be
 * absent at first and appear later — which would mean the image IS stored and I
 * simply checked too early (owner, 2026-08-09).
 *
 * Polls a fresh person until the signature appears or the window expires, and
 * re-checks AGED Pandora waivers as controls: if sync is the explanation, a
 * waiver written 8-10 days ago must have caught up long since.
 *
 * Run from apps/web:
 *   npx tsx scripts/waiver-signature-sync-watch.mts <freshPersonId> [minutes]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const FRESH = process.argv[2] || "58287506";
const MINUTES = Number(process.argv[3] || 45);

/** Aged Pandora-submitted waivers. If replication lag explains the 404s, every
 *  one of these — days old — must read 200 by now. */
const AGED: Array<[string, string]> = [
  ["58161723", "Melissa Birt, pad-signed 8/8"],
  ["58165592", "Christian Birt, pad-signed 8/8"],
  ["10521162", "Liberty Mason, Pandora waiver 8/1 (8 days)"],
  ["56490215", "Shane, HealthNet/Xmas backfill 7/30 (10 days)"],
  ["11204867", "Aline Braga, pad-signed 7/30 (10 days)"],
];

async function sig(id: string): Promise<string> {
  try {
    const r = await fetch(
      `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture?personId=${id}&kind=5&_=${Math.floor(
        performance.now() * 1000,
      )}`,
      {
        headers: { referer: "https://office.bmileisure.com/", "cache-control": "no-cache" },
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return `404`;
    return `STORED ${(await r.arrayBuffer()).byteLength}B`;
  } catch {
    return "err";
  }
}

console.log("══════ AGED controls — days old, sync must have completed ══════");
let agedStored = 0;
for (const [id, what] of AGED) {
  const s = await sig(id);
  if (s.startsWith("STORED")) agedStored++;
  console.log(`  ${id.padEnd(12)} ${s.padEnd(16)} ${what}`);
}
console.log(
  `\n  ${agedStored}/${AGED.length} aged Pandora waivers have an image.` +
    (agedStored === 0
      ? "  ← replication lag cannot explain these"
      : "  ← re-read these before concluding"),
);

console.log(`\n══════ watching fresh person ${FRESH} for ${MINUTES} min ══════`);
const deadline = Date.now() + MINUTES * 60_000;
let n = 0;
while (Date.now() < deadline) {
  const s = await sig(FRESH);
  n++;
  const mins = Math.round((MINUTES * 60_000 - (deadline - Date.now())) / 60_000);
  console.log(`  [+${String(mins).padStart(3)}m] check ${String(n).padStart(3)}: ${s}`);
  if (s.startsWith("STORED")) {
    console.log(`\n  ✅ APPEARED after ~${mins} min — it IS a sync delay, not a discard.`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 120_000));
}
console.log(`\n  ✗ still absent after ${MINUTES} min.`);
process.exit(0);
