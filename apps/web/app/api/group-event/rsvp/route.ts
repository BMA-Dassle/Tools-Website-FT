import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";

const TTL = 60 * 60 * 24 * 30; // 30 days

/**
 * Free-flow RSVP tracking for group events.
 *
 * Redis key: groupevent:{slug}:rsvp:{email}
 * Type: STRING (JSON)
 * Value: { name, email, freeflow: string[], reservations: object[], updatedAt }
 *
 * GET  ?slug=...             → all RSVPs for event (admin view)
 * GET  ?slug=...&email=...   → single guest's RSVP (returning guest)
 * POST { slug, email, name, freeflow: string[], reservations?: object[] } → upsert
 */

function rsvpKey(slug: string, email: string): string {
  return `groupevent:${slug}:rsvp:${email.toLowerCase()}`;
}

/** Index key — SET of all emails that RSVP'd for this event */
function rsvpIndexKey(slug: string): string {
  return `groupevent:${slug}:rsvp-index`;
}

export interface GroupEventReservation {
  type: string;
  track?: string;
  time?: string;
  billId?: string;
}

export interface GroupEventRsvp {
  name: string;
  email: string;
  freeflow: string[];
  reservations: GroupEventReservation[];
  /** BMI person ID — preserved across cancels so waiver link survives rebook */
  personId?: string;
  /** Chosen venue for multi-location events (e.g. "fort-myers" | "naples"). */
  location?: string;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const event = getGroupEvent(slug);
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const email = searchParams.get("email");

  // Single guest lookup
  if (email) {
    const data = await redis.get(rsvpKey(slug, email));
    if (!data) return NextResponse.json(null);
    return NextResponse.json(JSON.parse(data) as GroupEventRsvp);
  }

  // All RSVPs for event (admin)
  const emails = await redis.smembers(rsvpIndexKey(slug));
  const rsvps: GroupEventRsvp[] = [];
  for (const e of emails) {
    const data = await redis.get(rsvpKey(slug, e));
    if (data) rsvps.push(JSON.parse(data));
  }

  return NextResponse.json({ rsvps, count: rsvps.length });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { slug, email, name, freeflow = [], reservations, personId, location } = body;
    if (!slug || !email || !name) {
      return NextResponse.json({ error: "slug, email, name required" }, { status: 400 });
    }

    const event = getGroupEvent(slug);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // Merge with existing data (preserve existing reservations if not provided)
    const existing = await redis.get(rsvpKey(slug, email));
    const prev: Partial<GroupEventRsvp> = existing ? JSON.parse(existing) : {};

    const record: GroupEventRsvp = {
      name,
      email: email.toLowerCase(),
      freeflow,
      reservations: reservations ?? prev.reservations ?? [],
      // Preserve personId — survives cancel + rebook so waiver status persists
      personId: personId || prev.personId,
      location: location || prev.location,
      updatedAt: new Date().toISOString(),
    };

    const key = rsvpKey(slug, email);
    await redis.set(key, JSON.stringify(record), "EX", TTL);

    // Add to index
    await redis.sadd(rsvpIndexKey(slug), email.toLowerCase());
    await redis.expire(rsvpIndexKey(slug), TTL);

    console.log(
      `[group-rsvp] upserted ${name} (${email}) location=${location ?? "-"} freeflow=[${freeflow.join(",")}]`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[group-rsvp] POST error:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
