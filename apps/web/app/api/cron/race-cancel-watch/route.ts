import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { parseWithRawIds } from "@ft/db";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { logBmiCancelEvent, type BmiCancelClassification } from "@/lib/bmi-cancel-log";

/**
 * GET /api/cron/race-cancel-watch
 *
 * Watches PAID race bookings for BMI's "charged but empty" defect: BMI
 * auto-cancels a Pending-Online hold ~20 min after it's created (the center's
 * timeout) and strips the bill's products — even after a successful Square
 * charge, because payment/confirm doesn't register. The customer is left charged
 * with no live reservation.
 *
 * The pre-charge guard (bmiBillIsLive) can't catch this — the bill is alive when
 * we charge and dies minutes later. So we watch from the other side: scan today's
 * race deposits, and for any whose race is STILL IN THE FUTURE, re-check BMI. If
 * it's been system-cancelled, log the full evidence to bmi_cancel_events (for the
 * BMI bug report) and alert.
 *
 * Read-only against BMI in this phase — it detects, logs, and alerts. The
 * auto-rebuild (re-book the heats into a fresh bill) is the next phase and slots
 * in where noted. Past-race breaks are logged but not alerted (unactionable).
 *
 * Auth mirrors race-confirm-reconcile: verifyCron for scheduled runs; a valid
 * ?token=<ADMIN_CAMERA_TOKEN> bypasses for manual/dev runs. ?dryRun=1 skips the
 * DB writes (still reports). ?windowHours=N overrides the deposit lookback.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── Square (race deposits land at FastTrax FM) ─────────────────────────
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const FT_FM_LOCATION = "LAB52GY480CJF";

// ── BMI public booking API (order overview) ────────────────────────────
const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

// ── BMI Office API (project state / userUpdatedId — who cancelled) ─────
const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

const bmiTokenCache: Record<string, { token: string; expiry: number }> = {};
async function getBmiToken(clientKey: string): Promise<string> {
  const c = bmiTokenCache[clientKey];
  if (c && Date.now() < c.expiry - 60_000) return c.token;
  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth ${res.status}`);
  const d = await res.json();
  const token = d.AccessToken || d.accessToken;
  bmiTokenCache[clientKey] = {
    token,
    expiry: Date.now() + parseInt(d.ExpiresIn || d.expiresIn || "3600", 10) * 1000,
  };
  return token;
}

/** BMI order overview line count (lines.length). null on error (fail-open: skip). */
async function bmiOverviewLineCount(clientKey: string, billId: string): Promise<number | null> {
  try {
    const token = await getBmiToken(clientKey);
    const res = await fetch(`${BMI_API_URL}/public-booking/${clientKey}/order/${billId}/overview`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "BMI-Subscription-Key": BMI_SUB_KEY,
        "Accept-Language": "en",
      },
      cache: "no-store",
    });
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const ov = parseWithRawIds<{ lines?: unknown[] }>(await res.text());
    return Array.isArray(ov.lines) ? ov.lines.length : 0;
  } catch {
    return null;
  }
}

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
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

let officeTokenCache: { token: string; expiry: number; clientKey: string } | null = null;
async function getOfficeToken(clientKey: string): Promise<string> {
  if (
    officeTokenCache &&
    officeTokenCache.clientKey === clientKey &&
    Date.now() < officeTokenCache.expiry - 60_000
  )
    return officeTokenCache.token;
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
  if (res.status !== 200) throw new Error(`Office auth ${res.status}`);
  const token = JSON.parse(res.body).access_token;
  officeTokenCache = { token, clientKey, expiry: Date.now() + 3500_000 };
  return token;
}

interface OfficeProject {
  stateId: string | null;
  userUpdatedId: string | null;
  scheduleStateId: string | null;
  scheduleStart: string | null;
  productsCount: number;
}

/** BMI Office project entity (projectId = billId+1) — who/what last touched it. */
async function fetchOfficeProject(
  clientKey: string,
  billId: string,
): Promise<OfficeProject | null> {
  try {
    const projectId = (BigInt(billId) + BigInt(1)).toString();
    const token = await getOfficeToken(clientKey);
    const res = await officeReq("GET", `/api/${clientKey}/project/${projectId}`, {
      Authorization: `Bearer ${token}`,
      "x-fast-version": SMS_VERSION,
      "x-session-id": `cancel-watch-${projectId}`,
      clientkey: clientKey,
    });
    if (res.status >= 400) return null;
    const p = parseWithRawIds<{
      stateId?: string | number;
      userUpdatedId?: string | number;
      products?: unknown[];
      schedules?: Array<{ stateId?: string | number; start?: string; productIds?: unknown[] }>;
    }>(res.body);
    const sch = (p.schedules || [])[0] || {};
    return {
      stateId: p.stateId != null ? String(p.stateId) : null,
      userUpdatedId: p.userUpdatedId != null ? String(p.userUpdatedId) : null,
      scheduleStateId: sch.stateId != null ? String(sch.stateId) : null,
      scheduleStart: sch.start ?? null,
      productsCount: Array.isArray(p.products) ? p.products.length : 0,
    };
  } catch {
    return null;
  }
}

// ── Square: today's race deposits at FastTrax FM ───────────────────────
interface RaceDeposit {
  billId: string;
  paymentId: string;
  orderId: string | null;
  amountCents: number;
  refundedCents: number;
  createdAt: string;
}
async function listRaceDeposits(beginIso: string, endIso: string): Promise<RaceDeposit[]> {
  const out: RaceDeposit[] = [];
  let cursor: string | undefined;
  do {
    const u = new URL(`${SQUARE_BASE}/payments`);
    u.searchParams.set("begin_time", beginIso);
    u.searchParams.set("end_time", endIso);
    u.searchParams.set("location_id", FT_FM_LOCATION);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, "Square-Version": SQUARE_VERSION },
      cache: "no-store",
    });
    if (!res.ok) break;
    const d = await res.json();
    for (const p of d.payments || []) {
      const m = (p.note || "").match(/Deposit \| Ref:\s*(\d{10,})/);
      if (m && p.status === "COMPLETED") {
        out.push({
          billId: m[1],
          paymentId: p.id,
          orderId: p.order_id ?? null,
          amountCents: p.amount_money?.amount ?? 0,
          refundedCents: p.refunded_money?.amount ?? 0,
          createdAt: p.created_at,
        });
      }
    }
    cursor = d.cursor;
  } while (cursor);
  return out;
}

interface BookingRec {
  name: string | null;
  phone: string | null;
  reservationNumber: string | null;
  status: string | null;
  heatStart: string | null;
}
async function bookingRecord(billId: string): Promise<BookingRec> {
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    if (!raw)
      return { name: null, phone: null, reservationNumber: null, status: null, heatStart: null };
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      contact?: { firstName?: string; lastName?: string; phone?: string };
      reservationNumber?: string;
      status?: string;
      date?: string;
      racers?: Array<{ heatStart?: string }>;
    };
    const heat =
      (r.racers || [])
        .map((x) => x.heatStart)
        .filter(Boolean)
        .sort()[0] ??
      r.date ??
      null;
    return {
      name: r.contact ? `${r.contact.firstName ?? ""} ${r.contact.lastName ?? ""}`.trim() : null,
      phone: r.contact?.phone ?? null,
      reservationNumber: r.reservationNumber ?? null,
      status: r.status ?? null,
      heatStart: heat,
    };
  } catch {
    return { name: null, phone: null, reservationNumber: null, status: null, heatStart: null };
  }
}

/** Naked-local ET heat ISO → epoch ms (June = EDT, -04:00). */
function heatEpochMs(heat: string | null): number | null {
  if (!heat) return null;
  const naked = heat.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const t = Date.parse(`${naked}-04:00`);
  return Number.isNaN(t) ? null : t;
}

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const windowHours = Math.min(
    24,
    Math.max(1, Number(req.nextUrl.searchParams.get("windowHours")) || 12),
  );
  const started = Date.now();
  const nowMs = started;
  const clientKey = "headpinzftmyers"; // race deposits are FT (headpinzftmyers tenant)

  if (!SQUARE_TOKEN) {
    return NextResponse.json({ error: "SQUARE_ACCESS_TOKEN not set" }, { status: 500 });
  }

  const beginIso = new Date(nowMs - windowHours * 3600_000).toISOString();
  const endIso = new Date(nowMs + 3600_000).toISOString();
  const deposits = await listRaceDeposits(beginIso, endIso);

  const summary = {
    scanned: deposits.length,
    futureChecked: 0,
    live: 0,
    systemCancelled: 0,
    futureSystemCancelled: 0,
    pastSystemCancelled: 0,
    userCancelled: 0,
    errors: 0,
  };
  const alerts: Array<Record<string, unknown>> = [];

  for (const dep of deposits) {
    const rec = await bookingRecord(dep.billId);
    // Skip deliberately cancelled/refunded bookings entirely.
    if (rec.status === "cancelled" || rec.status === "refunded") continue;

    const lineCount = await bmiOverviewLineCount(clientKey, dep.billId);
    if (lineCount === null) {
      summary.errors++;
      continue;
    }
    if (lineCount > 0) {
      summary.live++;
      continue; // healthy — nothing to record
    }

    // Empty/stripped — gather full evidence from the Office project.
    summary.systemCancelled++;
    const proj = await fetchOfficeProject(clientKey, dep.billId);
    const heat = proj?.scheduleStart ?? rec.heatStart;
    const heatMs = heatEpochMs(heat);
    const isFuture = heatMs != null && heatMs > nowMs;

    let classification: BmiCancelClassification;
    if (proj?.userUpdatedId === "-1") classification = "system_cancel";
    else if (proj?.scheduleStateId === "-4" || proj?.stateId === "-4")
      classification = "user_cancel";
    else classification = "unknown";

    if (classification === "user_cancel") summary.userCancelled++;
    if (isFuture) summary.futureChecked++;

    // Future system-cancel = actionable: alert. (Auto-rebuild plugs in HERE next.)
    const actionable =
      classification === "system_cancel" && isFuture && dep.refundedCents < dep.amountCents;
    if (actionable) summary.futureSystemCancelled++;
    else if (classification === "system_cancel") summary.pastSystemCancelled++;

    const action = actionable ? "alerted" : "detected";

    if (!dryRun) {
      await logBmiCancelEvent({
        billId: dep.billId,
        reservationNumber: rec.reservationNumber,
        productKind: "race",
        heatStart: heat,
        isFuture,
        guestName: rec.name,
        guestPhone: rec.phone,
        squarePaymentId: dep.paymentId,
        squareOrderId: dep.orderId,
        amountCents: dep.amountCents,
        refundedCents: dep.refundedCents,
        classification,
        projectStateId: proj?.stateId ?? null,
        scheduleStateId: proj?.scheduleStateId ?? null,
        userUpdatedId: proj?.userUpdatedId ?? null,
        productsCount: proj?.productsCount ?? 0,
        action,
        notes: actionable ? "FUTURE system-cancel — needs rebuild/contact before race" : null,
        raw: { deposit: dep, project: proj, record: rec, checkedAt: new Date(nowMs).toISOString() },
      });
    }

    if (actionable) {
      const a = {
        bill: dep.billId,
        res: rec.reservationNumber,
        name: rec.name,
        phone: rec.phone,
        heat,
        amount: (dep.amountCents / 100).toFixed(2),
      };
      alerts.push(a);
      console.error(
        `[race-cancel-watch] *** FUTURE SYSTEM-CANCEL *** ${a.name} ${a.res} bill=${a.bill} ` +
          `$${a.amount} heat=${a.heat} phone=${a.phone} — paid but BMI empty, race still upcoming`,
      );
    }
  }

  console.log(
    `[race-cancel-watch] dryRun=${dryRun} window=${windowHours}h ` +
      `scanned=${summary.scanned} live=${summary.live} systemCancelled=${summary.systemCancelled} ` +
      `futureActionable=${summary.futureSystemCancelled} userCancelled=${summary.userCancelled} errors=${summary.errors}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    elapsedMs: Date.now() - started,
    ...summary,
    alerts,
  });
}
