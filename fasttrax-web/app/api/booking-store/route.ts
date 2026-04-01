import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

const TTL = 60 * 60 * 24; // 24 hours

/**
 * Store and retrieve booking details in Redis.
 * Used to persist booking info across the Square payment redirect,
 * since BMI clears order details after payment/confirm converts to reservation.
 *
 * GET ?billId=XXX  → retrieve stored booking details
 * POST { billId, ... } → store booking details
 */

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { billId, ...details } = data;
    if (!billId) {
      return NextResponse.json({ error: "billId required" }, { status: 400 });
    }
    await redis.set(`booking:${billId}`, JSON.stringify(details), "EX", TTL);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[booking-store] POST error:", err);
    return NextResponse.json({ error: "Failed to store" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const billId = new URL(req.url).searchParams.get("billId");
    if (!billId) {
      return NextResponse.json({ error: "billId required" }, { status: 400 });
    }
    const data = await redis.get(`booking:${billId}`);
    if (!data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(JSON.parse(data));
  } catch (err) {
    console.error("[booking-store] GET error:", err);
    return NextResponse.json({ error: "Failed to retrieve" }, { status: 500 });
  }
}
