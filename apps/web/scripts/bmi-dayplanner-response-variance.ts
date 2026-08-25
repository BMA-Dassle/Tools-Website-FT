/**
 * bmi-dayplanner-response-variance — LIVE, READ-ONLY diagnostic.
 *
 * The session-id probe found every dayPlanner response hashing differently
 * while the byte LENGTH stayed identical to the byte. That is the signature of
 * a fixed-width field that varies per response, not of stale or corrupted data
 * — but "looks like" is not evidence. This finds the actual differing bytes and
 * names the JSON paths, so the probe can compare on something meaningful.
 *
 * Two GETs, same stable session id, back to back.
 *
 *   npx tsx scripts/bmi-dayplanner-response-variance.ts
 */

import https from "https";
import { officeReadSessionId } from "../lib/bmi-office-ids";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

/** Env only — see the note in bmi-session-id-reuse-probe.ts. */
const envUser = process.env.BMI_OFFICE_USERNAME;
const envPass = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD;
if (!envUser || !envPass) {
  console.error("Need BMI_OFFICE_USERNAME and BMI_OFFICE_PASSWORD(_B64) — use --env-file.");
  process.exit(2);
}
const OFFICE_USER: string = envUser;
const OFFICE_PASS: string = envPass;
const CK = "headpinzftmyers";

function req(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    r.on("error", reject);
    r.setTimeout(45_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

/** Every JSON path whose leaf value differs between two parsed payloads. */
function diffPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length > 40) return out;
  if (a === b) return out;
  const bothObj = a && b && typeof a === "object" && typeof b === "object";
  if (!bothObj) {
    out.push(`${path || "(root)"}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array/object shape changed`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} → ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      diffPaths(a[i], b[i], `${path}[${i}]`, out);
    }
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    diffPaths(ao[k], bo[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

async function main() {
  const auth = await req(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CK,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  const tok = JSON.parse(auth.body).access_token;
  const sid = officeReadSessionId("read", CK);
  const H = {
    Authorization: `Bearer ${tok}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": sid,
    clientkey: CK,
  };

  const meta = await req("GET", `/api/${CK}/metadata`, H);
  const parsed = JSON.parse(meta.body);
  const ids = new Set<string>();
  for (const r of (parsed.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (parsed.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const rp = [...ids].map((i) => `resourceIds=${i}`).join("&");
  const today = new Date().toISOString().slice(0, 10);
  const path = `/api/${CK}/dayPlanner?${rp}&from=${today}&till=${today}&showAll=true`;

  console.log(`same session id "${sid}", two back-to-back GETs\n`);
  const a = await req("GET", path, H);
  const b = await req("GET", path, H);
  console.log(
    `lengths: ${a.body.length} vs ${b.body.length}` +
      (a.body.length === b.body.length ? "  (identical)" : "  (DIFFERENT)"),
  );

  // First raw byte that differs, with context — the fastest way to see the field.
  let at = -1;
  for (let i = 0; i < Math.min(a.body.length, b.body.length); i++) {
    if (a.body[i] !== b.body[i]) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    console.log("\nBODIES ARE BYTE-IDENTICAL — the earlier divergence was transient.");
  } else {
    const from = Math.max(0, at - 90);
    console.log(`\nfirst differing byte at offset ${at}:`);
    console.log(`  A …${a.body.slice(from, at + 60)}…`);
    console.log(`  B …${b.body.slice(from, at + 60)}…`);
  }

  const paths = diffPaths(JSON.parse(a.body), JSON.parse(b.body));
  console.log(
    `\ndiffering JSON paths (${paths.length}${paths.length > 40 ? "+, truncated" : ""}):`,
  );
  for (const p of paths.slice(0, 40)) console.log(`  ${p}`);
  if (!paths.length) console.log("  none — payloads are semantically identical");
}

main();
