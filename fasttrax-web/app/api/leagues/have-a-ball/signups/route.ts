import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Have-A-Ball league signup records.
 *
 * POST /api/leagues/have-a-ball/signups
 *   Body: { subscriptionId, customerId, firstName, lastName, email, phone, dob, teamName?, smsOptIn? }
 *   Stores the signup in Redis under league:haveaball:signup:{subscriptionId} with 1-year TTL.
 *
 * GET /api/leagues/have-a-ball/signups
 *   Requires x-api-key header. Returns the full list for admin use.
 */

const TTL = 60 * 60 * 24 * 365; // 1 year
const API_KEY = process.env.BOOKING_API_KEY || "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";
const INDEX_KEY = "league:haveaball:all";

function keyFor(subscriptionId: string) {
  return `league:haveaball:signup:${subscriptionId}`;
}

function requireAuth(req: NextRequest): NextResponse | null {
  const referer = req.headers.get("referer") || "";
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  // Same-origin calls OK
  if (referer.includes(host) || origin.includes(host)) return null;
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("apiKey");
  if (!key || key !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { subscriptionId } = body as { subscriptionId?: string };
    if (!subscriptionId) {
      return NextResponse.json({ error: "subscriptionId required" }, { status: 400 });
    }

    const record = { ...body, signedUpAt: new Date().toISOString() };
    await redis.set(keyFor(subscriptionId), JSON.stringify(record), "EX", TTL);
    await redis.zadd(INDEX_KEY, Date.now(), subscriptionId);
    await redis.expire(INDEX_KEY, TTL);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[have-a-ball signups] POST error:", err);
    return NextResponse.json({ error: "Failed to store signup" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authErr = requireAuth(req);
  if (authErr) return authErr;

  try {
    const { searchParams } = new URL(req.url);
    const subId = searchParams.get("subscriptionId");
    if (subId) {
      const raw = await redis.get(keyFor(subId));
      if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(JSON.parse(raw));
    }

    // List all — newest first
    const ids = await redis.zrevrange(INDEX_KEY, 0, -1);
    const records = [];
    for (const id of ids) {
      const raw = await redis.get(keyFor(id));
      if (raw) records.push(JSON.parse(raw));
    }
    return NextResponse.json({ count: records.length, records });
  } catch (err) {
    console.error("[have-a-ball signups] GET error:", err);
    return NextResponse.json({ error: "Failed to retrieve" }, { status: 500 });
  }
}
