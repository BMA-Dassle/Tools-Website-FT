import { notFound } from "next/navigation";
import { getRaceTicket, type RaceTicket } from "@/lib/race-tickets";
import ETicketView from "./ETicketView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const ticket = await getRaceTicket(id);
  if (!ticket) {
    return {
      title: "E-Ticket — FastTrax",
      description: "Your FastTrax e-ticket",
      openGraph: { title: "E-Ticket — FastTrax", description: "Your FastTrax e-ticket", siteName: "FastTrax E-Ticket" },
      twitter: { card: "summary" as const, title: "E-Ticket — FastTrax", description: "Your FastTrax e-ticket" },
    };
  }
  const title = `${ticket.firstName}'s ${ticket.raceType} Race — FastTrax E-Ticket`;
  const description = `Heat ${ticket.heatNumber} · ${ticket.track} ${ticket.raceType} · Show this screen at check-in.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: "FastTrax E-Ticket", type: "website" as const },
    twitter: { card: "summary" as const, title, description },
  };
}

export default async function ETicketPage({ params }: PageProps) {
  const { id } = await params;
  const ticket = await getRaceTicket(id);
  if (!ticket) notFound();

  const [initialCheckingIn, stillOnSession] = await Promise.all([
    isCurrentlyCheckingIn(ticket),
    isStillOnSession(ticket),
  ]);

  return (
    <ETicketView
      ticket={ticket}
      initialCheckingIn={initialCheckingIn}
      initialOnSession={stillOnSession}
    />
  );
}

async function isCurrentlyCheckingIn(ticket: RaceTicket): Promise<boolean> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
    const res = await fetch(`${base}/api/pandora/races-current`, { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      blue?: { sessionId?: number } | null;
      red?: { sessionId?: number } | null;
      mega?: { sessionId?: number } | null;
    };
    const key = ticket.track.toLowerCase() as "blue" | "red" | "mega";
    return String(data?.[key]?.sessionId ?? "") === String(ticket.sessionId ?? "");
  } catch {
    return false;
  }
}

/**
 * Ticket is still valid if the holder is currently in the session's
 * participants list. If staff removes them from the session, this returns
 * false and the ticket page renders the "no longer valid" state.
 *
 * We only check when the session isn't far in the past — once the heat
 * has run we don't care; it's just history at that point.
 */
async function isStillOnSession(ticket: RaceTicket): Promise<boolean> {
  try {
    const scheduled = new Date(ticket.scheduledStart).getTime();
    // Don't bother checking well-past sessions — past view is shown regardless.
    if (!isNaN(scheduled) && scheduled < Date.now() - 45 * 60_000) return true;

    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
    const qs = new URLSearchParams({
      locationId: ticket.locationId,
      sessionId: String(ticket.sessionId),
    }).toString();
    const res = await fetch(`${base}/api/pandora/session-participants?${qs}`, { cache: "no-store" });
    if (!res.ok) {
      // Pandora 500s on empty/edge sessions — don't flag as invalid on a bad read.
      return true;
    }
    const data = await res.json();
    const participants = Array.isArray(data?.data) ? data.data : [];
    // If Pandora returned zero, it's likely their validator error — trust the
    // existing ticket rather than invalidating on a potentially spurious empty.
    if (participants.length === 0) return true;
    const target = String(ticket.personId);
    return participants.some((p: { personId: string | number }) => String(p.personId) === target);
  } catch {
    return true;
  }
}
