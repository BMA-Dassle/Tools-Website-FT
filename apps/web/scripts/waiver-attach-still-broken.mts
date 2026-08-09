/**
 * READ-ONLY: is the group-function waiver-attach defect still live, and what is
 * still exposed to it? NO WRITES.
 *
 * Three questions:
 *   1. Are NEW failures still landing since the H3194 investigation?
 *   2. How much stale state is sitting in Neon (rows that say 'failed' while BMI
 *      actually has the person — the inverted-poison class)?
 *   3. What is coming UP that will hit this: group functions with waiver-required
 *      activities whose guests have not signed yet.
 *
 * Run from apps/web:  npx tsx scripts/waiver-attach-still-broken.mts
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

const nowEt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "full",
  timeStyle: "medium",
}).format(new Date());
console.log(`══════ NOW: ${nowEt} ET ══════`);

const { sql } = await import("@/lib/db");
const q = sql();

// ── 1. New activity since the investigation ────────────────────────────────
console.log("\n══════ 1. joins since 2026-08-08 18:30 ET (post-investigation) ══════");
const since = (await q`
  SELECT project_id, length(project_id) AS id_len, bmi_attach_status, count(*)::int AS n,
         to_char(min(created_at) AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS first_et,
         to_char(max(created_at) AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS last_et
  FROM kiosk_waiver_joins
  WHERE created_at > '2026-08-08 22:30:00+00'
  GROUP BY 1, 2, 3 ORDER BY last_et DESC
`) as Array<Record<string, any>>;
if (!since.length) console.log("  (no new join rows at all since then)");
for (const r of since)
  console.log(
    `  project=${r.project_id} (${r.id_len}d) ${r.bmi_attach_status}: ${r.n}  ${r.first_et} → ${r.last_et} ET`,
  );

console.log("\n══════ 2. lifetime attach outcome by project-id length ══════");
const byLen = (await q`
  SELECT length(project_id) AS id_len, bmi_attach_status, count(*)::int AS n,
         count(DISTINCT project_id)::int AS projects
  FROM kiosk_waiver_joins GROUP BY 1, 2 ORDER BY 1, 3 DESC
`) as Array<Record<string, any>>;
for (const r of byLen)
  console.log(`  ${r.id_len}-digit projectId · ${r.bmi_attach_status}: ${r.n} rows / ${r.projects} project(s)`);

const failedProjects = (await q`
  SELECT project_id, location_id, count(*)::int AS n,
         to_char(max(created_at) AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS last_et
  FROM kiosk_waiver_joins WHERE bmi_attach_status = 'failed'
  GROUP BY 1, 2 ORDER BY n DESC
`) as Array<Record<string, any>>;
console.log(`\n  projects with failed rows: ${failedProjects.length}`);
for (const r of failedProjects)
  console.log(`    project=${r.project_id} loc=${r.location_id} n=${r.n} last=${r.last_et} ET`);

// ── 3. Reconcile each failed project against BMI's LIVE projectPersons ─────
const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";
const tokens = new Map<string, string>();
async function officeToken(clientKey: string): Promise<string> {
  if (tokens.has(clientKey)) return tokens.get(clientKey)!;
  const password = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
  const res = await fetch(`https://${OFFICE_HOST}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
      origin: "https://office.bmileisure.com",
      referer: "https://office.bmileisure.com/",
    },
    body: `grant_type=password&username=${encodeURIComponent(process.env.BMI_OFFICE_USERNAME || "API2")}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`office auth ${res.status} ${clientKey}`);
  const t = JSON.parse(await res.text()).access_token;
  tokens.set(clientKey, t);
  return t;
}
function officeGet(clientKey: string, tok: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: OFFICE_HOST,
        path,
        headers: {
          Authorization: `Bearer ${tok}`,
          "x-fast-version": SMS_VERSION,
          clientkey: clientKey,
          "x-session-id": randomUUID(),
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
  });
}
const { clientKeyForLocation } = await import("~/features/daily-events/service");

console.log("\n══════ 3. STALE STATE: rows that say 'failed' but BMI actually has ══════");
let staleTotal = 0;
let genuineTotal = 0;
for (const fp of failedProjects) {
  const ck = clientKeyForLocation(fp.location_id) || "headpinzftmyers";
  const tok = await officeToken(ck);
  const res = await officeGet(ck, tok, `/api/${ck}/project/${fp.project_id}`);
  if (res.status >= 400) {
    console.log(`  project=${fp.project_id}: project GET HTTP ${res.status} — cannot reconcile`);
    continue;
  }
  const proj = parseWithRawIds<any>(res.body);
  const onBmi = new Set(((proj.projectPersons ?? []) as any[]).map((p) => String(p.personId)));
  const rows = (await q.query(
    `SELECT person_id, display_name FROM kiosk_waiver_joins
     WHERE project_id = $1 AND bmi_attach_status = 'failed' ORDER BY created_at`,
    [String(fp.project_id)],
  )) as Array<Record<string, any>>;
  const stale = rows.filter((r) => onBmi.has(String(r.person_id)));
  const genuine = rows.filter((r) => !onBmi.has(String(r.person_id)));
  staleTotal += stale.length;
  genuineTotal += genuine.length;
  console.log(
    `  project=${fp.project_id} "${proj.name}" ${proj.number ?? ""} — ${rows.length} failed rows:` +
      ` ${stale.length} STALE (BMI has them), ${genuine.length} genuinely absent`,
  );
  for (const g of genuine) console.log(`      still absent: ${g.person_id} "${g.display_name}"`);
}
console.log(`\n  TOTAL: ${staleTotal} stale-failed rows, ${genuineTotal} genuinely absent`);
console.log(
  `  → the backfill route would re-POST all ${staleTotal + genuineTotal} of these,\n` +
    `    because its candidate query trusts bmi_attach_status and never reads BMI.`,
);

// ── 4. Forward exposure ────────────────────────────────────────────────────
console.log("\n══════ 4. FORWARD EXPOSURE: upcoming group functions ══════");
const upcoming = (await q`
  SELECT id, bmi_reservation_id, length(bmi_reservation_id) AS id_len, event_number, event_name,
         event_date_display, status, center_code, line_items
  FROM group_function_quotes
  WHERE event_date >= now() AND status IN ('deposit_paid','balance_charged','balance_link_sent','completed')
  ORDER BY event_date ASC LIMIT 40
`) as Array<Record<string, any>>;
const { hasWaiverRequiredActivities } = await import("@/lib/bmi-office-actions");
let exposed = 0;
for (const g of upcoming) {
  const items = (g.line_items || []) as Array<{ name: string }>;
  const needsWaiver = hasWaiverRequiredActivities(items);
  if (!needsWaiver) continue;
  exposed++;
  console.log(
    `  ${g.event_number} "${g.event_name}" ${g.event_date_display} [${g.status}] ${g.center_code}` +
      `  project=${g.bmi_reservation_id} (${g.id_len} digits)`,
  );
}
console.log(
  `\n  ${exposed} upcoming waiver-required group function(s) of ${upcoming.length} scanned.` +
    `\n  Every one has a SHORT project id, so every guest who signs through its waiver` +
    `\n  link will fail to attach — same defect, until the derivation is fixed.`,
);
process.exit(0);
