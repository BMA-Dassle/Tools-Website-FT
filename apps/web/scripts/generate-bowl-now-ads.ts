/**
 * Generate the printable per-lane "Bowl Now" QR ads for FastTrax duckpin.
 *
 * One landscape page per lane: big LANE number + "BOWL NOW — SCAN TO PLAY" +
 * the QR that deep-links straight into the Play Now flow pinned to THAT lane
 * (?playNow=1&lane=N). Self-contained HTML with inline SVG QRs (no external
 * assets), FastTrax-skinned, ready to print or hand to a designer.
 *
 * Pure/local — no network, no vendor calls. Uses the `qrcode` dep already in
 * the project.
 *
 * Usage:
 *   npx tsx scripts/generate-bowl-now-ads.ts [outFile] [laneCount] [baseUrl]
 * Defaults: bowl-now-ads.html, 8 lanes,
 *   https://fasttraxent.com/book/duck-pin/v2?playNow=1&lane=
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import QRCode from "qrcode";

const OUT = process.argv[2] || "bowl-now-ads.html";
const LANES = Number(process.argv[3]) || 8;
const BASE = process.argv[4] || "https://fasttraxent.com/book/duck-pin/v2?playNow=1&lane=";

const NAVY = "#000418";
const CYAN = "#00E2E5";

async function laneCard(lane: number): Promise<string> {
  const url = `${BASE}${lane}`;
  const qr = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    color: { dark: NAVY, light: "#ffffff" },
  });
  return `
  <section class="ad">
    <div class="left">
      <div class="brand">FASTTRAX&nbsp;DUCKPIN</div>
      <div class="lane">LANE ${lane}</div>
      <div class="cta">BOWL NOW</div>
      <div class="sub">Scan to reserve this lane &amp; start bowling — right now.</div>
      <ol class="steps">
        <li>Scan with your phone camera</li>
        <li>Add who's bowling &amp; pick 30/60/90 min</li>
        <li>Pay — your lane turns on automatically</li>
      </ol>
    </div>
    <div class="right">
      <div class="qrbox">${qr}</div>
      <div class="qrhint">Lane ${lane} · fasttraxent.com</div>
    </div>
  </section>`;
}

async function main() {
  const cards = await Promise.all(Array.from({ length: LANES }, (_, i) => laneCard(i + 1)));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>FastTrax Duckpin — Bowl Now lane ads</title>
<style>
  @page { size: landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .ad {
    width: 100vw; height: 100vh; page-break-after: always;
    background: ${NAVY}; color: #fff; display: flex; align-items: center;
    gap: 4vw; padding: 6vh 6vw;
  }
  .left { flex: 1 1 55%; }
  .right { flex: 0 0 34%; text-align: center; }
  .brand { color: ${CYAN}; font-weight: 800; letter-spacing: .35em; font-size: 2.4vh; }
  .lane { font-weight: 900; font-size: 13vh; line-height: .95; margin: 1vh 0; }
  .cta { color: ${CYAN}; font-weight: 900; font-size: 9vh; line-height: 1; letter-spacing: .02em; }
  .sub { font-size: 3vh; opacity: .85; margin-top: 2vh; max-width: 22ch; }
  .steps { margin: 3vh 0 0; padding-left: 3vh; font-size: 2.4vh; opacity: .8; line-height: 1.7; }
  .qrbox { background: #fff; border-radius: 3vh; padding: 3vh; display: inline-block; }
  .qrbox svg { width: 30vh; height: 30vh; display: block; }
  .qrhint { margin-top: 2vh; color: ${CYAN}; font-weight: 700; letter-spacing: .1em; font-size: 2.2vh; }
</style>
</head>
<body>
${cards.join("\n")}
</body>
</html>`;

  const outPath = resolve(process.cwd(), OUT);
  writeFileSync(outPath, html, "utf8");
  console.log(`Wrote ${LANES} lane ads → ${outPath}`);
  console.log(`QR target: ${BASE}<lane>`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
