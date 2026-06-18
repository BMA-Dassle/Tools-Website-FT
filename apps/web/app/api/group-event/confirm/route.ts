import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { verifyConfirmToken } from "@/lib/healthnet-almost-here";
import { patchBmiPersonPhone } from "@/lib/bmi-person-update";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/**
 * Group-event "confirm attendance + capture phone" endpoint.
 *
 * Driven by the one-time "your event is almost here" email: the guest taps a
 * signed link, lands on /event/{slug}/confirm, and submits their mobile number.
 *
 * On submit we:
 *   1. Save the phone + SMS consent onto their Redis RSVP record (+ phone index).
 *   2. PATCH the phone onto their existing BMI person record (so the day-of
 *      e-ticket / check-in functions, which read the person record, have it).
 *
 * The phone is the source of truth in BOTH places; a BMI PATCH failure is
 * surfaced (bmiSynced:false) and logged so we can backfill, but never blocks
 * the guest's confirmation.
 */

const TTL = 60 * 60 * 24 * 30; // 30 days

const rsvpKey = (slug: string, email: string) => `groupevent:${slug}:rsvp:${email.toLowerCase()}`;
const rsvpPhoneKey = (slug: string, phone: string) =>
  `groupevent:${slug}:phone:${phone.replace(/\D/g, "")}`;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const slug: string = body.slug;
    const token: string = body.token;
    const phone: string = String(body.phone || "").replace(/\D/g, "");
    const smsConsent: boolean = body.smsConsent !== false; // default opted-in

    if (!slug || !token) {
      return NextResponse.json({ error: "slug and token required" }, { status: 400 });
    }
    if (phone.length < 10) {
      return NextResponse.json({ error: "Please enter a valid mobile number." }, { status: 400 });
    }

    const event = getGroupEvent(slug);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const email = verifyConfirmToken(token);
    if (!email) {
      return NextResponse.json({ error: "This link is invalid or expired." }, { status: 401 });
    }

    const raw = await redis.get(rsvpKey(slug, email));
    if (!raw) {
      return NextResponse.json({ error: "We couldn't find your RSVP." }, { status: 404 });
    }
    const record = JSON.parse(raw) as GroupEventRsvp;

    // 1. Persist phone + consent on the RSVP + stamp the check-in time.
    record.phone = phone;
    record.smsConsent = smsConsent;
    record.updatedAt = new Date().toISOString();
    record.confirmedAt = record.confirmedAt || record.updatedAt; // first check-in wins
    // Schedule-conflict preference is captured on the same form (combined step).
    const conflictChoice = String(body.conflictChoice || "").slice(0, 40);
    if (conflictChoice) {
      record.conflictResolution = conflictChoice;
      record.conflictStayWith =
        String(body.stayWith || "")
          .trim()
          .slice(0, 500) || undefined;
      record.conflictResolvedAt = new Date().toISOString();
    }
    await redis.set(rsvpKey(slug, email), JSON.stringify(record), "EX", TTL);
    await redis.set(rsvpPhoneKey(slug, phone), email.toLowerCase(), "EX", TTL);

    // 2. Write the phone onto the BMI person record (best-effort, never fatal).
    let bmiSynced = false;
    if (record.personId) {
      const [firstName, ...rest] = (record.name || "").trim().split(/\s+/);
      const patch = await patchBmiPersonPhone(record.personId, phone, {
        locationKey: event.pandoraLocation ?? "headpinz",
        firstName: firstName || undefined,
        lastName: rest.join(" ") || undefined,
        email,
      });
      bmiSynced = patch.ok;
      if (!patch.ok) {
        console.error(
          `[group-confirm] BMI phone PATCH FAILED slug=${slug} email=${email} personId=${record.personId} err=${patch.error}`,
        );
      }
    }

    console.log(
      `[group-confirm] ${email} confirmed slug=${slug} phone=***${phone.slice(-4)} smsConsent=${smsConsent} bmiSynced=${bmiSynced}`,
    );
    return NextResponse.json({ ok: true, bmiSynced });
  } catch (err) {
    console.error("[group-confirm] POST error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
