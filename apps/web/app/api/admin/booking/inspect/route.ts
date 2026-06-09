import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { getBowlingReservationByBillId } from "@/lib/bowling-db";

/**
 * GET /api/admin/booking/inspect?token=...&billId=63000000003750208
 *
 * Read-only diagnostic. Given a BMI bill id, returns the complete cross-system
 * state of a reservation in one shot, so we can see exactly what a CHECK-IN does
 * to a $0 reservation — run it BEFORE and AFTER checking the guest in at the
 * center and diff the output. Reports:
 *   - bmi:       project state(s) (via the SMS-Timing Office API) — the -5
 *                "Arrived" transition + the project's financial fields are the
 *                check-in signals. Read at BOTH the bill id and the workaround
 *                project id (last-10 + 1), mirroring verifyPostConfirm.
 *   - giftCard:  Square gift-card state + balance (the funded deposit card)
 *   - dayofOrder: Square day-of order state/total/tendered (the open real order)
 *   - neon:      the reservation row (ids, center, status)
 */

export const dynamic = "force-dynamic";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

/** BMI / SMS-Timing project states (see /api/booking/confirm). -5 = checked in. */
const STATE_NAMES: Record<string, string> = {
  "-1": "New",
  "-2": "Reservation",
  "-3": "Confirmation",
  "-4": "Cancellation",
  "-5": "Arrived",
  "-100": "Pending online",
  "-101": "Payment started",
  "-102": "Paid online",
};

function auth(req: NextRequest): boolean {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
}

// ── Square ────────────────────────────────────────────────────────────────

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

async function squareGet(path: string) {
  try {
    const res = await fetch(`${SQUARE_BASE}${path}`, { headers: sqHeaders() });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : "error",
    };
  }
}

// ── SMS-Timing Office API (authoritative project state) ─────────────────────

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
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
    r.on("error", reject);
    r.setTimeout(15_000, () => {
      r.destroy();
      reject(new Error("Office API timeout"));
    });
    if (body) r.write(body);
    r.end();
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
  if (res.status !== 200) throw new Error(`Office auth ${res.status}`);
  return JSON.parse(res.body).access_token;
}

function extractState(res: { status: number; body: string } | null) {
  if (!res || res.status >= 400)
    return { httpStatus: res?.status ?? 0, stateId: null, project: null };
  try {
    const p = JSON.parse(res.body);
    return {
      httpStatus: res.status,
      stateId: p.stateId != null ? String(p.stateId) : null,
      project: p,
    };
  } catch {
    return { httpStatus: res.status, stateId: null, project: null };
  }
}

/**
 * Authoritative project lookup: search by reservation number → project localId,
 * then read project state at BOTH the bill id and the discovered project id
 * (they can differ by the autocancel-workaround offset).
 */
async function officeProject(clientKey: string, reservationNumber: string, billId: string) {
  const token = await getOfficeToken(clientKey);
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": `inspect-${billId}`,
    clientkey: clientKey,
  };

  let projectId: string | null = null;
  if (reservationNumber) {
    const searchRes = await officeReq(
      "GET",
      `/api/${clientKey}/search?token=${encodeURIComponent(reservationNumber)}&maxResults=5`,
      h,
    );
    if (searchRes.status < 400) {
      try {
        const results = JSON.parse(searchRes.body);
        const proj = Array.isArray(results)
          ? results.find((r: { kind?: number }) => r.kind === 2)
          : null;
        if (proj?.localId) projectId = String(proj.localId);
      } catch {
        /* ignore */
      }
    }
  }

  const atBill = extractState(await officeReq("GET", `/api/${clientKey}/project/${billId}`, h));
  const atProject =
    projectId && projectId !== billId
      ? extractState(await officeReq("GET", `/api/${clientKey}/project/${projectId}`, h))
      : null;

  return { projectId, atBill, atProject };
}

function clientKeyFor(centerCode: string | undefined): string {
  return centerCode === "naples" ? "headpinznaples" : "headpinzftmyers";
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const billId = req.nextUrl.searchParams.get("billId") ?? "";
  if (!billId) return NextResponse.json({ error: "billId required" }, { status: 400 });

  const reservation = await getBowlingReservationByBillId(billId);
  const clientKey =
    req.nextUrl.searchParams.get("clientKey") ?? clientKeyFor(reservation?.centerCode);

  // 1. BMI project state — the check-in signal (-5 Arrived) + financial fields.
  let bmi: unknown = { error: "no reservationNumber in Neon — cannot search" };
  try {
    const proj = await officeProject(clientKey, reservation?.bmiReservationNumber ?? "", billId);
    const chosen = proj.atProject?.stateId ? proj.atProject : proj.atBill;
    bmi = {
      clientKey,
      projectId: proj.projectId,
      stateId: chosen.stateId,
      stateName: chosen.stateId ? (STATE_NAMES[chosen.stateId] ?? chosen.stateId) : "not_found",
      atBill: { httpStatus: proj.atBill.httpStatus, stateId: proj.atBill.stateId },
      atProject: proj.atProject
        ? { httpStatus: proj.atProject.httpStatus, stateId: proj.atProject.stateId }
        : null,
      // Full project object so we can see any payment / financial fields a
      // check-in might touch.
      project: chosen.project,
    };
  } catch (err) {
    bmi = { error: err instanceof Error ? err.message : "office lookup failed", clientKey };
  }

  // 2. Square gift card — the funded deposit card
  let giftCard: unknown = null;
  if (reservation?.squareGiftCardId) {
    const gc = await squareGet(`/gift-cards/${reservation.squareGiftCardId}`);
    giftCard = gc.ok
      ? {
          gan: gc.body?.gift_card?.gan,
          state: gc.body?.gift_card?.state,
          balanceCents: gc.body?.gift_card?.balance_money?.amount ?? null,
        }
      : { error: `square ${gc.status}`, raw: gc.body };
  }

  // 3. Square day-of order — the open real-product order
  let dayofOrder: unknown = null;
  if (reservation?.squareDayofOrderId) {
    const ord = await squareGet(`/orders/${reservation.squareDayofOrderId}`);
    dayofOrder = ord.ok
      ? {
          state: ord.body?.order?.state,
          locationId: ord.body?.order?.location_id ?? null,
          totalCents: ord.body?.order?.total_money?.amount ?? null,
          // Actual money applied to the order = sum of tenders ($0 until the
          // gift card is redeemed at check-in).
          tenderedCents: (ord.body?.order?.tenders ?? []).reduce(
            (s: number, t: { amount_money?: { amount?: number } }) =>
              s + (t.amount_money?.amount ?? 0),
            0,
          ),
          tenders: (ord.body?.order?.tenders ?? []).map(
            (t: { type?: string; amount_money?: { amount?: number } }) => ({
              type: t.type,
              amountCents: t.amount_money?.amount ?? null,
            }),
          ),
        }
      : { error: `square ${ord.status}`, raw: ord.body };
  }

  return NextResponse.json({
    billId,
    bmi,
    giftCard,
    dayofOrder,
    neon: reservation
      ? {
          id: reservation.id,
          status: reservation.status,
          productKind: reservation.productKind,
          centerCode: reservation.centerCode,
          guestName: reservation.guestName,
          bmiReservationNumber: reservation.bmiReservationNumber,
          giftCardId: reservation.squareGiftCardId,
          giftCardGan: reservation.squareGiftCardGan,
          dayofOrderId: reservation.squareDayofOrderId,
          depositCents: reservation.depositCents,
        }
      : null,
  });
}
