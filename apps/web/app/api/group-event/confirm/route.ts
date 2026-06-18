import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { verifyConfirmToken } from "@/lib/healthnet-almost-here";
import { patchBmiPersonPhone } from "@/lib/bmi-person-update";
import { signWaiverDigital, WAIVER_TERMS_VERSION } from "@/lib/waiver-digital";
import { logWaiverAcceptance } from "@/lib/waiver-acceptance";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/** Reservation types that require a signed waiver. */
const WAIVER_GATED = ["racing", "gel-blaster", "laser-tag"];

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
    const waiverAccept: boolean = body.waiverAccept === true;

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

    // 3. Waiver: if the guest accepted and has a waiver-gated reservation,
    //    record the digital acceptance (Postgres audit) and push the
    //    "Digitally Accepted" mark to BMI via Pandora. Best-effort — a failure
    //    here must never block the phone confirmation.
    let waiverPushed: boolean | undefined;
    const hasGated = (record.reservations || []).some((r) => WAIVER_GATED.includes(r.type));
    if (waiverAccept && record.personId && hasGated) {
      const ipAddress =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        "unknown";
      const userAgent = req.headers.get("user-agent") || "";
      let waiverId: string | undefined;
      try {
        const r = await signWaiverDigital({
          personId: record.personId,
          name: record.name || "",
          locationKey: event.pandoraLocation ?? "headpinz",
          skipIfValid: true,
        });
        waiverPushed = r.ok;
        waiverId = r.waiverID || undefined;
      } catch (err) {
        waiverPushed = false;
        console.error(
          `[group-confirm] waiver push FAILED slug=${slug} email=${email} personId=${record.personId} err=${err instanceof Error ? err.message : err}`,
        );
      }
      // Always log the acceptance — our retained, attributable record (IP / UA /
      // timestamp / terms version) stands even if the BMI push fails.
      await logWaiverAcceptance({
        ts: new Date().toISOString(),
        ipAddress,
        userAgent,
        termsVersion: WAIVER_TERMS_VERSION,
        email,
        phone,
        firstName: (record.name || "").trim().split(/\s+/)[0] || undefined,
        personId: record.personId,
        waiverId,
        method: "checkbox",
        eventSlug: slug,
      });
    }

    console.log(
      `[group-confirm] ${email} confirmed slug=${slug} phone=***${phone.slice(-4)} smsConsent=${smsConsent} bmiSynced=${bmiSynced} waiverPushed=${waiverPushed}`,
    );
    return NextResponse.json({ ok: true, bmiSynced, waiverPushed });
  } catch (err) {
    console.error("[group-confirm] POST error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
