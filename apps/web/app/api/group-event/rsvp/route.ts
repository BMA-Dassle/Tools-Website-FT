import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import type { GroupEvent } from "@/lib/group-events";

/** HeadPinz sender DID for the RSVP confirmation SMS. */
const HEADPINZ_DID = "+12393022155";

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

/** Phone → email lookup key, so a guest can find their RSVP by phone. */
function rsvpPhoneKey(slug: string, phone: string): string {
  return `groupevent:${slug}:phone:${phone.replace(/\D/g, "")}`;
}

/** Build the RSVP confirmation SMS — date/time, arrival venue, race info if booked. */
function buildRsvpSmsBody(event: GroupEvent, record: GroupEventRsvp): string {
  const loc = event.landing?.locations?.find((l) => l.key === record.location);
  const racing = !!loc?.racing;
  const brand = racing ? "HeadPinz & FastTrax" : "HeadPinz";
  const venue = loc?.venue ?? event.companyName;
  const addr = loc?.address ?? "";
  const time = event.landing?.eventTime ?? `${event.startTime}–${event.endTime}`;
  const dateStr = loc
    ? new Date(loc.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "";
  const race = record.reservations?.find((r) => r.type === "racing");
  let tail: string;
  if (race) {
    let raceTime = "";
    const tp = race.time?.replace(/Z$/, "").split("T")[1];
    if (tp) {
      const [h, m] = tp.split(":").map(Number);
      const hr = ((h + 11) % 12) + 1;
      raceTime = ` ~${hr}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    }
    tail = ` Your race:${race.track ? ` ${race.track} Track` : ""}${raceTime}. The evening starts at HeadPinz Fort Myers — we'll walk you to FastTrax in groups.`;
  } else {
    tail = " Includes 2 drink tickets, buffet & complimentary bowling.";
  }
  return `${brand}: You're confirmed for ${event.eventTitle}! ${dateStr}, ${time} at ${venue}, ${addr}.${tail} Reply STOP to opt out.`;
}

/**
 * Send the RSVP confirmation SMS once per guest (opt-in only). Deduped via a
 * Redis flag so re-upserts (cancel, freeflow toggle, re-book) don't re-text.
 * Never throws — SMS failure must not fail the RSVP.
 */
async function maybeSendRsvpSms(slug: string, event: GroupEvent, record: GroupEventRsvp) {
  if (!record.smsConsent || !record.phone || !event.landing) return;
  const flagKey = `groupevent:${slug}:rsvp-sms:${record.email}`;
  if (await redis.get(flagKey)) return;
  const to = record.phone.length === 10 ? `+1${record.phone}` : `+${record.phone}`;
  const body = buildRsvpSmsBody(event, record);
  try {
    const { voxSend } = await import("@/lib/sms-retry");
    const { logSms } = await import("@/lib/sms-log");
    const result = await voxSend(to, body, { fromOverride: HEADPINZ_DID });
    if (result.ok) await redis.set(flagKey, "1", "EX", TTL);
    await logSms({
      ts: new Date().toISOString(),
      phone: to,
      source: "group-event-rsvp",
      status: result.status,
      ok: !!result.ok,
      body,
      provider: result.provider,
      failedOver: result.failedOver,
      providerMessageId: result.voxId || result.twilioSid,
    }).catch(() => void 0);
  } catch (err) {
    console.error("[group-rsvp] SMS send failed:", err);
  }
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
  /** Company name — collected on the "just attending" RSVP (business-leader event). */
  company?: string;
  /** Party size on a "just attending" RSVP (1–2). */
  guests?: number;
  /** Phone (digits only) — collected from every guest. */
  phone?: string;
  /** Guest opted in to SMS (e-tickets / updates). */
  smsConsent?: boolean;
  /** Set when the guest completes the "almost here" check-in/confirm flow. */
  confirmedAt?: string;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const event = getGroupEvent(slug);
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const email = searchParams.get("email");
  const phone = searchParams.get("phone");

  // Single guest lookup by email
  if (email) {
    const data = await redis.get(rsvpKey(slug, email));
    if (!data) return NextResponse.json(null);
    return NextResponse.json(JSON.parse(data) as GroupEventRsvp);
  }

  // Single guest lookup by phone (resolve to email via the phone index)
  if (phone) {
    const resolvedEmail = await redis.get(rsvpPhoneKey(slug, phone));
    if (!resolvedEmail) return NextResponse.json(null);
    const data = await redis.get(rsvpKey(slug, resolvedEmail));
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
    const {
      slug,
      email,
      name,
      freeflow = [],
      reservations,
      personId,
      location,
      company,
      guests,
    } = body;
    const phone: string | undefined = body.phone
      ? String(body.phone).replace(/\D/g, "")
      : undefined;
    const smsConsent: boolean | undefined =
      typeof body.smsConsent === "boolean" ? body.smsConsent : undefined;
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
      company: company || prev.company,
      guests: typeof guests === "number" ? guests : prev.guests,
      phone: phone || prev.phone,
      smsConsent: typeof smsConsent === "boolean" ? smsConsent : prev.smsConsent,
      updatedAt: new Date().toISOString(),
    };

    const key = rsvpKey(slug, email);
    await redis.set(key, JSON.stringify(record), "EX", TTL);

    // Add to index
    await redis.sadd(rsvpIndexKey(slug), email.toLowerCase());
    await redis.expire(rsvpIndexKey(slug), TTL);

    // Phone → email index for lookup-by-phone
    if (record.phone) {
      await redis.set(rsvpPhoneKey(slug, record.phone), email.toLowerCase(), "EX", TTL);
    }

    // Fire the confirmation SMS (opt-in only, deduped, non-blocking).
    await maybeSendRsvpSms(slug, event, record);

    console.log(
      `[group-rsvp] upserted ${name} (${email}) location=${location ?? "-"} freeflow=[${freeflow.join(",")}]`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[group-rsvp] POST error:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
