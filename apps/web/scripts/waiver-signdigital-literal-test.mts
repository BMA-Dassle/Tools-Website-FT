/**
 * EXPERIMENT (TEST PERSON ONLY): call signWaiverDigital() ITSELF — the exact
 * function the HealthNet (2026-06-18) and Xmas (2026-07-30) backfills used —
 * and hash BMI's stored signature before and after.
 *
 * Owner recalls those uploads working. My earlier variant matrix only MIMICKED
 * that call; this invokes the real thing, so any difference I failed to
 * replicate (Uint8Array body, boundary format, template lookup, PNG encoder)
 * is included by construction.
 *
 * A changed hash = signWaiverDigital stores the image and the defect is OURS.
 * An unchanged hash = even that path never stored, and the HealthNet marks were
 * never visible either.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/waiver-signdigital-literal-test.mts --live
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";

const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const PERSON = "63000000002660482"; // tester headpinz — never a real guest
const LIVE = process.argv.includes("--live");

async function storedHash(): Promise<string> {
  try {
    const r = await fetch(
      `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture?personId=${PERSON}&kind=5&_=${Math.floor(
        performance.now() * 1000,
      )}`,
      {
        headers: { referer: "https://office.bmileisure.com/", "cache-control": "no-cache" },
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return `none(${r.status})`;
    const b = Buffer.from(await r.arrayBuffer());
    return `${createHash("sha256").update(b).digest("hex").slice(0, 12)}:${b.length}B`;
  } catch (e) {
    return `err`;
  }
}

const { signWaiverDigital } = await import("@/lib/waiver-digital");

const before = await storedHash();
console.log(`  BMI stored signature BEFORE : ${before}`);

if (!LIVE) {
  console.log("  DRY RUN — pass --live to invoke signWaiverDigital()");
  process.exit(0);
}

// The literal HealthNet/Xmas call. skipIfValid deliberately omitted so it always
// pushes (the test person already holds a valid waiver).
const result = await signWaiverDigital({
  personId: PERSON,
  name: "Signature Storage Test",
  locationKey: "fasttrax",
});
console.log(`  signWaiverDigital → ${JSON.stringify(result)}`);

await new Promise((r) => setTimeout(r, 4000));
const after = await storedHash();
console.log(`  BMI stored signature AFTER  : ${after}`);

console.log(`\n══════ VERDICT ══════`);
if (after !== before && after !== "err") {
  console.log(`  ✅ CHANGED — signWaiverDigital DOES store the image.`);
  console.log(`     The defect is in app/api/pandora/waiver/route.ts, not the vendor.`);
  console.log(`     Diff that route's multipart/body against lib/waiver-digital.tsx.`);
} else {
  console.log(`  ✗ UNCHANGED — even signWaiverDigital does not store the image.`);
  console.log(`     It returned a waiverID regardless. Vendor-side discard, confirmed`);
  console.log(`     against the exact code path the HealthNet backfill used.`);
}
process.exit(0);
