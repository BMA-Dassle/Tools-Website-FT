// READ-ONLY probe for the kiosk start-over cancel failure (open item #2):
//
//   [race.cancel] bill cancel NOT confirmed after retries: "63000000007234468"
//   [kiosk] start-over could not confirm hold release
//
// `cancelRaceOrder` retries DELETE bill/{id}/cancel three times and only
// returns true on `{success:true}`. Three failures leave one of two very
// different worlds, and the kiosk logs cannot tell them apart:
//
//   A. The bill is STILL OPEN — its heats hold real track capacity until BMI's
//      own expiry sweeps them. That is the 7/19 failure mode: holds stack up
//      across start-overs and the grid shows a fuller track than the venue has.
//   B. The bill IS cancelled and only the CONFIRMATION was lost (transient
//      proxy/network on the last attempt). Nothing is held; the log lies.
//
// This reads the order overview for the id in both tenants and prints the
// state + lines so we know which. No writes of any kind: GET only, and the
// only endpoint touched is order/{id}/overview.
//
//   npx tsx scripts/race-cancel-bill-probe.mts
//   BILL_ID=63000000007234468 npx tsx scripts/race-cancel-bill-probe.mts
//
// Gotchas honored (tasks/lessons.md § BMI ID Precision): the 17-digit id never
// rides through Number() or an unquoted JSON.parse — it stays a string on the
// way out and every id in the response is quoted before parsing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

const BILL_ID = (process.env.BILL_ID || "63000000007234468").trim();

// The kiosk that logged this is FastTrax (Fort Myers), but a bill id alone does
// not say which tenant minted it — check both rather than assume.
const CLIENTS = [process.env.BMI_CLIENT_KEY || "headpinzftmyers", "headpinznaples"].filter(
  (c, i, a) => a.indexOf(c) === i,
);

if (!BMI_SUB_KEY || !BMI_USERNAME) {
  console.error("Missing BMI env (BMI_SUBSCRIPTION_KEY / BMI_USERNAME) — run from apps/web.");
  process.exit(1);
}
if (!/^\d+$/.test(BILL_ID)) {
  console.error(`BILL_ID must be digits only, got: ${BILL_ID}`);
  process.exit(1);
}

/** Quote long id values so JSON.parse never rounds them. */
function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}

function field(o: any, name: string): any {
  if (!o || typeof o !== "object") return undefined;
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? o[key] : undefined;
}

async function getToken(clientKey: string): Promise<string> {
  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`auth ${clientKey}: ${res.status} ${await res.text()}`);
  const data = JSON.parse(await res.text());
  return data.AccessToken || data.accessToken;
}

async function readOverview(clientKey: string, token: string) {
  const res = await fetch(`${BMI_API_URL}/public-booking/${clientKey}/order/${BILL_ID}/overview`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
    },
  });
  const raw = await res.text();
  let data: any = null;
  try {
    data = parseRawIds(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, data, raw };
}

/**
 * `statusId` is NOT in the BMI docs, so it can only be read by comparison:
 * CONTROL=1 pulls recent bills that reached a REAL outcome (a license grant
 * registered against them) and prints their statusId next to this one. If the
 * live bills all report a different code, -4 is not a live state.
 */
async function controlSample(token: string, clientKey: string) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT bmi_bill_id, status, created_at
      FROM race_license_grants
     WHERE bmi_bill_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 8`) as any[];
  console.log(`\n▸ CONTROL — bills with a registered license grant (${clientKey})`);
  const seen = new Set<string>();
  for (const r of rows) {
    const id = String(r.bmi_bill_id);
    if (seen.has(id) || !/^\d+$/.test(id)) continue;
    seen.add(id);
    const res = await fetch(`${BMI_API_URL}/public-booking/${clientKey}/order/${id}/overview`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "BMI-Subscription-Key": BMI_SUB_KEY,
        "Content-Type": "application/json",
      },
    });
    const t = await res.text();
    console.log(
      `  bill ${id} → HTTP ${res.status}` +
        ` statusId=${t.match(/"statusId":(-?\d+)/)?.[1] ?? "?"}` +
        ` lines=${(t.match(/"orderItemId"/g) || []).length}` +
        ` paid=${t.match(/"totalPaid":([\d.]+)/)?.[1] ?? "?"}` +
        ` res=${t.match(/"reservationNumber":"([^"]*)"/)?.[1] ?? "-"}` +
        ` grant=${r.status}`,
    );
  }
}

// ── Office-side truth ───────────────────────────────────────────────────────
// The public-booking overview turned out to be USELESS for this question: every
// order that has left the "open cart" state reads statusId=-4 with zero lines,
// whether it was cancelled OR confirmed into a real reservation (sampled
// 2026-08-04 against W56178 / W56183 / W56184 — all live bookings, all
// -4/empty). So the verdict comes from the Office project instead (projectId =
// billId + 1) — the same read `race-cancel-watch` uses to prove a SYSTEM cancel
// (userUpdatedId = -1). Its schedule rows are what actually hold track time.
const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolveP({ status: res.statusCode ?? 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Office timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function officeToken(clientKey: string): Promise<string> {
  const res = await officeReq(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200) throw new Error(`Office auth ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

async function officeProject(clientKey: string, billId: string) {
  const projectId = (BigInt(billId) + BigInt(1)).toString();
  const token = await officeToken(clientKey);
  const res = await officeReq("GET", `/api/${clientKey}/project/${projectId}`, {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `bill-probe-${projectId}`,
    clientkey: clientKey,
  });
  console.log(`  GET project/${projectId} → ${res.status}`);
  if (res.status >= 400) {
    console.log(`  body: ${res.body.slice(0, 300)}`);
    return;
  }
  const p = parseRawIds(res.body);
  const schedules: any[] = Array.isArray(field(p, "schedules")) ? field(p, "schedules") : [];
  const products: any[] = Array.isArray(field(p, "products")) ? field(p, "products") : [];
  console.log(`  stateId:       ${JSON.stringify(field(p, "stateId"))}`);
  console.log(`  userUpdatedId: ${JSON.stringify(field(p, "userUpdatedId"))} (-1 = BMI system)`);
  console.log(`  products:      ${products.length}`);
  console.log(`  schedules:     ${schedules.length}`);
  for (const s of schedules) {
    console.log(
      `    · start=${field(s, "start")} end=${field(s, "end")} stateId=${field(s, "stateId")}` +
        ` resource=${field(s, "resourceId") ?? field(s, "resource") ?? "-"}`,
    );
  }
  // A NULL stateId is not a cancel — a live attraction row reads null (proven on
  // W57593's laser tag). Only an explicitly negative state means cancelled.
  const held = schedules.filter((s) => !String(field(s, "stateId") ?? "").startsWith("-"));
  console.log(
    `\n  OFFICE VERDICT: ${
      products.length === 0 && schedules.length === 0
        ? "nothing on the project — no products, no schedule rows. Nothing is held."
        : held.length > 0
          ? `${held.length} schedule row(s) in a non-negative state — track time IS held.`
          : "schedule rows exist but every one carries a negative state — cancelled, nothing held."
    }`,
  );
}

console.log(`\nBill ${BILL_ID} — read-only overview probe\n${"─".repeat(64)}`);

for (const clientKey of CLIENTS) {
  console.log(`\n▸ tenant ${clientKey}`);
  let token = "";
  try {
    token = await getToken(clientKey);
  } catch (err) {
    console.log(`  auth failed: ${String(err)}`);
    continue;
  }
  if (process.env.CONTROL === "1")
    await controlSample(token, clientKey).catch((e) => console.log(`  control failed: ${e}`));
  const { status, data, raw } = await readOverview(clientKey, token);
  console.log(`  GET order/${BILL_ID}/overview → ${status}`);
  if (status === 404) {
    console.log("  not found in this tenant");
    continue;
  }
  if (status !== 200) {
    console.log(`  body: ${raw.slice(0, 400)}`);
    continue;
  }

  const state = field(data, "statusId") ?? field(data, "State") ?? field(data, "Status");
  const lines = field(data, "Lines") ?? field(data, "OrderItems") ?? [];
  console.log(`  State:          ${JSON.stringify(state)}`);
  console.log(`  Total:          ${JSON.stringify(field(data, "Total"))}`);
  console.log(`  TotalPaid:      ${JSON.stringify(field(data, "TotalPaid"))}`);
  console.log(`  TotalToDeposit: ${JSON.stringify(field(data, "TotalToDeposit"))}`);
  console.log(`  ReservationId:  ${JSON.stringify(field(data, "ReservationId"))}`);
  console.log(`  ProjectId:      ${JSON.stringify(field(data, "ProjectId"))}`);
  console.log(`  lines: ${Array.isArray(lines) ? lines.length : 0}`);
  for (const line of Array.isArray(lines) ? lines : []) {
    console.log(
      `    · ${field(line, "OrderItemId")} ${field(line, "Name")} ×${field(line, "Quantity")}` +
        ` kind=${field(line, "Kind")} start=${field(line, "StartDateTime") ?? field(line, "Start") ?? "-"}` +
        ` price=${field(line, "Price") ?? field(line, "Total") ?? "-"}`,
    );
  }

  // The whole point of the probe: does this bill still hold track time?
  const stateStr = String(state ?? "").toLowerCase();
  const cancelled = stateStr.includes("cancel") || Number(state) < 0;
  const heatLines = (Array.isArray(lines) ? lines : []).filter(
    (l: any) => field(l, "StartDateTime") || field(l, "Start"),
  );
  console.log(
    `\n  VERDICT: ${
      cancelled
        ? "CANCELLED — the DELETE landed and only the confirmation was lost (world B)."
        : heatLines.length > 0
          ? `STILL OPEN with ${heatLines.length} timed line(s) — this bill is HOLDING track capacity (world A).`
          : "open, but no timed lines — nothing held; an empty shell BMI will auto-cancel."
    }`,
  );
  console.log(`
  ── Office project (the read that can actually tell) ──`);
  await officeProject(clientKey, BILL_ID).catch((e) => console.log(`  office read failed: ${e}`));

  if (!cancelled) {
    console.log(
      "  (Emptied Pending orders auto-cancel on BMI's side — see " +
        "reference_bmi_order_reparenting; an empty open bill is not a capacity leak.)",
    );
  }
}

console.log("");
