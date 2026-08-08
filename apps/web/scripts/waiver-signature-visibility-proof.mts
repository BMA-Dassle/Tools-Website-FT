/**
 * LIVE PROOF (writes to BMI via Pandora) — why W57821's signatures are invisible.
 *
 * ROOT CAUSE: components/pandora/SignaturePad.tsx draws with strokeColor
 * "#ffffff" (white) and never fills a background, so `toDataURL("image/png")`
 * produced WHITE INK ON A TRANSPARENT BACKGROUND. BMI Office composites the
 * signature over the white waiver document → white-on-white → blank signature
 * line, even though the POST returned 201 + a waiverID and the PNG carried real
 * strokes.
 *
 * This writes the SAME hand-drawn squiggle twice, captioned, so the profile
 * itself proves it:
 *
 *   ARM C — white ink, transparent background  ← exactly what we shipped
 *   ARM D — dark ink, opaque white background   ← exactly what the fix ships
 *
 * Expected in BMI Office: D is legible, C is blank (or a bare caption).
 *
 * Usage (from apps/web):
 *   npx tsx scripts/waiver-signature-visibility-proof.mts            # DRY RUN
 *   npx tsx scripts/waiver-signature-visibility-proof.mts --live
 */
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement as h } from "react";
import { ImageResponse } from "next/og";
// The SHIPPED constants, not hand-typed copies — if the fix's colours ever
// change, this proof changes with them instead of quietly testing a fiction.
// Dynamic import: tsx's static ESM resolution does not honour the "@/" alias.
const { SIGNATURE_INK, SIGNATURE_PAGE } = await import("@/components/pandora/signature-export");

const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const LIVE = process.argv.includes("--live");
// Defaults to the internal "tester headpinz" record — NEVER a real guest, so
// proof marks never land on someone's legal waiver history.
const PERSON =
  (process.argv.find((a) => a.startsWith("--person=")) || "").split("=")[1] ||
  "63000000002660482";

/** A signature-shaped squiggle, drawn as an SVG path so both arms are pixel-
 *  identical except for ink colour and background opacity. */
const SQUIGGLE =
  "M20,120 C60,40 90,180 130,100 S200,30 240,110 S310,180 350,90 S420,40 460,120";

async function mark(opts: {
  ink: string;
  background: string;
  label: string;
  sub: string;
}): Promise<Buffer> {
  const img = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          // TRANSPARENT for arm C is expressed as a fully transparent fill.
          background: opts.background,
          padding: "24px 40px",
          fontFamily: "system-ui, sans-serif",
        },
      },
      h(
        "svg",
        { width: 480, height: 160, viewBox: "0 0 480 160" },
        h("path", {
          d: SQUIGGLE,
          fill: "none",
          stroke: opts.ink,
          strokeWidth: 6,
          strokeLinecap: "round",
        }),
      ),
      h(
        "div",
        { style: { fontSize: 30, fontWeight: 800, color: opts.ink, marginTop: 4 } },
        opts.label,
      ),
      h("div", { style: { fontSize: 20, color: opts.ink, marginTop: 4 } }, opts.sub),
    ),
    { width: 1000, height: 420 },
  );
  return Buffer.from(await img.arrayBuffer());
}

const ARMS = [
  {
    arm: "C",
    ink: "#ffffff", // SignaturePad's on-screen strokeColor default
    background: "rgba(0,0,0,0)", // transparent — an untouched canvas pixel
    label: "ARM C - BEFORE (white ink, transparent bg)",
    sub: "what every waiver signature looked like until 2026-08-08",
  },
  {
    arm: "D",
    ink: SIGNATURE_INK, // straight from signature-export.ts
    background: SIGNATURE_PAGE,
    label: "ARM D - AFTER (dark ink, white page)",
    sub: "what flattenSignatureToPng now uploads",
  },
];

const invalidationDate = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);

for (const a of ARMS) {
  const png = await mark(a);
  // Keep a local copy so the difference is inspectable without BMI at all.
  writeFileSync(`./waiver-arm-${a.arm}.png`, png);
  console.log(`── ARM ${a.arm}: ${a.label}  png=${png.length}B  (saved ./waiver-arm-${a.arm}.png)`);
  if (!LIVE) {
    console.log(`   DRY RUN — not posted\n`);
    continue;
  }
  const boundary = `----PandoraWaiver${Date.now()}${a.arm}`;
  const parts: Buffer[] = [];
  const field = (n: string, v: string) =>
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`),
    );
  field("locationID", LOC);
  field("personID", PERSON);
  field("waiverContentID", "19065376");
  field("sigPersonID", PERSON);
  field("invalidationDate", invalidationDate);
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
  );
  parts.push(png);
  parts.push(Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const res = await fetch(`${PANDORA}/bmi/waiver`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
  console.log(`   → HTTP ${res.status}  ${(await res.text()).slice(0, 200).replace(/\s+/g, " ")}\n`);
}

if (LIVE) {
  console.log(
    `  Open person ${PERSON} in BMI Office.\n` +
      `  Expect ARM D legible and ARM C blank. That difference IS the bug.`,
  );
}
process.exit(0);
