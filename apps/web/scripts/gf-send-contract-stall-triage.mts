/**
 * READ-ONLY triage for "stuck in Send Contract" group-function quotes.
 *
 * Mirrors exactly what the every-minute /api/cron/group-quote-dispatch does:
 *   1. dayPlanner scan per center for projects in the Send Contract state
 *   2. Pandora /v2/bmi/reservation detail fetch (null => bmi-scan SKIPS the project)
 *   3. collectContractIssues() data-quality gate (blocking => dispatch HARD-BLOCKS)
 *   4. the DB row's status / contract_sent_at / debounce timestamp
 *
 * No writes, no BMI state changes, no emails. Usage (from apps/web):
 *   npx tsx scripts/gf-send-contract-stall-triage.mts
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS = Buffer.from(
  process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv",
  "base64",
).toString();
const SMS_VERSION = "6251006 202511051229";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

const CENTERS = [
  {
    clientKey: "headpinzftmyers",
    centerCode: "fort-myers",
    hermesCenter: "10.48.0.14",
    sendContractStateId: "49130082",
    pendingSignedContractStateId: "48952154",
    pandoraHP: "TXBSQN0FEKQ11",
    pandoraFT: "LAB52GY480CJF",
  },
  {
    clientKey: "headpinznaples",
    centerCode: "naples",
    hermesCenter: "10.40.0.43",
    sendContractStateId: "8020645",
    pendingSignedContractStateId: "8007473",
    pandoraHP: "PPTR5G2N0QXF7",
    pandoraFT: "PPTR5G2N0QXF7",
  },
];

async function office(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`https://${OFFICE_HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

async function token(clientKey: string): Promise<string> {
  const res = await office(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`,
  );
  if (res.status !== 200) throw new Error(`Auth failed ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

/** Raw Pandora probe — returns the HTTP status too, which bmi-scan throws away. */
async function pandora(locationID: string, reservationId: string) {
  const res = await fetch(
    `${PANDORA_BASE}/v2/bmi/reservation/${encodeURIComponent(locationID)}/${encodeURIComponent(reservationId)}`,
    {
      headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, ok: res.ok, success: parsed?.success, data: parsed?.data ?? null, raw: text.slice(0, 400) };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function issuesFor(item: any, centerCode: string): Array<{ message: string; blocking: boolean }> {
  const out: Array<{ message: string; blocking: boolean }> = [];
  const email = (item?.customer?.email || "").trim();
  if (!email) out.push({ message: "Guest email is missing", blocking: true });
  else if (!EMAIL_RE.test(email))
    out.push({ message: `Guest email looks invalid: ${email}`, blocking: true });
  const first = (item?.customer?.first || "").trim();
  const last = (item?.customer?.last || "").trim();
  if (!first || !last) out.push({ message: "Guest name is incomplete (first/last)", blocking: true });
  const phone = (item?.customer?.phone || "").replace(/\D/g, "");
  if (phone.length < 10)
    out.push({ message: "Guest phone is missing or invalid", blocking: true });
  if (!(item?.planner?.email || "").trim())
    out.push({ message: "Planner email is not set", blocking: false });
  if (
    (centerCode === "fort-myers" || centerCode === "fasttrax") &&
    !(item?.location || "").trim()
  )
    out.push({ message: "Location selector not set in BMI", blocking: true });
  return out;
}

function windows(months: number) {
  const out: Array<{ from: string; till: string }> = [];
  const cursor = new Date();
  for (let i = 0; i < months; i++) {
    const from = cursor.toISOString().slice(0, 10);
    cursor.setDate(cursor.getDate() + 30);
    out.push({ from, till: cursor.toISOString().slice(0, 10) });
  }
  return out;
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);

console.log(`\n=== Send Contract stall triage · ${new Date().toISOString()} ===\n`);

for (const c of CENTERS) {
  let tk: string;
  try {
    tk = await token(c.clientKey);
  } catch (err) {
    console.log(`[${c.clientKey}] AUTH FAILED: ${(err as Error).message}`);
    continue;
  }
  const headers = {
    Authorization: `Bearer ${tk}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `triage-${Date.now()}`,
    clientkey: c.clientKey,
  };

  const metaRes = await office("GET", `/api/${c.clientKey}/metadata`, headers);
  if (metaRes.status >= 400) {
    console.log(`[${c.clientKey}] metadata ${metaRes.status} — scan would ABORT this center`);
    continue;
  }
  const meta = JSON.parse(metaRes.body);
  const ids = new Set<string>();
  for (const r of meta.resources || []) ids.add(String(r.id));
  for (const g of meta.resourceGroups || []) for (const r of g.resources || []) ids.add(String(r.id));
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");

  const all: any[] = [];
  const failedWindows: string[] = [];
  for (const w of windows(12)) {
    const dp = await office(
      "GET",
      `/api/${c.clientKey}/dayPlanner?${resourceParam}&from=${w.from}&till=${w.till}&showAll=true`,
      headers,
    );
    if (dp.status >= 400) {
      failedWindows.push(`${w.from}→${w.till} (${dp.status})`);
      continue;
    }
    try {
      all.push(...((JSON.parse(dp.body).reservations?.projects || []) as any[]));
    } catch {
      failedWindows.push(`${w.from}→${w.till} (unparseable)`);
    }
  }

  const seen = new Set<string>();
  const projects = all.filter((p) => {
    if (String(p.kindId) === "-10") return false;
    if (seen.has(String(p.id))) return false;
    seen.add(String(p.id));
    return true;
  });
  const stuck = projects.filter((p) => String(p.stateId) === c.sendContractStateId);

  console.log(
    `[${c.clientKey}] ${projects.length} projects scanned, ${stuck.length} in Send Contract (${c.sendContractStateId})` +
      (failedWindows.length ? `  ⚠ FAILED WINDOWS: ${failedWindows.join(", ")}` : ""),
  );

  for (const p of stuck) {
    const projId = String(p.id);
    console.log(`\n  ── project ${projId} · ${p.number || "(no #)"} · ${p.name} · ${p.date}`);

    // bmi-scan's step 2 — the silent skip point
    const pd = await pandora(c.pandoraHP, projId);
    if (!pd.ok || !pd.success || !pd.data) {
      console.log(
        `     ❌ PANDORA FAIL (HP loc) http=${pd.status} success=${pd.success} → bmi-scan SKIPS this project every pass`,
      );
      console.log(`        raw: ${pd.raw}`);
      const ft = await pandora(c.pandoraFT, projId);
      console.log(`        FT-loc retry: http=${ft.status} success=${ft.success} data=${!!ft.data}`);
    } else {
      const d = pd.data;
      console.log(
        `     ✅ pandora ok · location="${d.location || "(BLANK)"}" · products=${(d.products || []).length}` +
          ` · guest="${d.customer?.first || ""} ${d.customer?.last || ""}" <${d.customer?.email || "—"}> ${d.customer?.phone || "—"}` +
          ` · planner=${d.planner?.email || "(unset)"}`,
      );
      const centerCodeForGate = (d.location || "").toLowerCase().includes("fasttrax")
        ? "fasttrax"
        : c.centerCode;
      const iss = issuesFor(d, centerCodeForGate);
      const blocking = iss.filter((i) => i.blocking);
      if (blocking.length)
        console.log(`     ⛔ BLOCKING data issues: ${blocking.map((i) => i.message).join("; ")}`);
      if (iss.some((i) => !i.blocking))
        console.log(
          `     ⚠ warnings: ${iss.filter((i) => !i.blocking).map((i) => i.message).join("; ")}`,
        );
      if (!iss.length) console.log(`     ✅ data gate clean`);
    }

    const rows = (await sql`
      SELECT id, event_number, event_name, status, contract_short_id,
             contract_sent_at, deposit_paid_at, total_cents, collected_cents,
             hermes_last_processed_at, updated_at,
             NOW() - hermes_last_processed_at AS since_processed
      FROM group_function_quotes
      WHERE bmi_reservation_id = ${projId}
    `) as any[];
    if (!rows.length) console.log(`     DB: no quote row (never dispatched)`);
    for (const r of rows)
      console.log(
        `     DB: id=${r.id} ${r.event_number} status=${r.status} shortId=${r.contract_short_id || "—"}` +
          ` sent=${r.contract_sent_at || "never"} depositPaid=${r.deposit_paid_at || "no"}` +
          ` total=${r.total_cents} collected=${r.collected_cents}` +
          ` lastProcessed=${r.hermes_last_processed_at || "never"} (${r.since_processed || "—"} ago)`,
      );
  }
}

process.exit(0);
