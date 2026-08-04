// Racer login-code (BMI `person.tags[]`) semantics probe — PROBE 1 of the
// Apple Wallet racing-licence plan. READ-ONLY: only GETs, never writes.
//
// The wallet licence prints a login code on the pass (racers TYPE it at BMI)
// and carries it in the barcode as `/r/{code}`. Both uses assume the code is
// STABLE. Nothing in our codebase establishes that — we only ever read
// `tags[0].tag` after sorting by `lastSeen` desc (license/lookup.server.ts),
// and `races` is computed as `tags.length`, which only makes sense if tags
// accumulate. So:
//
//   Q1  How many tags does a real racer carry, and what do they look like?
//   Q2  Does EVERY tag still resolve via `search/person?token=`, or only the
//       newest? (If only the newest, a printed pass goes stale the moment BMI
//       issues a new tag, and the pass must be re-minted on every visit.)
//   Q3  Does a tag resolve UNIQUELY, or does one token return several people?
//       (`lookupMemberMatches` applies no name/DOB confirmation — possession of
//       the code IS the identity — so a colliding token would sign the wrong
//       guest in.)
//   Q4  Is the racing licence's expiry readable off `memberships[].stops`?
//       PR2 needs a DATE for "valid until", and `personHasActiveLicense`
//       currently collapses it to a boolean.
//
// Run from apps/web:
//   npx tsx scripts/racer-tag-semantics-probe.mts
//   PERSON_IDS=409523,313535 npx tsx scripts/racer-tag-semantics-probe.mts
//   CLIENT_KEY=headpinznaples npx tsx scripts/racer-tag-semantics-probe.mts
//
// Gotchas honored (tasks/lessons.md + license/lookup.server.ts):
//   - `search/person` MUST go over raw https.get. It 500s under Node
//     fetch/undici for single-word tokens, and a bare login code is exactly
//     that. person/{id} is fine on fetch.
//   - Office ids are 17 digits on modern records → raw-id quoting before
//     JSON.parse, NEVER res.json().
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const CLIENT_KEY = process.env.CLIENT_KEY || process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_BASE = `https://${OFFICE_HOST}`;
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const SMS_VERSION = "6251006 202511051229";
const SMS_HEADERS = {
  origin: "https://office.bmileisure.com",
  referer: "https://office.bmileisure.com/",
};

/** Eric Osborn — the record every licence probe so far has used. */
const DEFAULT_PERSON_IDS = ["409523"];
const PERSON_IDS = (process.env.PERSON_IDS || DEFAULT_PERSON_IDS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}

async function officeToken(): Promise<string> {
  const password = OFFICE_PASS_B64 ? Buffer.from(OFFICE_PASS_B64, "base64").toString() : "";
  const res = await fetch(`${OFFICE_BASE}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
      ...SMS_HEADERS,
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Office auth ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).access_token as string;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
  };
}

/** Raw-https GET — undici 500s on single-word / slash-bearing search tokens. */
function httpsGet(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((res, rej) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode || 500, body: d }));
    });
    req.on("error", rej);
    req.setTimeout(15_000, () => {
      req.destroy();
      rej(new Error("timeout"));
    });
  });
}

async function searchPerson(token: string, searchToken: string) {
  const path = `/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(searchToken)}&maxResults=500`;
  const t0 = Date.now();
  const r = await httpsGet(path, authHeaders(token));
  const ms = Date.now() - t0;
  if (r.status >= 400) return { ms, status: r.status, hits: [] as any[] };
  const hits = parseRawIds(r.body);
  return { ms, status: r.status, hits: Array.isArray(hits) ? hits : [] };
}

async function getPerson(token: string, id: string) {
  const res = await fetch(`${OFFICE_BASE}/api/${CLIENT_KEY}/person/${id}`, {
    headers: authHeaders(token),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`person/${id} → ${res.status}: ${text.slice(0, 200)}`);
  return parseRawIds(text);
}

async function main() {
  console.log(`clientKey=${CLIENT_KEY}  persons=${PERSON_IDS.join(",")}\n`);
  const token = await officeToken();
  console.log("auth OK\n");

  for (const id of PERSON_IDS) {
    let p: any;
    try {
      p = await getPerson(token, id);
    } catch (e) {
      console.log(`person ${id}: FAILED — ${(e as Error).message}\n`);
      continue;
    }

    const name = `${p.firstName ?? ""} ${p.name ?? ""}`.trim();
    const tags: any[] = Array.isArray(p.tags) ? p.tags : [];
    console.log(`── person ${id}  ${name}  (birthDate=${p.birthDate ?? "—"})`);

    // Q1 — how many, what shape, what spread of lastSeen.
    console.log(`   Q1 tags: ${tags.length}`);
    const sorted = [...tags].sort((a, b) =>
      String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")),
    );
    for (const [i, t] of sorted.entries()) {
      const tag = String(t.tag ?? "");
      const shape = `len=${tag.length} ${/^[a-z0-9]+$/.test(tag) ? "lower-alnum" : "OTHER"}`;
      console.log(
        `      [${i}] ${tag}  lastSeen=${t.lastSeen ?? "—"}  ${shape}${i === 0 ? "   <- what we print today" : ""}`,
      );
    }

    // Q4 — licence expiry as a DATE, which PR2 needs for "valid until".
    const memberships: any[] = Array.isArray(p.memberships) ? p.memberships : [];
    const licences = memberships.filter((m) => String(m.name ?? "").toLowerCase().includes("licen"));
    console.log(`   Q4 memberships: ${memberships.length}, licence-ish: ${licences.length}`);
    for (const m of licences) {
      const stops = m.stops ?? null;
      const live = stops ? new Date(stops).getTime() > Date.now() : true;
      console.log(`      "${m.name}" stops=${stops ?? "(none → open-ended)"} active=${live}`);
    }
    if (memberships.length && !licences.length) {
      console.log(`      (names seen: ${memberships.map((m) => m.name).join(" | ")})`);
    }

    // Q2 + Q3 — does EVERY tag resolve, and does it resolve UNIQUELY?
    console.log(`   Q2/Q3 resolving each tag through search/person?token=`);
    for (const t of sorted) {
      const tag = String(t.tag ?? "");
      if (!tag) continue;
      const { ms, status, hits } = await searchPerson(token, tag);
      const ids = hits.map((h: any) => String(h.localId));
      const uniq = ids.length === 1 && ids[0] === String(id);
      const verdict =
        status >= 400
          ? `HTTP ${status}`
          : ids.length === 0
            ? "NO HITS  <- a pass printed with this code would dead-end"
            : uniq
              ? "unique, correct person"
              : `${ids.length} hits [${ids.join(",")}]${ids.includes(String(id)) ? "" : " <- WRONG PERSON"}`;
      console.log(`      ${tag}  ${ms}ms  ${verdict}`);
    }
    console.log("");
  }

  console.log("Reminder: this is READ-ONLY. Nothing above wrote to BMI.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
