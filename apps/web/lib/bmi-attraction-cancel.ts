/**
 * Server-side helper to cancel BMI attraction bookings via the Office API.
 *
 * Fully-booked BMI bills cannot be cancelled through the public API —
 * instead we use the Office API to set the project's stateId to "-4"
 * (Cancelled).
 *
 * Flow per booking:
 *   1. GET /api/{clientKey}/project/{bmiOrderId}   → full project entity
 *   2. PUT /api/{clientKey}/project                 → same entity with stateId: "-4"
 *
 * Best-effort: logs errors but never throws. A failed BMI cancel should
 * never block a bowling cancellation or reschedule.
 */

import https from "https";
import { randomUUID } from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

/** Cancelled state in BMI Office */
const STATE_CANCELLED = "-4";

// ── Center code → BMI client key ────────────────────────────────────────────

const CENTER_CODE_TO_BMI_CLIENT: Record<string, string> = {
  TXBSQN0FEKQ11: "headpinzftmyers",
  PPTR5G2N0QXF7: "headpinznaples",
};

// ── HTTPS helpers (Node fetch/undici doesn't work with this API) ────────────

function httpsGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function httpsRequest(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

// ── Token cache (per client key) ────────────────────────────────────────────

const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getOfficeToken(clientKey: string): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) {
    return cached.token;
  }

  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await httpsRequest("POST", "/auth/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: clientKey,
    "x-fast-version": SMS_VERSION,
  });

  if (res.status !== 200) {
    throw new Error(`BMI Office auth failed (${clientKey}): ${res.status}`);
  }

  const data = JSON.parse(res.body);
  const token = data.access_token as string;
  const expiresIn = parseInt(data.expires_in || "86400", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

function apiHeaders(token: string, clientKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: clientKey,
    "Content-Type": "application/json",
  };
}

// ── Cancel logic ────────────────────────────────────────────────────────────

interface AttractionBooking {
  bmiOrderId: string | null;
  slug: string;
  name: string;
  [key: string]: unknown;
}

/**
 * Cancel all BMI attraction bookings for a reservation via the Office API.
 *
 * Multiple attractions may share one `bmiOrderId` (chained onto the same
 * BMI bill). Deduplicates order IDs so each project is cancelled once.
 *
 * @param centerCode - Square location ID (e.g. "TXBSQN0FEKQ11")
 * @param attractionBookings - array from reservation.attractionBookings
 */
export async function cancelBmiAttractions(
  centerCode: string,
  attractionBookings: AttractionBooking[],
): Promise<void> {
  if (!attractionBookings.length) return;

  const clientKey = CENTER_CODE_TO_BMI_CLIENT[centerCode];
  if (!clientKey) {
    console.warn(`[bmi-attraction-cancel] unknown centerCode=${centerCode}, skipping`);
    return;
  }

  // Deduplicate — multiple attractions may share one BMI order/project
  const uniqueOrderIds = [
    ...new Set(
      attractionBookings
        .map((a) => a.bmiOrderId)
        .filter((id): id is string => id != null && id !== ""),
    ),
  ];

  if (uniqueOrderIds.length === 0) {
    console.log("[bmi-attraction-cancel] no bmiOrderIds to cancel");
    return;
  }

  let token: string;
  try {
    token = await getOfficeToken(clientKey);
  } catch (err) {
    console.warn(
      "[bmi-attraction-cancel] Office auth failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  for (const orderId of uniqueOrderIds) {
    try {
      const headers = apiHeaders(token, clientKey);

      // 1. GET the full project entity
      // CRITICAL: orderId is a raw string — never parse through Number().
      const getRes = await httpsGet(`/api/${clientKey}/project/${orderId}`, headers);

      if (getRes.status !== 200) {
        console.warn(
          `[bmi-attraction-cancel] GET project ${orderId} failed: ${getRes.status} ${getRes.body.substring(0, 200)}`,
        );
        continue;
      }

      const project = JSON.parse(getRes.body);

      // Already cancelled — skip
      if (String(project.stateId) === STATE_CANCELLED) {
        console.log(`[bmi-attraction-cancel] project ${orderId} already cancelled, skipping`);
        continue;
      }

      // 2. PUT back with stateId set to cancelled
      project.stateId = STATE_CANCELLED;

      const putRes = await httpsRequest(
        "PUT",
        `/api/${clientKey}/project`,
        JSON.stringify(project),
        headers,
      );

      if (putRes.status === 200) {
        console.log(`[bmi-attraction-cancel] cancelled project ${orderId} (${clientKey})`);
      } else {
        console.warn(
          `[bmi-attraction-cancel] PUT project ${orderId} failed: ${putRes.status} ${putRes.body.substring(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[bmi-attraction-cancel] error orderId=${orderId} (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
