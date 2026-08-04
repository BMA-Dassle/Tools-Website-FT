/**
 * READ-ONLY probe #2 for the 9 PARKED race-pack rows:
 *   a) full refund detail for row #14's payment (shows REFUNDED $85.19)
 *   b) find each guest's CURRENT BMI person record via the Office
 *      search/person token search (email token, then phone token),
 *      confirming candidates against the person detail's addresses.
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-current-persons.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import https from "node:https";
import { randomUUID } from "node:crypto";
import { parseWithRawIds } from "@ft/db";
/* eslint-disable @typescript-eslint/no-explicit-any */

// ── a) refund detail on row #14 ─────────────────────────────────────
const SQ_HEADERS = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
};
const payRes = await fetch(
  "https://connect.squareup.com/v2/payments/D9oHrneHsPAp3pUIJ3wcJz6icleZY",
  { headers: SQ_HEADERS },
);
const pay = JSON.parse(await payRes.text());
console.log("row #14 payment refund_ids:", pay.payment?.refund_ids ?? []);
for (const rid of pay.payment?.refund_ids ?? []) {
  const r = await fetch(`https://connect.squareup.com/v2/refunds/${rid}`, { headers: SQ_HEADERS });
  const data = JSON.parse(await r.text());
  const rf = data.refund;
  console.log(
    `  refund ${rid}: $${(rf?.amount_money?.amount ?? 0) / 100} status=${rf?.status} created=${rf?.created_at} reason=${JSON.stringify(rf?.reason)}`,
  );
}
console.log();

// ── b) Office search for current person records ─────────────────────
const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";

async function getToken(): Promise<string> {
  const password = Buffer.from(OFFICE_PASS_B64, "base64").toString();
  const res = await fetch(`https://${OFFICE_HOST}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
      origin: "https://office.bmileisure.com",
      referer: "https://office.bmileisure.com/",
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`office auth ${res.status}`);
  return JSON.parse(await res.text()).access_token;
}
const token = await getToken();
const authHeaders = {
  Authorization: `Bearer ${token}`,
  "x-fast-version": SMS_VERSION,
  clientkey: CLIENT_KEY,
};

// Office search 500s under undici for some tokens — raw https like
// src/features/kiosk/license/lookup.server.ts.
function officeHttpsGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: OFFICE_HOST, path, headers: { ...authHeaders, "x-session-id": randomUUID() } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function search(tokenStr: string): Promise<Array<{ localId: string; description: string }>> {
  const path = `/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(tokenStr)}&maxResults=50`;
  let res = await officeHttpsGet(path);
  if (res.status >= 500) res = await officeHttpsGet(path);
  if (res.status >= 400) {
    console.log(`    search "${tokenStr}" → HTTP ${res.status}`);
    return [];
  }
  const hits = parseWithRawIds<any[]>(res.body, ["localId"]);
  return Array.isArray(hits) ? hits : [];
}

async function personDetail(id: string): Promise<any | null> {
  const res = await officeHttpsGet(`/api/${CLIENT_KEY}/person/${id}`);
  if (res.status >= 400) return null;
  return parseWithRawIds<any>(res.body);
}

const digits = (s: string) => String(s ?? "").replace(/\D/g, "");

const GUESTS = [
  { row: 3, credits: 3, kind: "12744871", email: "hepburn.mitchell@gmail.com", phone: "2678853950", name: "Mitchell Hepburn" },
  { row: 9, credits: 5, kind: "12744867", email: "jmsutton0905@gmail.com", phone: "9379008062", name: "Jonah Sutton" },
  { row: 12, credits: 3, kind: "12744871", email: "arcadio.arzola@gmail.com", phone: "2392589084", name: "Arcadio Arzola" },
  { row: 14, credits: 5, kind: "12744867", email: "junkribble@gmail.com", phone: "9203436461", name: "(refunded?)" },
  { row: 15, credits: 3, kind: "12744867", email: "joshandmarilu@gmail.com", phone: "2393220189", name: "Marilu Yates" },
  { row: 20, credits: 3, kind: "12744867", email: "searlecc@gmail.com", phone: "7032977211", name: "(searle?)" },
  { row: 24, credits: 3, kind: "12744871", email: "kdtropicgirl@gmail.com", phone: "2393046923", name: "Kathryn Dumas" },
  { row: 25, credits: 3, kind: "12744871", email: "eduardtsepordey@gmail.com", phone: "9413030819", name: "Eduard Tsepordey" },
  { row: 31, credits: 3, kind: "12744867", email: "bassilco@msn.com", phone: "2397388883", name: "Elie Bassil" },
];

for (const g of GUESTS) {
  console.log("═".repeat(70));
  console.log(`row #${g.row}  ${g.name}  owed=${g.credits} credits (kind ${g.kind})`);
  const seen = new Map<string, any>();
  for (const tok of [g.email, g.phone]) {
    const hits = await search(tok);
    console.log(`  token "${tok}" → ${hits.length} hit(s)`);
    for (const h of hits.slice(0, 10)) {
      if (seen.has(h.localId)) continue;
      const d = await personDetail(h.localId);
      if (!d) continue;
      const addr = d.addresses?.[0] ?? {};
      const emailMatch = (addr.email ?? "").toLowerCase() === g.email.toLowerCase();
      const phoneMatch =
        digits(addr.mobile).endsWith(g.phone) || digits(addr.phone).endsWith(g.phone);
      seen.set(h.localId, d);
      console.log(
        `    person ${h.localId}: ${d.firstName ?? ""} ${d.name ?? ""}  email=${addr.email ?? "-"} mobile=${addr.mobile ?? "-"}  races=${(d.tags ?? []).length}  match=${emailMatch ? "EMAIL" : phoneMatch ? "PHONE" : "weak"}  desc=${JSON.stringify(h.description)}`,
      );
    }
  }
  if (seen.size === 0) console.log("    NO current record found — desk must create/search manually");
}
console.log("═".repeat(70));
console.log("done (read-only — no writes performed)");
