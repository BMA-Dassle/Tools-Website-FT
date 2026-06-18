import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { verifyConfirmToken } from "@/lib/healthnet-almost-here";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/**
 * Record a guest's preference for resolving a detected schedule conflict
 * (e.g. "earlier-race" / "later-activity" / "keep") + an optional note of who
 * they're trying to stay with. Record-only — staff does the actual rebook; the
 * admin roster surfaces the choice + note.
 */
const TTL = 60 * 60 * 24 * 30;
const rsvpKey = (slug: string, email: string) => `groupevent:${slug}:rsvp:${email.toLowerCase()}`;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const slug: string = body.slug;
    const token: string = body.token;
    const choice: string = String(body.choice || "").slice(0, 40);
    const stayWith: string = String(body.stayWith || "")
      .trim()
      .slice(0, 500);

    if (!slug || !token || !choice) {
      return NextResponse.json({ error: "slug, token, choice required" }, { status: 400 });
    }
    if (!getGroupEvent(slug))
      return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const email = verifyConfirmToken(token);
    if (!email)
      return NextResponse.json({ error: "This link is invalid or expired." }, { status: 401 });

    const raw = await redis.get(rsvpKey(slug, email));
    if (!raw) return NextResponse.json({ error: "We couldn't find your RSVP." }, { status: 404 });
    const record = JSON.parse(raw) as GroupEventRsvp;

    record.conflictResolution = choice;
    record.conflictStayWith = stayWith || undefined;
    record.conflictResolvedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    await redis.set(rsvpKey(slug, email), JSON.stringify(record), "EX", TTL);

    console.log(
      `[group-conflict] ${email} resolution=${choice} stayWith=${stayWith ? "yes" : "no"}`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[group-conflict] POST error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
