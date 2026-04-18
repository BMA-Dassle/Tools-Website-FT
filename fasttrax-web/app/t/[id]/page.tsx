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
  if (!ticket) return { title: "E-Ticket — FastTrax" };
  return {
    title: `${ticket.firstName}'s ${ticket.raceType} Race — FastTrax E-Ticket`,
    robots: { index: false, follow: false },
  };
}

export default async function ETicketPage({ params }: PageProps) {
  const { id } = await params;
  const ticket = await getRaceTicket(id);
  if (!ticket) notFound();

  // Fetch live Pandora state once for initial render. Client component
  // polls on top of this so the view flips automatically.
  const initialCheckingIn = await isCurrentlyCheckingIn(ticket);

  return <ETicketView ticket={ticket} initialCheckingIn={initialCheckingIn} />;
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
    return data?.[key]?.sessionId === ticket.sessionId;
  } catch {
    return false;
  }
}
