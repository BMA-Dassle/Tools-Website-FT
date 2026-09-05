// READ-ONLY live verification of the wallet fix: for each test record, run the
// REAL pickPublishableLoginCode from the worktree, then the SAME Office token
// search /r/{code}/wallet runs, and assert it resolves to exactly that person.
// Never mints a pass, never writes.
import https from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// createRequire, not a .ts-extension import: tsx resolves the extensionless
// require to the real module, and `next build`'s type pass (which covers
// scripts/) refuses '.ts' import specifiers.
import { createRequire } from "node:module";
const requireTs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const typesMod: any = requireTs("../src/features/kiosk/license/types");
const { pickPublishableLoginCode, RACER_PUBLIC_CODE_RE } = typesMod.default ?? typesMod;

for (const l of readFileSync("C:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";
const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";
const SMS_HEADERS = { origin: "https://office.bmileisure.com", referer: "https://office.bmileisure.com/" };

async function officeToken(): Promise<string> {
  const password = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
  const res = await fetch(`https://${OFFICE_HOST}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", clientkey: CLIENT_KEY, "x-fast-version": SMS_VERSION, ...SMS_HEADERS },
    body: `grant_type=password&username=${encodeURIComponent(process.env.BMI_OFFICE_USERNAME || "API2")}&password=${encodeURIComponent(password)}`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth ${res.status}`);
  return JSON.parse(text).access_token as string;
}
function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "x-fast-version": SMS_VERSION, "x-session-id": randomUUID(), clientkey: CLIENT_KEY };
}
function httpsGet(path: string, h: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((res, rej) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers: h }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode || 500, body: d }));
    });
    req.on("error", rej);
    req.setTimeout(15_000, () => { req.destroy(); rej(new Error("timeout")); });
  });
}
const parseRawIds = (t: string) => JSON.parse(t.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));

const token = await officeToken();

// The records that FAILED tonight (card/legacy tag newest) + controls that
// worked + the 9 recent racers from the earlier sample.
const CASES: Array<[string, string]> = [
  ["63000000000021716", "Alex Trepasso MAIN — card tag newest (was broken)"],
  ["682832", "Jamil Hisham MAIN — card tag newest (was broken)"],
  ["1569747", "Henrry Gomez MAIN — card tag newest (was broken)"],
  ["551330", "Katherine Trepasso — legacy 6-digit newest (was broken)"],
  ["553343", "Trepasso minor — legacy 6-digit newest (was broken)"],
  ["474816", "legacy record — 6-digit newest (was broken)"],
  ["3492108", "legacy record — 6-digit newest (was broken)"],
  ["409523", "Eric Osborn — control (worked before)"],
  ["12481992", "Andrew Bell — UUID newest (worked, UUID hop)"],
  ["63000000008158623", "James Bell — 13-char only"],
  ["63000000008235179", "Gerry Poppe"],
  ["14853248", "Jake Magee"],
  ["14570652", "Francisco Gonzalez"],
  ["14874836", "Jack Brown"],
  ["58578130", "isaiah t"],
  ["63000000008389023", "Jakob Lama — ZERO tags (chip must hide)"],
];

let pass = 0, fail = 0;
for (const [pid, label] of CASES) {
  const res = await fetch(`https://${OFFICE_HOST}/api/${CLIENT_KEY}/person/${pid}`, { headers: headers(token) });
  const text = await res.text();
  if (!res.ok) { console.log(`FAIL  ${pid} ${label}: person fetch ${res.status}`); fail++; continue; }
  const p = parseRawIds(text);
  const code = pickPublishableLoginCode(p.tags);

  if (!code) {
    const hasKind9or10 = (p.tags ?? []).some((t: any) => t.kind === 9 || t.kind === 10);
    if (hasKind9or10) { console.log(`FAIL  ${pid} ${label}: picker returned "" despite kind-9/10 tags`); fail++; }
    else { console.log(`ok    ${pid} ${label}: no publishable code → chip hidden (correct)`); pass++; }
    continue;
  }
  if (!RACER_PUBLIC_CODE_RE.test(code)) { console.log(`FAIL  ${pid} ${label}: picked "${code}" fails the route's shape gate`); fail++; continue; }

  // The wallet route's own resolution: token search must return EXACTLY this person.
  const s = await httpsGet(`/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(code)}&maxResults=500`, headers(token));
  const hits = s.status < 400 ? parseRawIds(s.body) : [];
  const ids = (Array.isArray(hits) ? hits : []).map((h: any) => String(h.localId));
  if (ids.length === 1 && ids[0] === pid) {
    console.log(`ok    ${pid} ${label}: picked ${code} → resolves uniquely to this person`);
    pass++;
  } else {
    console.log(`FAIL  ${pid} ${label}: picked ${code} → ${ids.length} hit(s) [${ids.join(",")}]`);
    fail++;
  }
}
console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
