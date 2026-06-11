import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { parseWithRawIds } from "@ft/db";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import {
  logBmiCancelEvent,
  getBmiCancelEvent,
  type BmiCancelClassification,
  type BmiCancelAction,
} from "@/lib/bmi-cancel-log";
import {
  rebuildRaceBill,
  type RebuildRacerHeat,
  type ApiCall,
} from "~/features/booking/service/bmi-rebuild";

/**
 * GET /api/cron/race-cancel-watch
 *
 * Watches PAID race bookings for BMI's "charged but empty" defect: BMI
 * auto-cancels a Pending-Online hold ~20 min after it's created and strips the
 * bill's products — even after a successful Square charge (payment/confirm never
 * registers). The customer is left charged with no live reservation.
 *
 * For any paid race whose heat is STILL IN THE FUTURE, this re-checks BMI; if
 * it's been system-cancelled (userUpdatedId = -1) it RE-BUILDS the heats into a
 * fresh bill (no re-charge), and logs the full BMI API request/response sequence
 * to bmi_cancel_events as evidence for BMI. Past-race breaks are logged, not
 * rebuilt (unactionable). Deliberate user/staff cancels are never touched.
 *
 * Auto-rebuild is gated by env RACE_AUTO_REBUILD (default ON; set "0"/"false" to
 * disable — falls back to alert-only). verify-after requires the rebuilt bill to
 * have products whose heat times match before it's marked rebuilt.
 *
 * Auth: verifyCron for scheduled runs; ?token=<ADMIN_CAMERA_TOKEN> for manual.
 *   ?dryRun=1            — detect + log, but never rebuild (still logs evidence)
 *   ?rebuildBill=<bill>  — manual single-bill rebuild (honors ?dryRun=1 for a
 *                          read-only availability/match check)
 *   ?windowHours=N       — deposit lookback (default 12)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const FT_FM_LOCATION = "LAB52GY480CJF";
const RACE_CLIENT_KEY = "headpinzftmyers";
const RACE_PANDORA_LOCATION = "LAB52GY480CJF";

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

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
  bmiTokenCache[clientKey] = {
    token: d.AccessToken || d.accessToken,
    expiry: Date.now() + parseInt(d.ExpiresIn || d.expiresIn || "3600", 10) * 1000,
  };
  return bmiTokenCache[clientKey].token;
}

/** BMI order overview — returns line count + an evidence ApiCall. */
async function bmiOverview(
  clientKey: string,
  billId: string,
): Promise<{ count: number | null; call: ApiCall }> {
  const t0 = Date.now();
  let status = 0;
  let text = "";
  let count: number | null = null;
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
    status = res.status;
    text = await res.text();
    if (status === 404) count = 0;
    else if (res.ok) {
      const ov = parseWithRawIds<{ lines?: unknown[] }>(text);
      count = Array.isArray(ov.lines) ? ov.lines.length : 0;
    }
  } catch (err) {
    text = err instanceof Error ? err.message : "error";
  }
  return {
    count,
    call: {
      step: "overview",
      method: "GET",
      endpoint: `order/${billId}/overview`,
      status,
      responseBody: text.slice(0, 1500),
      ms: Date.now() - t0,
    },
  };
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

/** BMI Office project (projectId = billId+1) — who/what last touched it + an
 *  evidence ApiCall (the proof it was a SYSTEM cancel: userUpdatedId = -1). */
async function fetchOfficeProject(
  clientKey: string,
  billId: string,
): Promise<{ project: OfficeProject | null; call: ApiCall }> {
  const projectId = (BigInt(billId) + BigInt(1)).toString();
  const t0 = Date.now();
  let status = 0;
  let body = "";
  let project: OfficeProject | null = null;
  try {
    const token = await getOfficeToken(clientKey);
    const res = await officeReq("GET", `/api/${clientKey}/project/${projectId}`, {
      Authorization: `Bearer ${token}`,
      "x-fast-version": SMS_VERSION,
      "x-session-id": `cancel-watch-${projectId}`,
      clientkey: clientKey,
    });
    status = res.status;
    body = res.body;
    if (status < 400) {
      const p = parseWithRawIds<{
        stateId?: string | number;
        userUpdatedId?: string | number;
        products?: unknown[];
        schedules?: Array<{ stateId?: string | number; start?: string }>;
      }>(body);
      const sch = (p.schedules || [])[0] || {};
      project = {
        stateId: p.stateId != null ? String(p.stateId) : null,
        userUpdatedId: p.userUpdatedId != null ? String(p.userUpdatedId) : null,
        scheduleStateId: sch.stateId != null ? String(sch.stateId) : null,
        scheduleStart: sch.start ?? null,
        productsCount: Array.isArray(p.products) ? p.products.length : 0,
      };
    }
  } catch (err) {
    body = err instanceof Error ? err.message : "error";
  }
  return {
    project,
    call: {
      step: "office/project",
      method: "GET",
      endpoint: `project/${projectId}`,
      status,
      responseBody: body.slice(0, 1500),
      ms: Date.now() - t0,
    },
  };
}

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
  contact: { firstName: string; lastName: string; email: string; phone: string } | null;
  reservationNumber: string | null;
  status: string | null;
  heatStart: string | null;
  date: string | null;
  heats: RebuildRacerHeat[];
}
async function bookingRecord(billId: string): Promise<BookingRec> {
  const empty: BookingRec = {
    name: null,
    contact: null,
    reservationNumber: null,
    status: null,
    heatStart: null,
    date: null,
    heats: [],
  };
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    if (!raw) return empty;
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
      reservationNumber?: string;
      status?: string;
      date?: string;
      racers?: Array<{
        racerName?: string;
        personId?: string;
        productId?: string;
        track?: string;
        heatStart?: string;
      }>;
    };
    const racers = r.racers || [];
    const heats: RebuildRacerHeat[] = racers
      .filter((x) => x.heatStart && x.productId)
      .map((x) => ({
        productId: String(x.productId),
        track: x.track ?? null,
        heatStart: x.heatStart!,
        personId: x.personId ?? null,
        firstName: x.racerName ?? r.contact?.firstName ?? "Racer",
        lastName: "",
      }));
    const heatStart =
      heats.map((h) => h.heatStart).sort()[0] ?? (r.date ? `${r.date}T00:00:00` : null);
    return {
      name: r.contact ? `${r.contact.firstName ?? ""} ${r.contact.lastName ?? ""}`.trim() : null,
      contact: r.contact
        ? {
            firstName: r.contact.firstName ?? "",
            lastName: r.contact.lastName ?? "",
            email: r.contact.email ?? "",
            phone: r.contact.phone ?? "",
          }
        : null,
      reservationNumber: r.reservationNumber ?? null,
      status: r.status ?? null,
      heatStart,
      date: r.date ?? (heatStart ? heatStart.slice(0, 10) : null),
      heats,
    };
  } catch {
    return empty;
  }
}

/** Naked-local ET heat ISO → epoch ms (June = EDT, -04:00). */
function heatEpochMs(heat: string | null): number | null {
  if (!heat) return null;
  const naked = heat.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const t = Date.parse(`${naked}-04:00`);
  return Number.isNaN(t) ? null : t;
}

function autoRebuildEnabled(): boolean {
  const v = process.env.RACE_AUTO_REBUILD;
  return v !== "0" && v !== "false"; // default ON
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
  const manualBill = req.nextUrl.searchParams.get("rebuildBill");
  const windowHours = Math.min(
    48,
    Math.max(1, Number(req.nextUrl.searchParams.get("windowHours")) || 12),
  );
  const origin = req.nextUrl.origin;
  const started = Date.now();
  const nowMs = started;

  if (!SQUARE_TOKEN)
    return NextResponse.json({ error: "SQUARE_ACCESS_TOKEN not set" }, { status: 500 });

  // ── Manual single-bill rebuild (test/ops). Honors dryRun (read-only match). ──
  if (manualBill) {
    const rec = await bookingRecord(manualBill);
    if (!rec.heats.length || !rec.contact) {
      return NextResponse.json(
        { error: "no heats/contact on booking record", bill: manualBill },
        { status: 404 },
      );
    }
    const rb = await rebuildRaceBill({
      origin,
      clientKey: RACE_CLIENT_KEY,
      oldBillId: manualBill,
      date: rec.date ?? rec.heatStart!.slice(0, 10),
      heats: rec.heats,
      contact: rec.contact,
      pandoraLocationId: RACE_PANDORA_LOCATION,
      pandoraKey: process.env.SWAGGER_ADMIN_KEY,
      dryRun,
    });
    if (!dryRun && rb.ok) {
      await logBmiCancelEvent({
        billId: manualBill,
        reservationNumber: rb.reservationNumber,
        productKind: "race",
        heatStart: rec.heatStart,
        isFuture: (heatEpochMs(rec.heatStart) ?? 0) > nowMs,
        guestName: rec.name,
        guestPhone: rec.contact.phone,
        classification: "system_cancel",
        action: "rebuilt",
        rebuildBillId: rb.newBillId,
        notes: `manual rebuild → ${rb.newBillId} (${rb.reservationNumber})`,
        apiCalls: rb.apiCalls,
      });
    }
    return NextResponse.json({ manual: true, dryRun, ...rb });
  }

  const beginIso = new Date(nowMs - windowHours * 3600_000).toISOString();
  const endIso = new Date(nowMs + 3600_000).toISOString();
  const deposits = await listRaceDeposits(beginIso, endIso);

  const AUTO = autoRebuildEnabled();
  const summary = {
    scanned: deposits.length,
    live: 0,
    systemCancelled: 0,
    futureSystemCancelled: 0,
    rebuilt: 0,
    rebuildFailed: 0,
    alerted: 0,
    userCancelled: 0,
    errors: 0,
  };
  const events: Array<Record<string, unknown>> = [];

  for (const dep of deposits) {
    const rec = await bookingRecord(dep.billId);
    if (rec.status === "cancelled" || rec.status === "refunded") continue;

    const apiCalls: ApiCall[] = [];
    const ov = await bmiOverview(RACE_CLIENT_KEY, dep.billId);
    apiCalls.push(ov.call);
    if (ov.count === null) {
      summary.errors++;
      continue;
    }
    if (ov.count > 0) {
      summary.live++;
      continue;
    }

    // Stripped — full evidence from the Office project.
    summary.systemCancelled++;
    const { project: proj, call: projCall } = await fetchOfficeProject(RACE_CLIENT_KEY, dep.billId);
    apiCalls.push(projCall);

    const heat = proj?.scheduleStart ?? rec.heatStart;
    const heatMs = heatEpochMs(heat);
    const isFuture = heatMs != null && heatMs > nowMs;

    let classification: BmiCancelClassification;
    if (proj?.userUpdatedId === "-1") classification = "system_cancel";
    else if (proj?.scheduleStateId === "-4" || proj?.stateId === "-4")
      classification = "user_cancel";
    else classification = "unknown";
    if (classification === "user_cancel") {
      summary.userCancelled++;
      continue; // deliberate cancel — never rebuild
    }

    const paidNotRefunded = dep.refundedCents < dep.amountCents;
    const actionable = classification === "system_cancel" && isFuture && paidNotRefunded;
    let action: BmiCancelAction = "detected";
    let rebuildBillId: string | null = null;
    let notes: string | null = null;

    if (actionable) {
      summary.futureSystemCancelled++;
      const prior = await getBmiCancelEvent(dep.billId);
      if (prior?.action === "rebuilt" && prior.rebuildBillId) {
        // Already rebuilt on a prior tick — idempotent, don't re-book.
        action = "rebuilt";
        rebuildBillId = prior.rebuildBillId;
        notes = "already rebuilt (idempotent skip)";
      } else if (AUTO && !dryRun && rec.contact && rec.heats.length) {
        const rb = await rebuildRaceBill({
          origin,
          clientKey: RACE_CLIENT_KEY,
          oldBillId: dep.billId,
          date: rec.date ?? heat!.slice(0, 10),
          heats: rec.heats,
          contact: rec.contact,
          pandoraLocationId: RACE_PANDORA_LOCATION,
          pandoraKey: process.env.SWAGGER_ADMIN_KEY,
        });
        apiCalls.push(...rb.apiCalls);
        if (rb.ok) {
          action = "rebuilt";
          rebuildBillId = rb.newBillId;
          notes = `auto-rebuilt → ${rb.newBillId} (${rb.reservationNumber})`;
          summary.rebuilt++;
          console.log(`[race-cancel-watch] REBUILT ${rec.name} ${dep.billId} → ${rb.newBillId}`);
        } else {
          action = "rebuild_failed";
          notes = rb.error;
          summary.rebuildFailed++;
          console.error(
            `[race-cancel-watch] REBUILD FAILED ${rec.name} ${dep.billId} heat=${heat} — ${rb.error} — phone=${rec.contact.phone}`,
          );
        }
      } else {
        action = "alerted";
        summary.alerted++;
        console.error(
          `[race-cancel-watch] *** FUTURE SYSTEM-CANCEL (alert-only) *** ${rec.name} ${rec.reservationNumber} ` +
            `bill=${dep.billId} $${(dep.amountCents / 100).toFixed(2)} heat=${heat} phone=${rec.contact?.phone}`,
        );
      }
    }

    if (!dryRun) {
      await logBmiCancelEvent({
        billId: dep.billId,
        reservationNumber: rec.reservationNumber,
        productKind: "race",
        heatStart: heat,
        isFuture,
        guestName: rec.name,
        guestPhone: rec.contact?.phone ?? null,
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
        rebuildBillId,
        notes,
        raw: {
          deposit: dep,
          project: proj,
          record: { ...rec, heats: rec.heats.length },
          checkedAt: new Date(nowMs).toISOString(),
        },
        apiCalls,
      });
    }

    events.push({
      bill: dep.billId,
      name: rec.name,
      res: rec.reservationNumber,
      heat,
      amount: (dep.amountCents / 100).toFixed(2),
      classification,
      isFuture,
      action,
      rebuildBillId,
    });
  }

  console.log(
    `[race-cancel-watch] dryRun=${dryRun} auto=${AUTO} window=${windowHours}h scanned=${summary.scanned} ` +
      `live=${summary.live} systemCancelled=${summary.systemCancelled} future=${summary.futureSystemCancelled} ` +
      `rebuilt=${summary.rebuilt} rebuildFailed=${summary.rebuildFailed} alerted=${summary.alerted} errors=${summary.errors}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    autoRebuild: AUTO,
    elapsedMs: Date.now() - started,
    ...summary,
    events,
  });
}
