import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SMS_BASE = "https://booking-api22.sms-timing.com/api";
const CLIENT_KEY = "headpinzftmyers";
const ACCESS_TOKEN = process.env.SMS_ACCESS_TOKEN || "82ombpyojpnllypblbk";
const SMS_VERSION = "6251006 202511051229";

function smsHeaders(sessionId?: string) {
  return {
    "x-fast-accesstoken": ACCESS_TOKEN,
    "x-fast-version": SMS_VERSION,
    "x-session-id": sessionId || randomUUID(),
    "accept": "application/json",
    "content-type": "application/json",
  };
}

async function smsGet(path: string, sessionId?: string) {
  return fetch(`${SMS_BASE}/${path}/${CLIENT_KEY}`, {
    headers: smsHeaders(sessionId),
    cache: "no-store",
  });
}

async function smsPost(path: string, body: unknown, sessionId?: string) {
  return fetch(`${SMS_BASE}/${path}/${CLIENT_KEY}`, {
    method: "POST",
    headers: smsHeaders(sessionId),
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

async function smsPostQS(path: string, qs: string, sessionId?: string) {
  return fetch(`${SMS_BASE}/${path}/${CLIENT_KEY}?${qs}`, {
    method: "POST",
    headers: smsHeaders(sessionId),
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
  const sessionId = req.headers.get("x-booking-session") || randomUUID();

  if (!endpoint || !ALLOWED_ENDPOINTS.includes(endpoint)) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  // ── DAY PLANNER ──────────────────────────────────────────────────────────
  if (endpoint === "dayplanner/calendarrange") {
    const { dateFrom, dateUntil, ...rest } = body;
    const qs = new URLSearchParams();
    if (dateFrom) qs.set("dateFrom", dateFrom);
    if (dateUntil) qs.set("dateUntil", dateUntil);
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?${qs.toString()}`,
      { method: "POST", headers: smsHeaders(sessionId), body: JSON.stringify(rest) }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "dayplanner/dayplanner") {
    const { date, ...rest } = body;
    const qs = date ? `date=${encodeURIComponent(date)}` : "";
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?${qs}`,
      { method: "POST", headers: smsHeaders(sessionId), body: JSON.stringify(rest) }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── BOOKING ──────────────────────────────────────────────────────────────
  if (endpoint === "booking/book") {
    const upstream = await smsPost(endpoint, body, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "booking/sell") {
    // body is an array
    const upstream = await smsPost(endpoint, body, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  // ── BILL ─────────────────────────────────────────────────────────────────
  if (endpoint === "bill/overview") {
    const { billId } = body;
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?billId=${billId}`,
      { headers: smsHeaders(sessionId), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── RESERVATION ───────────────────────────────────────────────────────────
  // Guest checkout: register contact person without login/OTP
  if (endpoint === "reservation/registercontactperson") {
    const upstream = await smsPost(endpoint, body, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  // ── PAYMENT ───────────────────────────────────────────────────────────────
  if (endpoint === "payment/needtopay") {
    const { billId } = body;
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?billId=${billId}`,
      { headers: smsHeaders(sessionId), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "payment/start") {
    const { billId } = body;
    const qs = `billId=${billId}&requestInvoice=false`;
    const upstream = await smsPostQS(endpoint, qs, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "genericpaymentprocessor") {
    const upstream = await smsPost(endpoint, body, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  if (endpoint === "payment/process") {
    const upstream = await smsPost(endpoint, body, sessionId);
    const data = await upstream.json();
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: "Unknown error" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");
  const billId = searchParams.get("billId");
  const sessionId = req.headers.get("x-booking-session") || randomUUID();

  if (endpoint === "bill/overview" && billId) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?billId=${billId}`,
      { headers: smsHeaders(sessionId), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  if (endpoint === "payment/needtopay" && billId) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?billId=${billId}`,
      { headers: smsHeaders(sessionId), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  // ── PRODUCT CATALOG ─────────────────────────────────────────────────────
  const date = searchParams.get("date");
  if (endpoint === "page" && date) {
    const upstream = await fetch(
      `${SMS_BASE}/${endpoint}/${CLIENT_KEY}?date=${encodeURIComponent(date)}`,
      { headers: smsHeaders(sessionId), cache: "no-store" }
    );
    return NextResponse.json(await upstream.json());
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
