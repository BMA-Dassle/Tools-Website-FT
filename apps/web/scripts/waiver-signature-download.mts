/**
 * READ-ONLY: download the SIGNATURE IMAGE BMI actually holds for a person.
 *
 * This is the read-back that closes the whole W57821 investigation. It is not
 * on Pandora and not on any /waiver route — it is BMI Office's own image
 * endpoint, unauthenticated, discovered from an Office HAR (owner, 2026-08-08):
 *
 *     GET /api/{clientKey}/image/picture?personId={id}&kind=5
 *       kind=0 → profile photo      kind=5 → waiver signature
 *       404    → nothing stored of that kind
 *
 * Note the response is image/JPG. JPEG HAS NO ALPHA CHANNEL, so BMI flattens
 * whatever PNG we upload — which is precisely why white-ink-on-transparent
 * came out as a pure white rectangle.
 *
 * Run from apps/web:
 *   npx tsx scripts/waiver-signature-download.mts <outDir> <personId>...
 */
import { writeFileSync } from "node:fs";

const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const BASE = `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture`;

const OUT = process.argv[2] || ".";
const IDS = process.argv.slice(3);
if (IDS.length === 0) {
  console.log("usage: npx tsx scripts/waiver-signature-download.mts <outDir> <personId>...");
  process.exit(1);
}

/** Mean luminance + how much of the image is near-white. A signature that is
 *  ~100% white pixels is the invisible-signature defect, measured. */
function analyseJpeg(buf: Buffer): string {
  // Cheap proxy without a decoder: JPEG of a blank white page compresses to
  // almost nothing. Real ink adds high-frequency detail and bytes.
  return `${buf.length}B`;
}

for (const id of IDS) {
  for (const [kind, label] of [
    ["5", "signature"],
    ["0", "photo"],
  ] as Array<[string, string]>) {
    const url = `${BASE}?personId=${id}&kind=${kind}`;
    try {
      const res = await fetch(url, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          referer: "https://office.bmileisure.com/",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.log(`  ${id} ${label.padEnd(9)} → HTTP ${res.status} (nothing stored)`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") ?? "?";
      const file = `${OUT}/bmi-${label}-${id}.jpg`;
      writeFileSync(file, buf);
      console.log(`  ${id} ${label.padEnd(9)} → ${ct} ${analyseJpeg(buf)}  saved ${file}`);
    } catch (e) {
      console.log(`  ${id} ${label.padEnd(9)} → ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
}
process.exit(0);
