/**
 * READ-ONLY: find the endpoint that serves a WAIVER's signature image.
 *
 * `image/picture?personId=X&kind=5` is the PERSON-level signature slot — a
 * different thing, and reading it is what led me to wrongly conclude Pandora
 * discards the image. BMI Office plainly renders a per-waiver signature (owner
 * screenshot, 2026-08-09: the "Digitally Accepted" mark for waiver 58288628).
 *
 * Positive control: 58288628 (signWaiverDigital) IS known to have an image.
 * Negative-ish: 58287632 (browser pad signature) — unknown, and the one that
 * matters, because white-ink-on-transparent would render as a blank white page.
 *
 * Run from apps/web:  npx tsx scripts/waiver-signature-endpoint-hunt.mts [outDir]
 */
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";

const HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const USER = process.env.BMI_OFFICE_USERNAME || "API2";
const PASS = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const OUT = process.argv[2] || ".";

const CONTROL = "58288628"; // signWaiverDigital — HAS an image (owner screenshot)
const PERSON = "58287506";

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

/** Try both authenticated and bare — image/picture needed no auth at all. */
async function tryUrl(path: string): Promise<{ status: number; type: string; bytes: number; buf?: Buffer }> {
  for (const withAuth of [false, true]) {
    try {
      const r = await fetch(`https://${HOST}${path}`, {
        headers: withAuth
          ? {
              Authorization: `Bearer ${TOKEN}`,
              "x-fast-version": SMS_VERSION,
              "x-session-id": randomUUID(),
              clientkey: CLIENT_KEY,
              referer: "https://office.bmileisure.com/",
            }
          : { referer: "https://office.bmileisure.com/" },
        signal: AbortSignal.timeout(15000),
      });
      const ct = r.headers.get("content-type") ?? "";
      if (r.ok && /image/.test(ct)) {
        const buf = Buffer.from(await r.arrayBuffer());
        return { status: r.status, type: ct, bytes: buf.length, buf };
      }
      if (withAuth) return { status: r.status, type: ct, bytes: 0 };
    } catch {
      /* next */
    }
  }
  return { status: 0, type: "", bytes: 0 };
}

const CANDIDATES = (id: string) => [
  `/api/${CLIENT_KEY}/image/picture?waiverId=${id}`,
  `/api/${CLIENT_KEY}/image/picture?waiverId=${id}&kind=5`,
  `/api/${CLIENT_KEY}/image/picture?id=${id}&kind=5`,
  `/api/${CLIENT_KEY}/image/picture?personId=${PERSON}&kind=5&waiverId=${id}`,
  `/api/${CLIENT_KEY}/image/waiver?waiverId=${id}`,
  `/api/${CLIENT_KEY}/image/waiver/${id}`,
  `/api/${CLIENT_KEY}/image/signature?waiverId=${id}`,
  `/api/${CLIENT_KEY}/waiver/${id}/signature`,
  `/api/${CLIENT_KEY}/waivers/${id}/signature`,
  `/api/${CLIENT_KEY}/waiver/image/${id}`,
  `/api/${CLIENT_KEY}/image/waiversignature?waiverId=${id}`,
  `/api/${CLIENT_KEY}/image/picture?waiverId=${id}&kind=0`,
  `/api/${CLIENT_KEY}/image/picture?signatureId=${id}`,
];

console.log(`══════ hunting the per-waiver signature endpoint (control ${CONTROL}) ══════`);
let found: string | null = null;
for (const path of CANDIDATES(CONTROL)) {
  const r = await tryUrl(path);
  const ok = r.bytes > 0;
  console.log(`  ${ok ? "✅" : "  "} ${String(r.status).padEnd(4)} ${r.type.padEnd(12)} ${r.bytes ? `${r.bytes}B` : ""}  ${path}`);
  if (ok && r.buf) {
    writeFileSync(`${OUT}/waiversig-${CONTROL}.jpg`, r.buf);
    found = path;
    break;
  }
}

if (!found) {
  console.log(`\n  No candidate served an image. The panel likely fetches it another way.`);
  process.exit(0);
}

console.log(`\n  FOUND: ${found}\n`);
console.log(`══════ now the PAD-signed waiver 58287632 (the one that matters) ══════`);
const padPath = found.replace(CONTROL, "58287632");
const r2 = await tryUrl(padPath);
console.log(`  ${String(r2.status)} ${r2.type} ${r2.bytes}B  ${padPath}`);
if (r2.buf) {
  writeFileSync(`${OUT}/waiversig-58287632.jpg`, r2.buf);
  console.log(`  saved ${OUT}/waiversig-58287632.jpg — LOOK AT IT.`);
  console.log(`  A blank white page = white-ink-on-transparent, i.e. the original diagnosis.`);
}
process.exit(0);
