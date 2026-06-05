import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import https from "https";
import redis from "@/lib/redis";

/**
 * POST /api/booking/confirm
 *
 * Idempotent server-side payment/confirm for v1 bookings.
 * Replaces the client-side payment/confirm call that was vulnerable
 * to double-fires (page reload, React re-render, retry loops).
 *
 * Idempotency: if this billId was already confirmed, returns the
 * cached result without calling BMI again. This prevents the
 * payment/confirm double-call bug where the second call reverts
 * the project from Confirmation (-3) to Payment started (-101).
 *
 * Body: { billId, amount, clientKey?, depositKind? }
 * Returns: { reservationNumber, reservationCode, orderId, alreadyConfirmed }
 */

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

const ALLOWED_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);
const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getBmiToken(clientKey: string): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": BMI_SUB_KEY,
    },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth failed: ${res.status}`);
  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

function bmiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": BMI_SUB_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

// ── Office API (SMS-Timing) — post-confirm state verification ────────────────

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "";
const OFFICE_PASS = OFFICE_PASS_B64
  ? Buffer.from(OFFICE_PASS_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

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
    const r = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
    });
    r.on("error", reject);
    r.setTimeout(15_000, () => {
      r.destroy();
      reject(new Error("Timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

let officeTokenCache: { token: string; expiry: number; clientKey: string } | null = null;

async function getOfficeToken(clientKey: string): Promise<string> {
  if (
    officeTokenCache &&
    officeTokenCache.clientKey === clientKey &&
    Date.now() < officeTokenCache.expiry - 60_000
  ) {
    return officeTokenCache.token;
  }
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
  if (res.status !== 200) throw new Error(`Office auth: ${res.status}`);
  const data = JSON.parse(res.body);
  officeTokenCache = { token: data.access_token, clientKey, expiry: Date.now() + 3500_000 };
  return data.access_token;
}

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

async function verifyPostConfirm(
  clientKey: string,
  orderId: string,
  wNumber: string,
): Promise<void> {
  try {
    const token = await getOfficeToken(clientKey);
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "x-fast-version": SMS_VERSION,
      "x-session-id": `verify-${Date.now()}`,
      clientkey: clientKey,
    };

    const searchRes = await officeReq(
      "GET",
      `/api/${clientKey}/search?token=${wNumber}&maxResults=3`,
      h,
    );
    const searchResults = searchRes.status < 400 ? JSON.parse(searchRes.body) : [];
    const projectResult = Array.isArray(searchResults)
      ? searchResults.find((r: { kind?: number }) => r.kind === 2)
      : null;
    const projectId = projectResult?.localId ? String(projectResult.localId) : null;

    const projAtOrderId = await officeReq("GET", `/api/${clientKey}/project/${orderId}`, h);

    let projAtProjectId: { status: number; body: string } | null = null;
    if (projectId && projectId !== orderId) {
      projAtProjectId = await officeReq("GET", `/api/${clientKey}/project/${projectId}`, h);
    }

    function extractState(res: { status: number; body: string } | null) {
      if (!res || res.status >= 400)
        return { httpStatus: res?.status ?? 0, stateId: null, userUpdatedId: null };
      try {
        const p = JSON.parse(res.body);
        return {
          httpStatus: res.status,
          stateId: String(p.stateId ?? "?"),
          userUpdatedId: String(p.userUpdatedId ?? "?"),
        };
      } catch {
        return { httpStatus: res.status, stateId: null, userUpdatedId: null };
      }
    }

    const orderIdState = extractState(projAtOrderId);
    const projectIdState = projectId ? extractState(projAtProjectId) : null;

    const logEntry = {
      type: "post-confirm-verify",
      timestamp: new Date().toISOString(),
      clientKey,
      wNumber,
      orderId,
      projectId,
      orderIdMatchesProjectId: orderId === projectId,
      offset: projectId ? String(BigInt(projectId) - BigInt(orderId)) : null,
      orderIdLookup: {
        ...orderIdState,
        stateName: STATE_NAMES[orderIdState.stateId ?? ""] || orderIdState.stateId,
      },
      projectIdLookup: projectIdState
        ? {
            ...projectIdState,
            stateName: STATE_NAMES[projectIdState.stateId ?? ""] || projectIdState.stateId,
          }
        : null,
      isConfirmed: orderIdState.stateId === "-3" || projectIdState?.stateId === "-3",
      verdict:
        orderIdState.stateId === "-3" || projectIdState?.stateId === "-3"
          ? "OK — project in Confirmation"
          : orderId !== projectId
            ? `BUG — orderId≠projectId (offset ${projectId ? BigInt(projectId) - BigInt(orderId) : "?"}), ` +
              `neither in Confirmation (orderId=${orderIdState.stateId}, projectId=${projectIdState?.stateId})`
            : `BUG — state is ${orderIdState.stateId} (${STATE_NAMES[orderIdState.stateId ?? ""] || "?"}), not Confirmation`,
    };

    await redis.lpush("bmi:api:log", JSON.stringify(logEntry));
    await redis.ltrim("bmi:api:log", 0, 4999);

    console.log(
      `[post-confirm-verify] ${wNumber} orderId=${orderId} projectId=${projectId || "same"} ` +
        `offset=${logEntry.offset || "0"} state=${projectIdState?.stateId || orderIdState.stateId} → ${logEntry.isConfirmed ? "OK" : "BUG"}`,
    );
  } catch (err) {
    console.error("[post-confirm-verify] failed:", err);
  }
}

// ── Redis keys ───────────────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = "bmi:confirmed:";
const REDIS_TTL = 86400 * 7; // 7 days

interface ConfirmResult {
  reservationNumber: string;
  reservationCode: string;
  orderId: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const billId: string = body.billId;
    const amount: number = body.amount ?? 0;
    const clientKey: string = body.clientKey || "headpinzftmyers";
    const depositKind: number = body.depositKind ?? (amount === 0 ? 2 : 0);

    if (!billId) {
      return NextResponse.json({ error: "billId required" }, { status: 400 });
    }
    if (!ALLOWED_CLIENTS.has(clientKey)) {
      return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    }

    // ── Idempotency check: already confirmed? ─────────────────────────
    const redisKey = `${REDIS_KEY_PREFIX}${billId}`;
    try {
      const cached = await redis.get(redisKey);
      if (cached) {
        const result: ConfirmResult = JSON.parse(cached);
        console.log(
          `[booking/confirm] CACHED ${result.reservationNumber} for bill ${billId} — skipping BMI call`,
        );

        // Log the skip to the API audit trail
        await redis.lpush(
          "bmi:api:log",
          JSON.stringify({
            endpoint: "booking/confirm (cached)",
            timestamp: new Date().toISOString(),
            clientKey,
            httpStatus: 200,
            orderId: billId,
            wNumber: result.reservationNumber,
            cached: true,
          }),
        );
        await redis.ltrim("bmi:api:log", 0, 4999);

        return NextResponse.json({ ...result, alreadyConfirmed: true });
      }
    } catch {
      // Redis down — proceed to BMI (better to risk a double-call than fail)
    }

    // ── Call BMI payment/confirm ──────────────────────────────────────
    const token = await getBmiToken(clientKey);
    const paymentTime = new Date().toISOString();
    const bmiBody = `{"id":"${randomUUID()}","paymentTime":"${paymentTime}","amount":${amount},"orderId":${billId},"depositKind":${depositKind}}`;

    const bmiUrl = `${BMI_API_URL}/public-booking/${clientKey}/payment/confirm`;
    console.log(`[booking/confirm] → ${bmiUrl}`);

    const bmiRes = await fetch(bmiUrl, {
      method: "POST",
      headers: bmiHeaders(token),
      body: bmiBody,
      cache: "no-store",
    });

    const rawText = await bmiRes.text();
    console.log(`[booking/confirm] ← ${bmiRes.status} ${rawText.substring(0, 300)}`);

    // Log to Redis audit trail
    try {
      await redis.lpush(
        "bmi:api:log",
        JSON.stringify({
          endpoint: "booking/confirm (server)",
          timestamp: new Date().toISOString(),
          clientKey,
          httpStatus: bmiRes.status,
          orderId: billId,
          wNumber: rawText.match(/"reservationNumber"\s*:\s*"(W\d+)"/)?.[1] || null,
          depositKind,
          amount,
          request: bmiBody,
          response: rawText.substring(0, 1000),
        }),
      );
      await redis.ltrim("bmi:api:log", 0, 4999);
    } catch {
      // Non-fatal
    }

    if (!bmiRes.ok) {
      return NextResponse.json(
        { error: `BMI payment/confirm failed: ${bmiRes.status}` },
        { status: 502 },
      );
    }

    // Extract results — use regex on raw text for bigint safety
    const resNumMatch = rawText.match(/"reservationNumber"\s*:\s*"(W\d+)"/);
    const resCodeMatch = rawText.match(/"reservationCode"\s*:\s*"([^"]+)"/);
    const statusMatch = rawText.match(/"status"\s*:\s*(\d+)/);
    const bmiStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    const reservationNumber = resNumMatch?.[1] || "";
    const reservationCode = resCodeMatch?.[1] || `r${billId}`;

    if (!reservationNumber) {
      return NextResponse.json(
        { error: "BMI returned no reservationNumber", bmiStatus, raw: rawText.substring(0, 300) },
        { status: 502 },
      );
    }

    const result: ConfirmResult = {
      reservationNumber,
      reservationCode,
      orderId: billId,
    };

    // ── Cache the result so subsequent calls are idempotent ───────────
    try {
      await redis.set(redisKey, JSON.stringify(result), "EX", REDIS_TTL);
    } catch {
      // Redis down — confirmation still succeeded, just won't be cached
    }

    console.log(
      `[booking/confirm] OK ${reservationNumber} for bill ${billId} (bmiStatus=${bmiStatus})`,
    );

    // Verify project state via BMI's own Office API — 2s delay for BMI internal propagation
    await new Promise((r) => setTimeout(r, 2000));
    await verifyPostConfirm(clientKey, billId, reservationNumber);

    return NextResponse.json({ ...result, alreadyConfirmed: false });
  } catch (err) {
    console.error("[booking/confirm] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Confirm failed" },
      { status: 500 },
    );
  }
}
