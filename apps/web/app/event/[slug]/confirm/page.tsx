import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { verifyConfirmToken, reservationSummary } from "@/lib/healthnet-almost-here";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import ConfirmClient from "./ConfirmClient";

/**
 * Guest-facing "confirm you're coming + give us your mobile" page.
 *
 * Reached from the one-time "almost here" email via a signed token (?t=...).
 * Verifies the token → loads the guest's RSVP → lets them submit a phone, which
 * the confirm API saves to the RSVP AND PATCHes onto their BMI person record.
 *
 * URL: /event/{slug}/confirm?t={token}
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string }>;
};

const EVENT_DATE_LONG = "Friday, June 19, 2026";
const EVENT_TIME = "9:00 AM – 2:00 PM";
const EVENT_VENUE = "HeadPinz Fort Myers";

export default async function Page({ params, searchParams }: Props) {
  const { slug } = await params;
  const { t } = await searchParams;

  const event = getGroupEvent(slug);
  if (!event) notFound();

  const email = t ? verifyConfirmToken(t) : null;
  const accent = event.accentColor || "#00E2E5";

  // Bad/missing token → friendly fallback (no enumeration).
  if (!email) {
    return (
      <ConfirmClient
        slug={slug}
        token={t ?? ""}
        invalid
        accent={accent}
        eventTitle={event.eventTitle}
        dateLabel={`${EVENT_DATE_LONG} · ${EVENT_TIME} · ${EVENT_VENUE}`}
        firstName=""
        schedule={[]}
        hasReservations={false}
        existingPhone=""
      />
    );
  }

  const raw = await redis.get(`groupevent:${slug}:rsvp:${email.toLowerCase()}`);
  const rsvp = raw ? (JSON.parse(raw) as GroupEventRsvp) : null;
  const schedule = rsvp ? reservationSummary(rsvp) : [];
  const firstName = (rsvp?.name || "").trim().split(/\s+/)[0] || "";

  return (
    <ConfirmClient
      slug={slug}
      token={t ?? ""}
      invalid={!rsvp}
      accent={accent}
      eventTitle={event.eventTitle}
      dateLabel={`${EVENT_DATE_LONG} · ${EVENT_TIME} · ${EVENT_VENUE}`}
      firstName={firstName}
      schedule={schedule}
      hasReservations={schedule.length > 0}
      existingPhone={rsvp?.phone ?? ""}
    />
  );
}
