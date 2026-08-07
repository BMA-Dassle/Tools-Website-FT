/**
 * READ-ONLY blast-radius sweep for the W58352 race-credit guard collision.
 *
 * The Redis NX guard key was `{billId}:{heatRef}:{kind}` with no personId, and
 * every racer in a party shares ONE heatId — so a party's redemptions for a heat
 * collapsed into one key: racer #1 paid a credit, everyone else raced free.
 *
 * This sweep takes every live `race-credit-redeemed:*` guard key (7-day TTL),
 * groups by bill, resolves bill -> Office project (+1 on the id), and pulls each
 * project person's deposit history. A booking is FLAGGED when every credit
 * deduction in the booking window landed on ONE person while other persons on
 * the same reservation held a redeemable credit balance.
 *
 * NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/race-credit-guard-collision-sweep.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
const envPath = path.resolve(import.meta.dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import https from "node:https";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { parseWithRawIds } from "@ft/db";
/* eslint-disable @typescript-eslint/no-explicit-any */

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";

/** The four redeemable race-credit kinds (RACE_CREDIT_TYPES). */
const CREDIT_KINDS = new Set(["12754483", "12744867", "12744871", "11260967"]);

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
const headers = {
  Authorization: `Bearer ${token}`,
  "x-fast-version": SMS_VERSION,
  clientkey: CLIENT_KEY,
};

function officeGet(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: OFFICE_HOST, path: p, headers: { ...headers, "x-session-id": randomUUID() } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(25_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** Office project id = bill id + 1 (arithmetic on the last 10 digits only —
 *  NEVER Number() the whole 17-digit id). */
function projectIdFromBillId(billId: string): string {
  const head = billId.slice(0, -10);
  const tail = String(Number(billId.slice(-10)) + 1).padStart(10, "0");
  return head + tail;
}

// ── 1. Guard keys from Redis ────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL!, {
  tls: process.env.REDIS_URL!.startsWith("rediss") ? {} : undefined,
});
const keys: string[] = [];
let cursor = "0";
do {
  const [next, batch] = await redis.scan(cursor, "MATCH", "race-credit-redeemed:*", "COUNT", 1000);
  cursor = next;
  keys.push(...batch);
} while (cursor !== "0");
redis.disconnect();

const byBill = new Map<string, Set<string>>();
for (const k of keys) {
  // race-credit-redeemed:{billId}:{ref}:{kind}  — ref may itself contain ':'
  const rest = k.slice("race-credit-redeemed:".length);
  const billId = rest.slice(0, rest.indexOf(":"));
  byBill.set(billId, (byBill.get(billId) ?? new Set()).add(rest.slice(billId.length + 1)));
}
console.log(`${keys.length} guard keys across ${byBill.size} bills (last 7 days)\n`);

// ── 2. Per bill: project persons + their deposit history ────────────────────
async function depositHistory(personId: string): Promise<any[]> {
  const res = await officeGet(
    `/api/${CLIENT_KEY}/deposit/history?personId=${personId}&from=2026-07-25T00:00:00&until=2026-08-08T23:59:59`,
  );
  if (res.status >= 400) return [];
  const rows = parseWithRawIds<any[]>(res.body);
  return Array.isArray(rows) ? rows : [];
}

interface Finding {
  billId: string;
  w: string;
  created: string;
  heats: number;
  persons: number;
  deductedBy: Map<string, number>;
  eligibleOthers: string[];
  missing: number;
}
const findings: Finding[] = [];
const bills = [...byBill.keys()];
let done = 0;

async function examine(billId: string) {
  const heatRefs = byBill.get(billId)!;
  const projectId = projectIdFromBillId(billId);
  const pr = await officeGet(`/api/${CLIENT_KEY}/project/${projectId}`);
  if (pr.status >= 400) return;
  const project = parseWithRawIds<any>(pr.body);
  const created: string = project?.created ?? "";
  const w: string = project?.number ?? "?";
  const persons: string[] = (project?.projectPersons ?? [])
    .map((p: any) => String(p.personId))
    .filter((id: string) => /^\d{5,}$/.test(id));
  if (persons.length < 2) return; // solo racer can't collide

  // Booking window: project.created .. +10 min
  const t0 = new Date(created).getTime();
  const t1 = t0 + 10 * 60_000;

  const deductedBy = new Map<string, number>();
  const eligibleOthers: string[] = [];
  for (const pid of persons) {
    const hist = await depositHistory(pid);
    let deducts = 0;
    let hadCredits = false;
    for (const row of hist) {
      if (!CREDIT_KINDS.has(String(row.depositKindId))) continue;
      for (const e of row.history ?? []) {
        const t = new Date(e.created).getTime();
        if (!Number.isFinite(t)) continue;
        if (Number(e.amount) < 0 && t >= t0 && t <= t1) deducts += Math.abs(Number(e.amount));
        // Did they hold/receive credits of a redeemable kind around booking time?
        if (Number(e.amount) > 0 && t <= t1) hadCredits = true;
      }
      if (Number(row.balance) > 0) hadCredits = true;
    }
    if (deducts > 0) deductedBy.set(pid, deducts);
    else if (hadCredits) eligibleOthers.push(pid);
  }

  // FINGERPRINT: deductions landed on exactly one person, and >=1 other person
  // on the same reservation held redeemable credits that were never drawn.
  if (deductedBy.size === 1 && eligibleOthers.length > 0) {
    findings.push({
      billId,
      w,
      created,
      heats: heatRefs.size,
      persons: persons.length,
      deductedBy,
      eligibleOthers,
      missing: heatRefs.size * eligibleOthers.length,
    });
  }
}

const CONCURRENCY = 6;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const billId = bills.pop();
      if (!billId) return;
      try {
        await examine(billId);
      } catch (err) {
        console.log(`  ! ${billId}: ${(err as Error).message}`);
      }
      if (++done % 25 === 0) console.log(`  …${done}/${byBill.size} bills examined`);
    }
  }),
);

// ── 3. Report ───────────────────────────────────────────────────────────────
findings.sort((a, b) => b.missing - a.missing);
console.log(`\n${"═".repeat(78)}`);
console.log(`FLAGGED: ${findings.length} reservation(s) with the collision fingerprint`);
console.log(`${"═".repeat(78)}`);
let totalMissing = 0;
for (const f of findings) {
  totalMissing += f.missing;
  const [[who, n]] = [...f.deductedBy];
  console.log(
    `\n  ${f.w}  bill ${f.billId}  ${f.created}\n` +
      `    heats=${f.heats}  persons=${f.persons}\n` +
      `    deducted: person ${who} × ${n}\n` +
      `    NOT deducted (held credits): ${f.eligibleOthers.join(", ")}\n` +
      `    credits that should have come off: ~${f.missing}`,
  );
}
console.log(`\n${"═".repeat(78)}`);
console.log(`Estimated un-deducted race credits: ~${totalMissing}`);
console.log("done (read-only — no writes performed)");
