/**
 * Render the per-lane "Bowl Now" QR ads to JPG (for print / social / a
 * designer). Composites the duckpin-lanes photo (decoded by sharp) under an
 * SVG overlay (navy scrim + type + the lane's QR). Also emits a gallery HTML
 * with per-image download links.
 *
 * Pure/local — no network. Uses sharp + qrcode (both already project deps).
 *
 * Usage: npx tsx scripts/generate-bowl-now-ad-jpgs.ts [outDir] [laneCount]
 * Run from apps/web (npm exec -w fasttrax-web) so deps + the photo resolve.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import QRCode from "qrcode";
import sharp from "sharp";

const OUTDIR = process.argv[2] || ".";
const LANES = Number(process.argv[3]) || 8;
const BASE = "https://fasttraxent.com/book/duck-pin/v2?playNow=1&lane=";
const PHOTO = resolve(process.cwd(), "../../duckpin-bowling-R8vkBZc68YfiqmN7yP2SP2hElvWOCX.webp");
const W = 1600;
const H = 1000;
const NAVY = "#000418";
const CYAN = "#00E2E5";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function overlaySvg(lane: number, qrDataUri: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${NAVY}" stop-opacity="0.97"/>
      <stop offset="0.42" stop-color="${NAVY}" stop-opacity="0.9"/>
      <stop offset="0.72" stop-color="${NAVY}" stop-opacity="0.5"/>
      <stop offset="1" stop-color="${NAVY}" stop-opacity="0.78"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${CYAN}"/>
      <stop offset="1" stop-color="${CYAN}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>
  <text x="96" y="152" fill="${CYAN}" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="10">FASTTRAX DUCKPIN</text>
  <text x="90" y="340" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="180" font-weight="800">LANE ${lane}</text>
  <text x="94" y="480" fill="${CYAN}" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="800">BOWL NOW</text>
  <text x="96" y="566" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="40" opacity="0.92">${xml("Scan to reserve this lane & play — right now.")}</text>
  <text x="96" y="656" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30" opacity="0.82">${xml("1   Scan with your phone camera")}</text>
  <text x="96" y="708" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30" opacity="0.82">${xml("2   Add who's bowling & pick your time")}</text>
  <text x="96" y="760" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30" opacity="0.82">${xml("3   Pay — your lane turns on automatically")}</text>
  <rect x="1140" y="292" width="384" height="384" rx="28" fill="#ffffff"/>
  <image x="1162" y="314" width="340" height="340" href="${qrDataUri}"/>
  <text x="1332" y="726" fill="${CYAN}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" text-anchor="middle" letter-spacing="2">LANE ${lane} · FASTTRAXENT.COM</text>
  <rect x="0" y="986" width="${W}" height="14" fill="url(#rule)"/>
</svg>`;
}

async function main() {
  readFileSync(PHOTO); // fail fast if the photo is missing
  const photo = await sharp(PHOTO).resize(W, H, { fit: "cover" }).toBuffer();
  const links: Array<{ n: number; b64: string }> = [];

  for (let n = 1; n <= LANES; n++) {
    const qrPng = await QRCode.toBuffer(`${BASE}${n}`, {
      type: "png",
      width: 340,
      margin: 1,
      color: { dark: NAVY, light: "#ffffff" },
    });
    const svg = overlaySvg(n, `data:image/png;base64,${qrPng.toString("base64")}`);
    const jpg = await sharp(photo)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
    writeFileSync(resolve(OUTDIR, `bowl-now-lane-${n}.jpg`), jpg);
    links.push({ n, b64: jpg.toString("base64") });
  }

  const cards = links
    .map(
      ({ n, b64 }) => `  <figure>
    <img src="data:image/jpeg;base64,${b64}" alt="FastTrax Duckpin Bowl Now — Lane ${n}" />
    <figcaption>Lane ${n} · <a download="bowl-now-lane-${n}.jpg" href="data:image/jpeg;base64,${b64}">Download JPG</a></figcaption>
  </figure>`,
    )
    .join("\n");
  const gallery = `<style>
  body { background:${NAVY}; color:#cfe9ea; font-family:system-ui,Segoe UI,Roboto,sans-serif; margin:0; padding:28px; }
  h1 { color:${CYAN}; font-size:22px; letter-spacing:.02em; margin:0 0 4px; }
  p.note { color:#8fa8b3; font-size:14px; margin:0 0 24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); gap:20px; }
  figure { margin:0; background:#0b1230; border-radius:14px; overflow:hidden; }
  img { width:100%; height:auto; display:block; }
  figcaption { padding:12px 16px; font-size:14px; font-weight:600; }
  a { color:${CYAN}; }
</style>
<h1>FastTrax Duckpin — Bowl Now lane ads (JPG)</h1>
<p class="note">${LANES} lanes · 1600×1000 · each QR deep-links to fasttraxent.com/book/duck-pin/v2?playNow=1&amp;lane=N. Click “Download JPG” on any ad, or right-click → Save image.</p>
<div class="grid">
${cards}
</div>`;
  writeFileSync(resolve(OUTDIR, "bowl-now-ad-jpgs.html"), gallery);
  console.log(`Wrote ${LANES} JPGs + gallery → ${resolve(OUTDIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
