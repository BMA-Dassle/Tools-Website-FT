import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";
import { verifyConfirmToken, reservationSummary } from "@/lib/healthnet-almost-here";
import { conflictBundle } from "@/lib/healthnet-conflicts";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import ConfirmClient from "./ConfirmClient";

/**
 * Guest-facing "confirm you're coming + give us your mobile" / check-in page.
 *
 * Two ways in:
 *  - Tokenized email link (?t=...) → verify → load RSVP → straight to phone step.
 *  - No/expired token (e.g. the short /healthnet link a coworker shares) → the
 *    client asks for an email and looks it up on the roster.
 * Submitting saves the phone to the RSVP AND PATCHes it onto the BMI person.
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

  const accent = event.accentColor || "#00E2E5";
  const dateLabel = `${EVENT_DATE_LONG} · ${EVENT_TIME} · ${EVENT_VENUE}`;

  const email = t ? verifyConfirmToken(t) : null;
  const raw = email ? await redis.get(`groupevent:${slug}:rsvp:${email.toLowerCase()}`) : null;
  const rsvp = raw ? (JSON.parse(raw) as GroupEventRsvp) : null;

  // Tokenized link with a real RSVP → go straight to the phone step.
  // Otherwise (no/expired token, or RSVP not found) → email-entry mode.
  if (rsvp) {
    const schedule = reservationSummary(rsvp);
    return (
      <ConfirmClient
        mode="phone"
        slug={slug}
        token={t ?? ""}
        accent={accent}
        eventTitle={event.eventTitle}
        dateLabel={dateLabel}
        firstName={(rsvp.name || "").trim().split(/\s+/)[0] || ""}
        schedule={schedule}
        hasReservations={schedule.length > 0}
        existingPhone={rsvp.phone ?? ""}
        alreadyConfirmed={!!(rsvp.phone && rsvp.confirmedAt)}
        conflict={conflictBundle(rsvp)}
      />
    );
  }

  return (
    <ConfirmClient
      mode="email"
      slug={slug}
      token=""
      accent={accent}
      eventTitle={event.eventTitle}
      dateLabel={dateLabel}
      firstName=""
      schedule={[]}
      hasReservations={false}
      existingPhone=""
      alreadyConfirmed={false}
      conflict={null}
    />
  );
}
