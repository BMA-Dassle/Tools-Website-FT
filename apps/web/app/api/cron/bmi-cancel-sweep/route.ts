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
 * BMI's payment/confirm has two known failure modes:
 *   1. Auto-cancel: sets stateId=-4 (userUpdatedId=-1) despite successful payment
 *   2. Stuck payment: state stays at -101 ("Payment started") and never
 *      transitions to -3 (Confirmation), even though payment was recorded
 *
 * This cron scans the BMI Office dayplanner for both states and recovers
 * them by setting stateId to -3 (Confirmation) via Pandora.
 *
 * Runs every 5 minutes. Recovery (-3 on an already-confirmed project) is a no-op.
 *
 * RECOVERY GATE — only undo SYSTEM failures, never a real cancellation:
 *   (A) stateId=-101/-102 (stuck payment, NOT a cancel) + confirmed booking-record
 *   (B) stateId=-4 auto-cancel (userUpdatedId=-1, "SYSTEM_CRON") + payment or
 *       confirmed booking-record
 *   (C) stateId=-101/-102 (stuck payment) + has online payment
 * NEVER recovered:
 *   - a booking-record explicitly marked cancelled/refunded
 *   - a -4 Cancellation whose last writer was a real user (staff onsite cancel or
 *     online cancel; userUpdatedId !== -1) — that's intentional. This is what lets
 *     staff cancel a booking onsite without the sweep flipping it back to confirmed.
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
interface RecoveryDetail {
  wNumber: string;
  guest: string;
  projectId: string;
  date: string;
  stateId: string;
  stateName: string;
  cancelledBy: string;
  cancelledByName: string;
  reason: string;
}

// States that need recovery:
//   -4   = Cancellation (auto-cancelled by BMI cron)
//   -101 = Payment started (payment/confirm stuck mid-transition)
//   -102 = Paid online (payment recorded but project not confirmed)
const RECOVERABLE_STATES = new Set(["-4", "-101", "-102"]);
interface CenterResult {
  clientKey: string;
  scannedProjects: number;
  checked: number;
  recovered: RecoveryDetail[];
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
    scannedProjects: 0,
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

  result.scannedProjects = projects.length;
  const cutoff = new Date(today + "T00:00:00");
  const needsRecovery = projects.filter(
    (p) => RECOVERABLE_STATES.has(String(p.stateId)) && new Date(p.date) >= cutoff,
  );
  result.checked = needsRecovery.length;

  // Count by state for logging
  const byCancelledState: Record<string, number> = {};
  for (const p of needsRecovery) {
    const s = String(p.stateId);
    byCancelledState[s] = (byCancelledState[s] || 0) + 1;
  }

  console.log(
    `[bmi-cancel-sweep] ${center.clientKey}: ${projects.length} projects, ` +
      `${needsRecovery.length} need recovery ` +
      `(${
        Object.entries(byCancelledState)
          .map(([k, v]) => `state${k}=${v}`)
          .join(", ") || "none"
      })`,
  );

  for (const p of needsRecovery) {
    const num = String(p.number || "");
    const pStateId = String(p.stateId);
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
      payments?: Array<{ payMethodId?: string | number; deviceCreated?: string; amount?: number }>;
    }>(projRes.body);
    const userUpdatedId = String(proj.userUpdatedId ?? "");
    const payments = Array.isArray(proj.payments) ? proj.payments : [];
    const hasPayment = payments.length > 0;
    const hasOnlinePayment = payments.some(
      (pay) =>
        String(pay.payMethodId) === "42603617" ||
        pay.deviceCreated === "Online Booking" ||
        pay.deviceCreated === "Online Office",
    );
    const isAutoCancel = userUpdatedId === "-1";
    const isCancellation = pStateId === "-4";
    const cancelledByName =
      userUpdatedId === "-1"
        ? "SYSTEM_CRON"
        : userUpdatedId === "-17"
          ? "ONLINE_BOOKING"
          : userUpdatedId
            ? `user_${userUpdatedId}`
            : "unknown";

    // Recovery gate — only undo SYSTEM failures, NEVER a real cancellation.
    //
    // A -4 Cancellation is recovered ONLY when its last writer was BMI's own
    // auto-cancel bug (userUpdatedId === "-1", "SYSTEM_CRON"). If a real user
    // cancelled it — staff onsite, or an online cancel (userUpdatedId !== "-1") —
    // that is INTENTIONAL and must stand, even though our booking-record may still
    // say "confirmed" (an onsite cancel never notifies us). Recovering those was
    // flipping real cancellations back to confirmed, leaving no way to cancel a
    // booking onsite. The -101/-102 (stuck-payment) states are not cancellations,
    // so the confirmed-record gate still applies to them unchanged.
    let recover = false;
    let reason: string;
    if (recordCancelled) {
      reason = `intentional: booking-record ${recordStatus || "cancelled"}`;
    } else if (isCancellation && !isAutoCancel) {
      reason = `intentional: cancelled by ${cancelledByName} (userUpdatedId=${userUpdatedId || "?"})`;
    } else if ((pStateId === "-101" || pStateId === "-102") && hasOnlinePayment) {
      // -101 Payment started / -102 Paid online + online payment = stuck
      recover = true;
      reason = `C: state ${pStateId} + online payment`;
    } else if (isCancellation && isAutoCancel && (hasPayment || recordConfirmed)) {
      // -4 auto-cancelled by BMI (userUpdatedId=-1) — the bug we work around.
      recover = true;
      reason = `B: auto-cancel (userUpdatedId=-1)${hasPayment ? " + payment" : ""}${
        recordConfirmed ? " + confirmed record" : ""
      }`;
    } else if (!isCancellation && recordConfirmed) {
      // Non-cancellation recoverable states (-101/-102) with a confirmed record.
      recover = true;
      reason = "A: confirmed booking-record";
    } else if (pStateId === "-101" || pStateId === "-102") {
      reason = `state ${pStateId} but no online payment (pay=${hasPayment})`;
    } else {
      reason = `no-gate (state=${pStateId}, uu=${userUpdatedId || "?"}, pay=${hasPayment}, rec=${recordStatus || "none"})`;
    }

    const guest = (p.displayName || p.name || "?").trim();
    const label = `${num} "${guest}"`;

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
        const stateNames: Record<string, string> = {
          "-4": "Cancellation",
          "-100": "Pending online",
          "-101": "Payment started",
          "-102": "Paid online",
        };
        const detail: RecoveryDetail = {
          wNumber: num,
          guest,
          projectId: String(p.id),
          date: p.date,
          stateId: pStateId,
          stateName: stateNames[pStateId] || pStateId,
          cancelledBy: userUpdatedId,
          cancelledByName,
          reason,
        };
        result.recovered.push(detail);
        console.log(
          `[bmi-cancel-sweep] RECOVERED ${label} project=${p.id} date=${p.date} ` +
            `state=${pStateId}(${stateNames[pStateId] || "?"}) ` +
            `cancelledBy=${cancelledByName} gate=${reason}`,
        );

        // Persist to Redis for BMI evidence
        try {
          const logEntry = JSON.stringify({
            ...detail,
            center: center.clientKey,
            recoveredAt: new Date().toISOString(),
            payments: payments.map((pay) => ({
              amount: pay.amount,
              payMethodId: String(pay.payMethodId ?? ""),
              device: pay.deviceCreated ?? "",
            })),
          });
          await redis.lpush("bmi:sweep:log", logEntry);
          await redis.ltrim("bmi:sweep:log", 0, 999);
        } catch {
          // Redis failure is non-fatal
        }
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
        scannedProjects: 0,
        checked: 0,
        recovered: [],
        wouldRecover: [],
        skipped: [],
        error: err instanceof Error ? err.message : "sweep failed",
      });
    }
  }

  const totalRecovered = centers.reduce((s, c) => s + c.recovered.length, 0);
  if (totalRecovered === 0) {
    console.log(
      `[bmi-cancel-sweep] clean run — ${centers.reduce((s, c) => s + c.checked, 0)} cancelled checked, 0 recoveries`,
    );
  }

  return NextResponse.json({
    dryRun,
    scannedProjects: centers.reduce((s, c) => s + c.scannedProjects, 0),
    checked: centers.reduce((s, c) => s + c.checked, 0),
    recovered: totalRecovered,
    wouldRecover: centers.reduce((s, c) => s + c.wouldRecover.length, 0),
    centers,
  });
}
