/**
 * READ-ONLY: call the REAL listBrowseRows() and cross-check every row's shown
 * time against BMI's own schedule for that reservation. NO WRITES.
 *
 * This is the end-to-end check for the browse-list fix: not a reimplementation
 * of the logic, the actual exported function the kiosk route calls.
 *
 * Run from apps/web:  npx tsx scripts/browse-list-verify.mts [fort-myers|naples]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";
import { parseWithRawIds } from "@ft/db";
const { listBrowseRows, readRef } = await import("~/features/kiosk/checkin/server");

const center = (process.argv[2] || "fort-myers") as "fort-myers" | "naples";
const rows = await listBrowseRows(center);
console.log(`listBrowseRows("${center}") → ${rows.length} row(s)\n`);

// BMI auth for the cross-check.
const HOST = "office-api22.sms-timing.com";
const CK = center === "naples" ? "headpinznaples" : "headpinzftmyers";
const VER = "6251006 202511051229";
const pw = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const token = JSON.parse(
  await (
    await fetch(`https://${HOST}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        clientkey: CK,
        "x-fast-version": VER,
        origin: "https://office.bmileisure.com",
        referer: "https://office.bmileisure.com/",
      },
      body: `grant_type=password&username=${process.env.BMI_OFFICE_USERNAME || "API2"}&password=${encodeURIComponent(pw)}`,
    })
  ).text(),
).access_token;
function get(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const r = https.get(
      {
        hostname: HOST,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-fast-version": VER,
          clientkey: CK,
          "x-session-id": randomUUID(),
        },
      },
      (x) => {
        let d = "";
        x.on("data", (c) => (d += c));
        x.on("end", () => res(d));
      },
    );
    r.on("error", rej);
    r.setTimeout(20_000, () => {
      r.destroy();
      rej(new Error("timeout"));
    });
  });
}
function projectIdFor(bill: string): string {
  const head = bill.slice(0, -10);
  const tail = bill.slice(-10);
  return head + String(Number(tail) + 1).padStart(10, "0");
}
const hhmm = (iso: string) => {
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (!m) return "??";
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
};

let ok = 0;
let bad = 0;
let unknown = 0;
for (const r of rows) {
  // The ref is opaque; resolve it back to the bill so we can ask BMI.
  const handle = await readRef(r.ref);
  const bill = handle?.billId;
  if (!bill) {
    console.log(`  ${r.timeLabel.padEnd(9)} ${r.label.padEnd(18)} (ref unresolvable)`);
    unknown++;
    continue;
  }
  let bmiStart = "";
  let stateName = "";
  try {
    const proj = parseWithRawIds<any>(await get(`/api/${CK}/project/${projectIdFor(bill)}`));
    const usable = (proj?.schedules ?? []).filter(
      (s: any) => Number(s?.persons ?? 0) > 0 && String(s?.productLines ?? "").trim(),
    );
    bmiStart = usable.map((s: any) => String(s.start)).sort()[0] ?? "";
    stateName = String(proj?.stateId ?? "");
  } catch {
    /* leave blank */
  }
  const shown = r.timeLabel.trim();
  const expect = bmiStart ? hhmm(bmiStart) : "";
  const match = expect && shown === expect;
  if (!expect) unknown++;
  else if (match) ok++;
  else bad++;
  console.log(
    `  shown=${shown.padEnd(9)} bmi=${(expect || "—").padEnd(9)} ${match ? "✓" : expect ? "✗ MISMATCH" : "· no bmi schedule"}  ` +
      `${r.label.padEnd(18)} ${r.activitiesLabel}${r.express ? " [express]" : ""} state=${stateName}`,
  );
}
console.log(`\nmatches BMI: ${ok}   mismatched: ${bad}   unverifiable: ${unknown}`);
process.exit(0);
