import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const CONNECTION_INFO_URL = "https://backend.sms-timing.com/api/connectioninfo/encrypted";
const ENCRYPTED_CLIENT = "U2FsdGVkX18rw9HVQvtJrdeGZNAVakzC08J8Ij8PZNI%3D";
const DEFAULT_CLIENT_KEY = "headpinzftmyers";
const ALLOWED_SMS_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);
const SMS_VERSION = "6251006 202511051229";

// ── Auto-renewing SMS-Timing token ──────────────────────────────────────────
let cachedSmsToken: string | null = process.env.SMS_ACCESS_TOKEN || null;
let smsTokenExpiry = 0;

async function getSmsToken(): Promise<string> {
  // Cache for 1 hour — connectioninfo always returns the current valid token
  if (cachedSmsToken && Date.now() < smsTokenExpiry) return cachedSmsToken;

  try {
    const res = await fetch(
      `${CONNECTION_INFO_URL}?message=${ENCRYPTED_CLIENT}&locationType=3&type=booking`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const data = await res.json();
      cachedSmsToken = data.AccessToken;
      smsTokenExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
      return cachedSmsToken!;
    }
  } catch {
    // Fall through to cached/hardcoded
  }

  return cachedSmsToken || "32ombpyioiipibppmll";
}

const SMS_BASE = "https://booking-api22.sms-timing.com/api";

function smsHeaders(sessionId?: string, token?: string) {
  return {
    "x-fast-accesstoken": token || cachedSmsToken || "32ombpyioiipibppmll",
    "x-fast-version": SMS_VERSION,
    "x-session-id": sessionId || randomUUID(),
    "accept": "application/json",
    "content-type": "application/json",
  };
}

async function smsGet(path: string, sessionId?: string, clientKey = DEFAULT_CLIENT_KEY) {
  const token = await getSmsToken();
  return fetch(`${SMS_BASE}/${path}/${clientKey}`, {
    headers: smsHeaders(sessionId, token),
    cache: "no-store",
  });
}

async function smsPost(path: string, body: unknown, sessionId?: string, clientKey = DEFAULT_CLIENT_KEY) {
  const token = await getSmsToken();
  return fetch(`${SMS_BASE}/${path}/${clientKey}`, {
    method: "POST",
    headers: smsHeaders(sessionId, token),
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

async function smsPostQS(path: string, qs: string, sessionId?: string, clientKey = DEFAULT_CLIENT_KEY) {
  const token = await getSmsToken();
  return fetch(`${SMS_BASE}/${path}/${clientKey}?${qs}`, {
    method: "POST",
    headers: smsHeaders(sessionId, token),
    cache: "no-store",
  });
}

const ALLOWED_ENDPOINTS = [
  "dayplanner/calendarrange",
  "dayplanner/dayplanner",
  "booking/book",
  "booking/sell",
  "bill/overview",
  "reservation/registercontactperson",
  "payment/needtopay",
  "payment/start",
  "payment/process",
  "genericpaymentprocessor",
];

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");
  const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
  const sessionId = req.headers.get("x-booking-session") || randomUUID();

  if (!endpoint || !ALLOWED_ENDPOINTS.includes(endpoint)) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }
  if (!ALLOWED_SMS_CLIENTS.has(clientKey)) {
    return NextResponse.json({ error: "Invalid client" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  // ── DAY PLANNER ──────────────────────────────────────────────────────────
  const token = await getSmsToken();

  if (endpoint === "dayplanner/calendarrange") {
    const { dateFrom, dateUntil, ...rest } = body;
    const qs = new URLSearchParams();
    if (dateFrom) qs.set("dateFrom", dateFrom);
    if (dateUntil) qs.set("dateUntil", dateUntil);
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?${qs.toString()}`,
      { method: "POST", headers: smsHeaders(sessionId, token), body: JSON.stringify(rest) }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "dayplanner/dayplanner") {
    const { date, ...rest } = body;
    const qs = date ? `date=${encodeURIComponent(date)}` : "";
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?${qs}`,
      { method: "POST", headers: smsHeaders(sessionId, token), body: JSON.stringify(rest) }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── BOOKING ──────────────────────────────────────────────────────────────
  if (endpoint === "booking/book") {
    const upstream = await smsPost(endpoint, body, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "booking/sell") {
    const upstream = await smsPost(endpoint, body, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  // ── BILL ─────────────────────────────────────────────────────────────────
  if (endpoint === "bill/overview") {
    const { billId } = body;
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?billId=${billId}`,
      { headers: smsHeaders(sessionId, token), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── RESERVATION ───────────────────────────────────────────────────────────
  if (endpoint === "reservation/registercontactperson") {
    const upstream = await smsPost(endpoint, body, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  // ── PAYMENT ───────────────────────────────────────────────────────────────
  if (endpoint === "payment/needtopay") {
    const { billId } = body;
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?billId=${billId}`,
      { headers: smsHeaders(sessionId, token), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "payment/start") {
    const { billId } = body;
    const qs = `billId=${billId}&requestInvoice=false`;
    const upstream = await smsPostQS(endpoint, qs, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "genericpaymentprocessor") {
    const upstream = await smsPost(endpoint, body, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "payment/process") {
    const upstream = await smsPost(endpoint, body, sessionId, clientKey);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: "Unknown error" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");
  const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
  const billId = searchParams.get("billId");
  const sessionId = req.headers.get("x-booking-session") || randomUUID();
  if (!ALLOWED_SMS_CLIENTS.has(clientKey)) return NextResponse.json({ error: "Invalid client" }, { status: 403 });
  const token = await getSmsToken();

  if (endpoint === "bill/overview" && billId) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?billId=${billId}`,
      { headers: smsHeaders(sessionId, token), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "payment/needtopay" && billId) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?billId=${billId}`,
      { headers: smsHeaders(sessionId, token), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── PRODUCT CATALOG ─────────────────────────────────────────────────────
  const date = searchParams.get("date");
  if (endpoint === "page" && date) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${clientKey}?date=${encodeURIComponent(date)}`,
      { headers: smsHeaders(sessionId, token), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
