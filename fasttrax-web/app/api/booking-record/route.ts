import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

const TTL = 60 * 60 * 24 * 90; // 90 days
const API_KEY = process.env.BOOKING_API_KEY || "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

/** Validate API key for external access. Internal calls (from our own app) skip auth. */
function requireAuth(req: NextRequest): NextResponse | null {
  const referer = req.headers.get("referer") || "";
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  // Allow internal calls from our own app (same origin)
  if (referer.includes(host) || origin.includes(host)) return null;
  // External calls require API key
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("apiKey");
  if (!key || key !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized — provide x-api-key header" }, { status: 401 });
  }
  return null;
}

/**
 * Comprehensive booking record storage for check-in system.
 *
 * POST — Save/update a booking record (keyed by billId)
 * GET ?billId=X — Retrieve a booking record by billId
 * GET ?resNumber=X — Retrieve by reservation number (reverse index)
 * GET ?personId=X — Retrieve all bookings for a person
 * PATCH — Update fields on an existing record (e.g. add reservation number after payment)
 *
 * Redis keys:
 *   bookingrecord:{billId} — Full JSON record (90-day TTL)
 *   bookingrecord:res:{resNumber} — Reverse index → billId
 *   bookingrecord:person:{personId} — SET of billIds for this person
 *   bookingrecord:date:{YYYY-MM-DD} — SET of billIds for this date
 *   bookingrecord:express:session:{sessionId} — SET of billIds for this Pandora
 *     session (only populated when fastLane===true and racer has a sessionId).
 *     Used by the checkin-alerts cron to notify express-lane holders who bypass
 *     Pandora's Guest Services check-in.
 */

type RecordRacer = { sessionId?: string | number | null } & Record<string, unknown>;

/**
 * When fastLane===true, index each racer's sessionId → billId so the checkin
 * cron can reach express-lane holders who aren't on Pandora's session roster.
 */
async function writeExpressSessionIndex(
  record: { fastLane?: boolean; racers?: RecordRacer[] },
  billId: string,
): Promise<void> {
  if (record.fastLane !== true || !Array.isArray(record.racers)) return;
  const seen = new Set<string>();
  for (const racer of record.racers) {
    const sid = racer.sessionId;
    if (sid === undefined || sid === null || sid === "") continue;
    const key = `bookingrecord:express:session:${sid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await redis.sadd(key, billId);
    await redis.expire(key, TTL);
  }
}

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { billId } = data;
    if (!billId) {
      return NextResponse.json({ error: "billId required" }, { status: 400 });
    }

    // Store the full record
    await redis.set(`bookingrecord:${billId}`, JSON.stringify(data), "EX", TTL);

    // Create reverse indexes
    if (data.date) {
      await redis.sadd(`bookingrecord:date:${data.date}`, billId);
      await redis.expire(`bookingrecord:date:${data.date}`, TTL);
    }

    // Index by personId for each racer
    if (data.racers && Array.isArray(data.racers)) {
      for (const racer of data.racers) {
        if (racer.personId) {
          await redis.sadd(`bookingrecord:person:${racer.personId}`, billId);
          await redis.expire(`bookingrecord:person:${racer.personId}`, TTL);
        }
      }
    }

    // Index by primary personId
    if (data.primaryPersonId) {
      await redis.sadd(`bookingrecord:person:${data.primaryPersonId}`, billId);
      await redis.expire(`bookingrecord:person:${data.primaryPersonId}`, TTL);
    }

    await writeExpressSessionIndex(data, billId);

    console.log(`[booking-record] saved billId=${billId} racers=${data.racers?.length || 0}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[booking-record] POST error:", err);
    return NextResponse.json({ error: "Failed to store" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const updates = await req.json();
    const { billId } = updates;
    if (!billId) {
      return NextResponse.json({ error: "billId required" }, { status: 400 });
    }

    // Get existing record
    const existing = await redis.get(`bookingrecord:${billId}`);
    if (!existing) {
      return NextResponse.json({ error: "Record not found" }, { status: 404 });
    }

    const record = JSON.parse(existing);

    // Merge updates
    const updated = { ...record, ...updates, updatedAt: new Date().toISOString() };
    await redis.set(`bookingrecord:${billId}`, JSON.stringify(updated), "EX", TTL);

    // Create reservation number reverse index if added
    if (updates.reservationNumber) {
      await redis.set(`bookingrecord:res:${updates.reservationNumber}`, billId, "EX", TTL);
    }

    await writeExpressSessionIndex(updated, billId);

    console.log(`[booking-record] updated billId=${billId} fields=${Object.keys(updates).join(",")}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[booking-record] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authErr = requireAuth(req);
  if (authErr) return authErr;

  try {
    const { searchParams } = new URL(req.url);
    const billId = searchParams.get("billId");
    const resNumber = searchParams.get("resNumber");
    const personId = searchParams.get("personId");
    const date = searchParams.get("date");

    // Lookup by billId
    if (billId) {
      const data = await redis.get(`bookingrecord:${billId}`);
      if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(JSON.parse(data));
    }

    // Lookup by reservation number
    if (resNumber) {
      const bid = await redis.get(`bookingrecord:res:${resNumber}`);
      if (!bid) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const data = await redis.get(`bookingrecord:${bid}`);
      if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(JSON.parse(data));
    }

    // Lookup by personId — returns array of records
    if (personId) {
      const billIds = await redis.smembers(`bookingrecord:person:${personId}`);
      const records = [];
      for (const bid of billIds) {
        const data = await redis.get(`bookingrecord:${bid}`);
        if (data) records.push(JSON.parse(data));
      }
      return NextResponse.json(records);
    }

    // Lookup by date — returns array of records
    if (date) {
      const billIds = await redis.smembers(`bookingrecord:date:${date}`);
      const records = [];
      for (const bid of billIds) {
        const data = await redis.get(`bookingrecord:${bid}`);
        if (data) records.push(JSON.parse(data));
      }
      return NextResponse.json(records);
    }

    return NextResponse.json({ error: "Provide billId, resNumber, personId, or date" }, { status: 400 });
  } catch (err) {
    console.error("[booking-record] GET error:", err);
    return NextResponse.json({ error: "Failed to retrieve" }, { status: 500 });
  }
}
