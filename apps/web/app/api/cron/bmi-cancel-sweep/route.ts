import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { parseWithRawIds } from "@ft/db";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/bmi-cancel-sweep
 *
 * BMI_AUTOCANCEL_WORKAROUND — remove when BMI fixes payment/confirm.
 *
 * BMI's payment/confirm auto-cancels paid online reservations (sets
 * stateId=-4, userUpdatedId=-1) "a bit later" despite a successful payment.
 * This safety-net cron scans the BMI Office dayplanner for those cancellations
 * and recovers them by setting stateId back to -3 (Confirmation) via Pandora.
 *
 * Runs every 5 minutes. Recovery (-3 on an already-confirmed project) is a no-op.
 *
 * RECOVERY GATE (hybrid — recover iff one holds, AND not intentionally cancelled):
 *   (A) the project's reservation number matches one of OUR booking records
 *       (bookingrecord:res:{number}) whose status === "confirmed"; OR
 *   (B) userUpdatedId === "-1"  (BMI's auto-cancel signature — our own/staff
 *       cancels go through the Office API as user "API2", a different id)
 *       AND the project has >= 1 payment record.
 * A booking-record explicitly marked cancelled/refunded is never recovered.
 *
 * ?dryRun=1 — inspect only: reports what WOULD be recovered/skipped, no writes.
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/**
 * Both BMI instances. clientKey = Office API tenant; pandoraLocation = the
 * location id Pandora's /reservation/state expects for that tenant.
 * (Source: PANDORA_LOCATION_IDS / CLIENT_KEYS in lib/bmi-office-actions.ts.
 * ftmyers racing recovers via the fasttrax location, matching prior behavior.)
 */
const CENTERS = [
  { clientKey: "headpinzftmyers", pandoraLocation: "LAB52GY480CJF" },
  { clientKey: "headpinznaples", pandoraLocation: "PPTR5G2N0QXF7" },
] as const;

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: OFFICE_HOST,
      path,
      method,
      headers: { ...headers, "Content-Type": "application/json" },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function getOfficeToken(clientKey: string): Promise<string> {
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
  if (res.status !== 200) throw new Error(`Office auth failed (${clientKey}): ${res.status}`);
  return JSON.parse(res.body).access_token;
}

interface DpProject {
  id: string;
  number: string;
  name: string | null;
  displayName: string | null;
  stateId: string;
  kindId: string;
  personId: string;
  date: string;
  persons: number;
}

interface BookingRecord {
  status?: string;
  cancelledAt?: string;
  refundedAt?: string;
}

/**
 * Look up our authoritative booking record for a BMI reservation number.
 * bookingrecord:res:{number} -> billId -> bookingrecord:{billId} (full JSON).
 * Redis failures are non-fatal (treated as "no record").
 */
async function lookupRecord(reservationNumber: string): Promise<BookingRecord | null> {
  if (!reservationNumber) return null;
  try {
    const billId = await redis.get(`bookingrecord:res:${reservationNumber}`);
    if (!billId) return null;
    const raw = await redis.get(`bookingrecord:${billId}`);
    if (!raw) return null;
    return JSON.parse(raw) as BookingRecord;
  } catch (err) {
    console.warn(`[bmi-cancel-sweep] booking-record lookup failed for ${reservationNumber}:`, err);
    return null;
  }
}

interface SkipEntry {
  number: string;
  reason: string;
}
interface CenterResult {
  clientKey: string;
  checked: number;
  recovered: string[];
  wouldRecover: string[];
  skipped: SkipEntry[];
  error?: string;
}

async function sweepCenter(
  center: (typeof CENTERS)[number],
  today: string,
  till: string,
  dryRun: boolean,
): Promise<CenterResult> {
  const result: CenterResult = {
    clientKey: center.clientKey,
    checked: 0,
    recovered: [],
    wouldRecover: [],
    skipped: [],
  };

  let token: string;
  try {
    token = await getOfficeToken(center.clientKey);
  } catch (err) {
    result.error = err instanceof Error ? err.message : "auth failed";
    return result;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `sweep-${center.clientKey}`,
    clientkey: center.clientKey,
  };

  // Resource ids for the dayplanner query.
  const metaRes = await officeReq("GET", `/api/${center.clientKey}/metadata`, headers);
  if (metaRes.status >= 400) {
    result.error = `metadata ${metaRes.status}`;
    return result;
  }
  const meta = JSON.parse(metaRes.body);
  const ids = new Set<string>();
  for (const r of (meta.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (meta.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const resourceParam = [...ids].map((id) => `resourceIds=${id}`).join("&");

  const dpRes = await officeReq(
    "GET",
    `/api/${center.clientKey}/dayPlanner?${resourceParam}&from=${today}&till=${till}&showAll=true`,
    headers,
  );
  if (dpRes.status >= 400) {
    result.error = `dayplanner ${dpRes.status}`;
    return result;
  }

  // Lossless parse — some personIds are 17-digit and would round under JSON.parse.
  const dp = parseWithRawIds<{ reservations?: { projects?: DpProject[] } }>(dpRes.body);
  const projects = dp.reservations?.projects || [];

  const cutoff = new Date(today + "T00:00:00");
  const cancelled = projects.filter(
    (p) => String(p.stateId) === "-4" && new Date(p.date) >= cutoff,
  );
  result.checked = cancelled.length;

  for (const p of cancelled) {
    const num = String(p.number || "");
    const record = await lookupRecord(num);
    const recordStatus = record?.status;
    const recordCancelled =
      !!record &&
      (recordStatus === "cancelled" ||
        recordStatus === "refunded" ||
        !!record.cancelledAt ||
        !!record.refundedAt);
    const recordConfirmed = recordStatus === "confirmed";

    // Read userUpdatedId + payments from the full project entity.
    const projRes = await officeReq("GET", `/api/${center.clientKey}/project/${p.id}`, headers);
    if (projRes.status >= 400) {
      result.skipped.push({ number: num, reason: `project GET ${projRes.status}` });
      continue;
    }
    const proj = parseWithRawIds<{
      userUpdatedId?: string | number;
      payments?: unknown[];
    }>(projRes.body);
    const userUpdatedId = String(proj.userUpdatedId ?? "");
    const hasPayment = Array.isArray(proj.payments) && proj.payments.length > 0;
    const isAutoCancel = userUpdatedId === "-1";

    // Hybrid recovery gate.
    let recover = false;
    let reason: string;
    if (recordCancelled) {
      reason = `intentional: booking-record ${recordStatus || "cancelled"}`;
    } else if (recordConfirmed) {
      recover = true;
      reason = "A: confirmed booking-record";
    } else if (isAutoCancel && hasPayment) {
      recover = true;
      reason = "B: userUpdatedId=-1 + payment";
    } else {
      reason = `no-gate (uu=${userUpdatedId || "?"}, pay=${hasPayment}, rec=${recordStatus || "none"})`;
    }

    const label = `${num} ${(p.displayName || p.name || "?").trim()}`;
    if (!recover) {
      result.skipped.push({ number: num, reason });
      continue;
    }
    if (dryRun) {
      result.wouldRecover.push(`${label} [${reason}]`);
      continue;
    }

    // Recover: reset to Confirmation (-3) via Pandora. projectId is the exact
    // (string) project id from the dayplanner.
    try {
      const pandoraRes = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PANDORA_KEY}`,
        },
        body: JSON.stringify({
          locationID: center.pandoraLocation,
          projectId: String(p.id),
          stateID: "-3",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (pandoraRes.ok) {
        result.recovered.push(label);
        console.log(`[bmi-cancel-sweep] recovered ${label} (${center.clientKey}) — ${reason}`);
      } else {
        result.skipped.push({ number: num, reason: `recover failed ${pandoraRes.status}` });
      }
    } catch (err) {
      console.error(`[bmi-cancel-sweep] recover error ${label}:`, err);
      result.skipped.push({ number: num, reason: "recover exception" });
    }
  }

  return result;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const till = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);

  const centers: CenterResult[] = [];
  for (const center of CENTERS) {
    try {
      centers.push(await sweepCenter(center, today, till, dryRun));
    } catch (err) {
      centers.push({
        clientKey: center.clientKey,
        checked: 0,
        recovered: [],
        wouldRecover: [],
        skipped: [],
        error: err instanceof Error ? err.message : "sweep failed",
      });
    }
  }

  return NextResponse.json({
    dryRun,
    checked: centers.reduce((s, c) => s + c.checked, 0),
    recovered: centers.reduce((s, c) => s + c.recovered.length, 0),
    wouldRecover: centers.reduce((s, c) => s + c.wouldRecover.length, 0),
    centers,
  });
}
