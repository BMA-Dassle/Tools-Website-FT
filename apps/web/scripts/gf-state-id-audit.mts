/**
 * READ-ONLY audit: what BMI workspace states exist, what our code expects, and
 * where three specific projects actually sit.
 *
 * Answers "why did the Send Contract scan find nothing?" — either the state id
 * moved, or the projects fall outside the scan's date/resource window.
 *
 * Usage (from apps/web): npx tsx scripts/gf-state-id-audit.mts
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

const CENTERS = [
  { clientKey: "headpinzftmyers", sendContract: "49130082", pendingSigned: "48952154" },
  { clientKey: "headpinznaples", sendContract: "8020645", pendingSigned: "8007473" },
];

const NEEDLES = ["tanglewood", "jw", "sanibel"];
const NUMBERS = ["H2561", "3457", "3455", "2561"];

async function office(method: string, path: string, headers: Record<string, string>, body?: string) {
  const res = await fetch(`https://${OFFICE_HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

async function token(clientKey: string) {
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
  if (res.status !== 200) throw new Error(`Auth ${res.status}`);
  return JSON.parse(res.body).access_token;
}

for (const c of CENTERS) {
  console.log(`\n${"=".repeat(78)}\n=== ${c.clientKey} ===\n${"=".repeat(78)}`);
  const tk = await token(c.clientKey);
  const headers = {
    Authorization: `Bearer ${tk}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `audit-${Date.now()}`,
    clientkey: c.clientKey,
  };

  const metaRes = await office("GET", `/api/${c.clientKey}/metadata`, headers);
  const meta = JSON.parse(metaRes.body);
  console.log(`metadata top-level keys: ${Object.keys(meta).join(", ")}`);

  // Hunt for anything that looks like a state catalog
  for (const key of Object.keys(meta)) {
    const v = (meta as any)[key];
    if (!Array.isArray(v) || !v.length) continue;
    const sample = v[0];
    if (sample && typeof sample === "object" && "id" in sample && ("name" in sample || "description" in sample)) {
      if (/state|status/i.test(key)) {
        console.log(`\n--- meta.${key} (${v.length}) ---`);
        for (const s of v) console.log(`   ${String(s.id).padEnd(12)} ${s.name ?? s.description ?? ""}`);
      }
    }
  }

  // Some BMI deployments expose states on a dedicated endpoint
  for (const p of [
    `/api/${c.clientKey}/projectStates`,
    `/api/${c.clientKey}/states`,
    `/api/${c.clientKey}/workspaces`,
  ]) {
    const r = await office("GET", p, headers);
    if (r.status < 400) {
      console.log(`\n--- ${p} (${r.status}) ---`);
      console.log(r.body.slice(0, 3000));
    } else {
      console.log(`   ${p} → ${r.status}`);
    }
  }

  const ids = new Set<string>();
  for (const r of meta.resources || []) ids.add(String(r.id));
  for (const g of meta.resourceGroups || []) for (const r of g.resources || []) ids.add(String(r.id));
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");

  // Widen the window: 60 days BACK through 400 days forward, so nothing is
  // missed because of the cron's from=today start.
  const all: any[] = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 60);
  for (let i = 0; i < 16; i++) {
    const from = cursor.toISOString().slice(0, 10);
    cursor.setDate(cursor.getDate() + 30);
    const till = cursor.toISOString().slice(0, 10);
    const dp = await office(
      "GET",
      `/api/${c.clientKey}/dayPlanner?${resourceParam}&from=${from}&till=${till}&showAll=true`,
      headers,
    );
    if (dp.status >= 400) {
      console.log(`   window ${from}→${till} FAILED ${dp.status}`);
      continue;
    }
    all.push(...((JSON.parse(dp.body).reservations?.projects || []) as any[]));
  }
  const seen = new Set<string>();
  const projects = all.filter((p) => {
    if (seen.has(String(p.id))) return false;
    seen.add(String(p.id));
    return true;
  });

  const byState = new Map<string, { n: number; sample: string[] }>();
  for (const p of projects) {
    const k = String(p.stateId);
    const e = byState.get(k) || { n: 0, sample: [] };
    e.n++;
    if (e.sample.length < 3) e.sample.push(`${p.number || "?"} ${p.name}`);
    byState.set(k, e);
  }
  console.log(`\n--- stateId histogram (${projects.length} projects, -60d..+420d) ---`);
  for (const [k, v] of [...byState.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const tag =
      k === c.sendContract
        ? "  <<< code thinks this is SEND CONTRACT"
        : k === c.pendingSigned
          ? "  <<< code thinks this is PENDING SIGNED"
          : "";
    console.log(`   ${k.padEnd(12)} n=${String(v.n).padEnd(4)} e.g. ${v.sample.join(" | ")}${tag}`);
  }

  console.log(`\n--- target projects ---`);
  for (const p of projects) {
    const hay = `${p.name || ""} ${p.displayName || ""}`.toLowerCase();
    const num = String(p.number || "");
    const hitName = NEEDLES.some((n) => hay.includes(n));
    const hitNum = NUMBERS.includes(num) || NUMBERS.includes(num.replace(/^H/i, ""));
    if (hitName || hitNum) {
      console.log(
        `   id=${p.id} number=${num} state=${p.stateId} kind=${p.kindId} date=${p.date} name="${p.name}" persons=${p.persons}`,
      );
    }
  }
}

process.exit(0);
