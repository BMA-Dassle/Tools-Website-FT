/**
 * READ-ONLY roster forensics for a reservation — the four sources kiosk check-in
 * unions, side by side, plus a faithful REPLAY of the current dedupe so we can
 * see exactly what "Load your party" would render and why. NO WRITES.
 *
 * Answers, against real data:
 *   - were the ALL-CAPS "Account + waiver needed" names actually in BMI
 *     (RC1 = the id-less booking label shadowed them), or genuinely absent
 *     (RC7 = the at-home /waiver attach never reached BMI)?
 *
 * Run from apps/web:  npx tsx scripts/w57387-roster-forensics.mts [W57387]
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

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";
const W = (process.argv[2] || "W57387").toUpperCase();

// ── Office auth ─────────────────────────────────────────────────────────────
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
function officeGet(path: string): Promise<{ status: number; body: string }> {
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
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// ── 1. W-number → projectId → billId ────────────────────────────────────────
console.log(`══════ 1. Office search ${W} ══════`);
const searchRes = await officeGet(
  `/api/${CLIENT_KEY}/search?token=${encodeURIComponent(W)}&maxResults=5`,
);
if (searchRes.status >= 400) {
  console.log(`  search HTTP ${searchRes.status}: ${searchRes.body.slice(0, 300)}`);
  process.exit(1);
}
const hits = parseWithRawIds<any[]>(searchRes.body) ?? [];
for (const h of hits) console.log(`  hit kind=${h.kind} localId=${h.localId} ${h.description ?? h.name ?? ""}`);
const projHit = hits.find((h: any) => h?.kind === 2);
if (!projHit?.localId) {
  console.log("  no kind===2 project hit — cannot continue");
  process.exit(1);
}
const projectId = String(projHit.localId);
// billId = projectId - 1, on the last 10 digits only (17-digit ids exceed MAX_SAFE_INTEGER)
const head = projectId.slice(0, -10);
const tail = projectId.slice(-10);
const billId = tail === "0000000000" ? "" : head + String(Number(tail) - 1).padStart(10, "0");
console.log(`  projectId=${projectId}  →  billId=${billId || "(unresolvable)"}`);

// ── 2. BMI persons_list (SOURCE OF RECORD for reservation membership) ───────
console.log(`\n══════ 2. BMI project ${projectId} persons_list ══════`);
const projRes = await officeGet(`/api/${CLIENT_KEY}/project/${projectId}`);
const project = projRes.status < 400 ? parseWithRawIds<any>(projRes.body) : null;
if (projRes.status >= 400) console.log(`  HTTP ${projRes.status}: ${projRes.body.slice(0, 200)}`);

// The RAW project carries `projectPersons` (id refs). getReservationDetail turns
// those into `persons_list` by POSTing personsByIds — so projectPersons IS the
// membership source of record; persons_list is just its hydrated form.
const projectPersons: any[] = project?.projectPersons ?? [];
console.log(`  projectPersons count = ${projectPersons.length}`);
for (const pp of projectPersons) console.log(`    • raw ${JSON.stringify(pp)}`);

let personsList: any[] = [];
const ppIds = projectPersons
  .map((pp) => (pp?.personId !== undefined && pp?.personId !== null ? String(pp.personId) : ""))
  .filter(Boolean);
if (ppIds.length > 0) {
  const profRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = `[${ppIds.join(",")}]`; // raw-text ids, never JSON.stringify
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path: `/api/${CLIENT_KEY}/personprofile/personsByIds`,
        method: "POST",
        headers: {
          ...authHeaders,
          "x-session-id": randomUUID(),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: d }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end(payload);
  });
  if (profRes.status < 400) personsList = parseWithRawIds<any[]>(profRes.body) ?? [];
  else console.log(`  personsByIds HTTP ${profRes.status}: ${profRes.body.slice(0, 200)}`);
}
console.log(`  persons_list (hydrated) count = ${personsList.length}`);
for (const p of personsList) {
  console.log(
    `    • personId=${p.personId ?? p.id ?? "(none)"} "${[p.firstName, p.name].filter(Boolean).join(" ")}"`,
  );
}
const projArrays = Object.keys(project ?? {}).filter((k) => Array.isArray((project as any)[k]));
console.log(`  (project arrays present: ${projArrays.join(", ") || "none"})`);

// ── 3. Redis booking record racers[] ────────────────────────────────────────
console.log(`\n══════ 3. Redis bookingrecord:${billId} racers[] ══════`);
let recordRacers: Array<{ racerName?: string; personId?: string | null }> = [];
let recordContact: any = null;
let primaryPersonId: string | null = null;
try {
  const { default: redis } = await import("@/lib/redis");
  const raw = billId ? await redis.get(`bookingrecord:${billId}`) : null;
  if (!raw) {
    console.log("  (no record — evicted or never written)");
  } else {
    const rec = typeof raw === "string" ? JSON.parse(raw) : raw;
    recordRacers = rec.racers ?? [];
    recordContact = rec.contact ?? null;
    primaryPersonId = rec.primaryPersonId ?? null;
    console.log(`  status=${rec.status} racers=${recordRacers.length} primaryPersonId=${primaryPersonId}`);
    for (const r of recordRacers) {
      console.log(`    • "${r.racerName ?? ""}" personId=${r.personId ?? "NULL"}`);
    }
    if (recordContact) {
      console.log(`  contact: "${recordContact.firstName ?? ""} ${recordContact.lastName ?? ""}"`);
    }
  }
} catch (e) {
  console.log(`  redis unavailable: ${e instanceof Error ? e.message : e}`);
}

// ── 4. Neon booking_metadata.heats[] ────────────────────────────────────────
console.log(`\n══════ 4. Neon booking_metadata.heats[] ══════`);
const { sql } = await import("@/lib/db");
const q = sql();
let neonHeats: Array<{ racer?: string; bmiPersonId?: string | null; heatId?: string; category?: string }> = [];
try {
  const rows = (await q`
    SELECT id, product_kind, status, bmi_bill_id, booking_metadata
    FROM bowling_reservations WHERE bmi_bill_id = ${billId}
  `) as Array<Record<string, any>>;
  console.log(`  rows for bill ${billId}: ${rows.length}`);
  for (const r of rows) {
    const heats = (r.booking_metadata as any)?.heats;
    console.log(`    row #${r.id} kind=${r.product_kind} status=${r.status} heats=${Array.isArray(heats) ? heats.length : 0}`);
    if (Array.isArray(heats)) {
      for (const h of heats) {
        neonHeats.push(h);
        console.log(
          `      • racer="${h.racer ?? ""}" bmiPersonId=${h.bmiPersonId ?? "NULL"} cat=${h.category ?? ""} heatId=${h.heatId ?? ""}`,
        );
      }
    }
  }
} catch (e) {
  console.log(`  query failed: ${e instanceof Error ? e.message : e}`);
}

// ── 5. Neon kiosk_waiver_joins (the at-home /waiver signers) ────────────────
console.log(`\n══════ 5. Neon kiosk_waiver_joins for project ${projectId} ══════`);
let joins: Array<Record<string, any>> = [];
try {
  joins = (await q`
    SELECT person_id, display_name, first_name, last_name, bmi_attach_status,
           bmi_attach_error, kiosk_id, created_at, updated_at
    FROM kiosk_waiver_joins WHERE project_id = ${projectId} ORDER BY created_at
  `) as Array<Record<string, any>>;
  if (joins.length === 0) console.log("  (none — nobody signed through the booking's /waiver link)");
  for (const j of joins) {
    console.log(
      `    • personId=${j.person_id} "${j.display_name}" attach=${j.bmi_attach_status}` +
        `${j.bmi_attach_error ? ` err="${String(j.bmi_attach_error).slice(0, 80)}"` : ""} kiosk=${j.kiosk_id ?? "-"} ${j.created_at}`,
    );
  }
} catch (e) {
  console.log(`  query failed: ${e instanceof Error ? e.message : e}`);
}

// ── 6. Pandora waiver truth per distinct personId ───────────────────────────
console.log(`\n══════ 6. Pandora waiverExpiry (system of record for waivers) ══════`);
const allIds = [
  ...new Set(
    [
      ...personsList.map((p) => String(p.personId ?? p.id ?? "")),
      ...recordRacers.map((r) => r.personId ?? ""),
      ...neonHeats.map((h) => h.bmiPersonId ?? ""),
      ...joins.map((j) => String(j.person_id ?? "")),
    ].filter(Boolean),
  ),
];
const waiverBy = new Map<string, { valid: boolean; expiry: string | null; name: string }>();
const key = process.env.SWAGGER_ADMIN_KEY || "";
for (const id of allIds) {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${FASTTRAX_RACING_LOCATION_ID}/${id}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    const data = (await res.json().catch(() => null)) as any;
    const d = data?.data;
    const expiry = d?.waiverExpiry ?? null;
    const valid = expiry ? new Date(expiry).getTime() > Date.now() : false;
    const name = [d?.firstName, d?.lastName ?? d?.name].filter(Boolean).join(" ");
    waiverBy.set(id, { valid, expiry, name });
    console.log(`    • ${id} "${name}" waiverExpiry=${expiry ?? "none"} valid=${valid}`);
  } catch (e) {
    waiverBy.set(id, { valid: false, expiry: null, name: "" });
    console.log(`    • ${id} LOOKUP FAILED ${e instanceof Error ? e.message : e}`);
  }
}

// ── 7. REPLAY the current listBindableParty + prefill dedupe ────────────────
console.log(`\n══════ 7. REPLAY: what "Load your party" renders today ══════`);
const rows: Array<{ full: string; personId: string | null; src: string }> = [];
if (recordRacers.length > 0) {
  for (const r of recordRacers)
    rows.push({ full: (r.racerName ?? "").trim(), personId: r.personId ?? null, src: "record.racers" });
} else {
  for (const h of neonHeats)
    rows.push({ full: (h.racer ?? "").trim(), personId: h.bmiPersonId ?? null, src: "neon.heats" });
}
for (const j of joins) {
  const full = [j.first_name ?? "", j.last_name ?? ""].join(" ").trim() || String(j.display_name).trim();
  rows.push({ full, personId: j.person_id ? String(j.person_id) : null, src: "waiver_joins" });
}
for (const p of personsList) {
  const full = [p.firstName ?? "", p.name ?? ""].join(" ").trim();
  if (!full || /^(adult|junior)\s+\d+$/i.test(full)) continue;
  rows.push({ full, personId: String(p.personId ?? p.id ?? "") || null, src: "bmi.persons_list" });
}

const seen = new Set<string>();
const uniq = rows.filter((r) => {
  if (!r.full && !r.personId) return false;
  if (!r.personId && /^(adult|junior)\s+\d+$/i.test(r.full)) return false;
  const k = r.personId ?? `name:${r.full.toLowerCase()}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(`  listBindableParty would return ${uniq.length} member(s):`);
for (const r of uniq) {
  const w = r.personId ? (waiverBy.get(r.personId)?.valid ?? false) : false;
  console.log(`    • "${r.full}" id=${r.personId ?? "NULL"} waiverValid=${w}  [${r.src}]`);
}

// prefillPartyMembers: id-overlap then nameKey, FIRST WINS
const claimedIds = new Set<string>();
const claimedNames = new Set<string>();
const rendered: Array<{ full: string; id: string | null; waiver: boolean; src: string }> = [];
for (const r of uniq) {
  const parts = r.full.split(/\s+/).filter(Boolean);
  const first = (parts[0] || "Guest").toLowerCase();
  const last = parts.slice(1).join(" ").toLowerCase();
  const nameKey = `${first}|${last}`;
  if (r.personId && claimedIds.has(r.personId)) continue;
  if (claimedNames.has(nameKey)) {
    console.log(`    ⚠ SHADOWED: "${r.full}" id=${r.personId ?? "NULL"} [${r.src}] dropped — name already claimed`);
    continue;
  }
  if (r.personId) claimedIds.add(r.personId);
  claimedNames.add(nameKey);
  rendered.push({
    full: r.full,
    id: r.personId,
    waiver: r.personId ? (waiverBy.get(r.personId)?.valid ?? false) : false,
    src: r.src,
  });
}

console.log(`\n  ── KIOSK WOULD SHOW ${rendered.length} PERSON CARD(S) ──`);
let misrendered = 0;
for (const m of rendered) {
  const badge = m.id ? (m.waiver ? "Account & waiver ready" : "Waiver needed") : "Account + waiver needed";
  // Is this human actually known-good in BMI/Pandora under a DIFFERENT row?
  // Normalize exactly as the real nameKey does (split on /\s+/), or a
  // double-spaced booking label like "ROBERT  HENDRICKS" is missed here even
  // though the kiosk's own dedupe DOES collide it.
  const norm = (s: string) => s.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const bmiMatch = personsList.find(
    (p) => norm([p.firstName ?? "", p.name ?? ""].join(" ")) === norm(m.full),
  );
  const bmiId = bmiMatch ? String(bmiMatch.personId ?? bmiMatch.id ?? "") : "";
  const trulyOk = bmiId ? (waiverBy.get(bmiId)?.valid ?? false) : false;
  const wrong = !m.id && bmiId;
  if (wrong) misrendered++;
  console.log(
    `    ${wrong ? "✗" : "·"} "${m.full}" → "${badge}"  [${m.src}]` +
      (wrong ? `   ← BUT BMI HAS ${bmiId} waiverValid=${trulyOk}` : ""),
  );
}

console.log(`\n══════ VERDICT ══════`);
console.log(`  BMI persons_list          : ${personsList.length}`);
console.log(`  Neon waiver joins         : ${joins.length}  (attached=${joins.filter((j) => j.bmi_attach_status === "attached").length}, pending=${joins.filter((j) => j.bmi_attach_status === "pending").length}, failed=${joins.filter((j) => j.bmi_attach_status === "failed").length}, skipped=${joins.filter((j) => j.bmi_attach_status === "skipped").length})`);
console.log(`  Redis record racers       : ${recordRacers.length} (${recordRacers.filter((r) => !r.personId).length} with NULL personId)`);
console.log(`  Neon heats                : ${neonHeats.length} (${neonHeats.filter((h) => !h.bmiPersonId).length} with NULL bmiPersonId)`);
console.log(`  Cards kiosk renders       : ${rendered.length}`);
console.log(`  MIS-RENDERED (RC1 shadow) : ${misrendered}`);
if (misrendered > 0) {
  console.log(`  → RC1 CONFIRMED on ${W}: real BMI people rendered as "Account + waiver needed".`);
} else if (personsList.length === 0 && joins.length > 0) {
  console.log(`  → RC7 pattern on ${W}: signers exist in Neon but BMI has NOBODY. Attach never landed.`);
} else {
  console.log(`  → Neither signature matched cleanly — read the sections above.`);
}
process.exit(0);
