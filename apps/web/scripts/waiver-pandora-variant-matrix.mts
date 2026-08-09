/**
 * EXPERIMENT (writes to BMI, TEST PERSON ONLY): which POST /bmi/waiver variant
 * actually makes BMI store the signature image?
 *
 * Until 2026-08-08 we were blind — Pandora returns 201 + a waiverID whether or
 * not it stores the image, so every variant looked identical. Office's read-back
 * (GET image/picture?personId=X&kind=5) ends that: we can now WRITE a variant
 * and immediately SEE whether the stored image changed.
 *
 * Method: hash the test person's stored signature, POST one variant, re-hash.
 * A CHANGED hash means that variant landed. The test person already has a
 * desk-signed image from 2026-03, so the baseline is a real image rather than a
 * 404 — which makes "changed" unambiguous in both directions.
 *
 * Only ever runs against "tester headpinz" (63000000002660482). A variant that
 * works overwrites that test record's signature, which is the point of having a
 * test record.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/waiver-pandora-variant-matrix.mts          # DRY RUN (lists variants)
 *   npx tsx scripts/waiver-pandora-variant-matrix.mts --live
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { createElement as h } from "react";
import { ImageResponse } from "next/og";

const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const PERSON = "63000000002660482"; // tester headpinz — NEVER a real guest
const CONTENT_ID = "19065376";
const LIVE = process.argv.includes("--live");

if (!LIVE) console.log("🟢 DRY RUN — no writes\n");

/** Current stored signature, hashed. "none" when BMI holds nothing. */
async function storedHash(): Promise<string> {
  try {
    const r = await fetch(
      // cache-buster: the endpoint answers cache-control public,max-age=3600
      `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture?personId=${PERSON}&kind=5&_=${Math.floor(
        performance.now() * 1000,
      )}`,
      {
        headers: { referer: "https://office.bmileisure.com/", "cache-control": "no-cache" },
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return "none";
    const b = Buffer.from(await r.arrayBuffer());
    return `${createHash("sha256").update(b).digest("hex").slice(0, 12)}:${b.length}B`;
  } catch {
    return "err";
  }
}

async function png(label: string): Promise<Buffer> {
  const img = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#ffffff",
          color: "#0a0a0a",
          fontFamily: "system-ui, sans-serif",
          fontSize: 40,
          alignItems: "center",
          justifyContent: "center",
        },
      },
      label,
    ),
    { width: 600, height: 250 },
  );
  return Buffer.from(await img.arrayBuffer());
}

interface Variant {
  name: string;
  why: string;
  contentType?: string | null;
  filename?: string;
  sigFirst?: boolean;
  asBase64Field?: boolean;
  fieldName?: string;
}

const VARIANTS: Variant[] = [
  { name: "baseline", why: "what we ship today: PNG, image/png, signature last", contentType: "image/png", filename: "signature.png" },
  { name: "sig-first", why: "file part BEFORE the text fields — some parsers bind on order", contentType: "image/png", filename: "signature.png", sigFirst: true },
  { name: "octet-stream", why: "generic binary type instead of image/png", contentType: "application/octet-stream", filename: "signature.png" },
  { name: "no-content-type", why: "omit the part Content-Type entirely", contentType: null, filename: "signature.png" },
  { name: "jpeg-part", why: "BMI SERVES image/jpg — maybe it stores only what it can read as jpg", contentType: "image/jpeg", filename: "signature.jpg" },
  { name: "bare-filename", why: "filename without an extension", contentType: "image/png", filename: "signature" },
  { name: "field-Signature", why: "capitalised field name — case-sensitive binding", contentType: "image/png", filename: "signature.png", fieldName: "Signature" },
  { name: "base64-text-field", why: "signature as a base64 TEXT field, not a file part", asBase64Field: true },
];

console.log(`test person ${PERSON} · ${VARIANTS.length} variants\n`);
const before0 = await storedHash();
console.log(`  stored signature BEFORE anything: ${before0}\n`);

const results: Array<{ v: string; http: string; changed: boolean; after: string }> = [];

for (const v of VARIANTS) {
  if (!LIVE) {
    console.log(`  · ${v.name.padEnd(18)} ${v.why}`);
    continue;
  }
  const before = await storedHash();
  const body = await png(`VARIANT ${v.name}`);
  const boundary = `----PandoraWaiver${Date.now()}`;
  const parts: Buffer[] = [];
  const field = (n: string, val: string) =>
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${val}\r\n`),
    );
  const filePart = () => {
    if (v.asBase64Field) {
      field("signature", body.toString("base64"));
      return;
    }
    const ct = v.contentType === null ? "" : `Content-Type: ${v.contentType}\r\n`;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${v.fieldName ?? "signature"}"; filename="${v.filename}"\r\n${ct}\r\n`,
      ),
    );
    parts.push(body);
    parts.push(Buffer.from("\r\n"));
  };

  if (v.sigFirst) filePart();
  field("locationID", LOC);
  field("personID", PERSON);
  field("waiverContentID", CONTENT_ID);
  field("sigPersonID", PERSON);
  field("invalidationDate", new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  if (!v.sigFirst) filePart();
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  let http = "?";
  try {
    const res = await fetch(`${PANDORA}/bmi/waiver`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(Buffer.concat(parts)),
      signal: AbortSignal.timeout(30000),
    });
    const t = await res.text();
    http = `${res.status} ${t.slice(0, 90).replace(/\s+/g, " ")}`;
  } catch (e) {
    http = `ERR ${e instanceof Error ? e.message : e}`;
  }

  await new Promise((r) => setTimeout(r, 2500)); // let BMI settle
  const after = await storedHash();
  const changed = after !== before && after !== "err";
  results.push({ v: v.name, http, changed, after });
  console.log(
    `  ${changed ? "✅ STORED" : "✗ not stored"}  ${v.name.padEnd(18)} http=${http}\n       before=${before} after=${after}`,
  );
}

if (LIVE) {
  console.log(`\n══════ RESULT ══════`);
  const win = results.filter((r) => r.changed);
  if (win.length === 0) {
    console.log(`  NO variant caused BMI to store the image.`);
    console.log(`  Every one returned a waiverID. This is a Pandora-side defect:`);
    console.log(`  the endpoint accepts "signature" per its own spec and discards it.`);
  } else {
    for (const w of win) console.log(`  ✅ "${w.v}" STORED the image → ${w.after}`);
    console.log(`  → change app/api/pandora/waiver/route.ts to match that variant.`);
  }
}
process.exit(0);
