import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { signConfirmToken, reservationSummary } from "@/lib/healthnet-almost-here";
import { conflictBundle } from "@/lib/healthnet-conflicts";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/**
 * Check-in by email — for the short /healthnet link a coworker visits when they
 * don't have the tokenized email link. Given an email that IS on the roster, we
 * mint the same signed confirm token server-side and return their schedule, so
 * the confirm page can drop straight into the phone-capture step. Emails NOT on
 * the roster get {ok:false} (no enumeration of who's invited).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const slug: string = body.slug;
    const email: string = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!slug || !email || !email.includes("@")) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    if (!getGroupEvent(slug)) return NextResponse.json({ ok: false }, { status: 404 });

    const raw = await redis.get(`groupevent:${slug}:rsvp:${email}`);
    if (!raw) return NextResponse.json({ ok: false });
    const rsvp = JSON.parse(raw) as GroupEventRsvp;

    const schedule = reservationSummary(rsvp);
    return NextResponse.json({
      ok: true,
      token: signConfirmToken(email),
      firstName: (rsvp.name || "").trim().split(/\s+/)[0] || "",
      schedule,
      hasReservations: schedule.length > 0,
      existingPhone: rsvp.phone || "",
      // Already fully checked in (phone + confirm done) → confirm page can skip
      // straight to the "You're all set" screen instead of re-asking.
      confirmed: !!(rsvp.phone && rsvp.confirmedAt),
      conflict: conflictBundle(rsvp),
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
