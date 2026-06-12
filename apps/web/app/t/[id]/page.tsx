import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { getRaceTicket } from "@/lib/race-tickets";
import ETicketView from "./ETicketView";
import ArenaETicketView from "~/components/features/arena-tickets/ArenaETicketView";
import { isArenaTicket } from "~/features/arena-tickets/types";
import { FASTTRAX_OG, HEADPINZ_OG } from "@/lib/seo";

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
      openGraph: {
        title: "E-Ticket — FastTrax",
        description: "Your FastTrax e-ticket",
        siteName: "FastTrax E-Ticket",
        images: [...FASTTRAX_OG],
      },
      twitter: {
        card: "summary" as const,
        title: "E-Ticket — FastTrax",
        description: "Your FastTrax e-ticket",
      },
    };
  }
  // HP Arena tickets get HeadPinz-branded metadata; brand comes from
  // the ticket record, not the host (the /t route serves both domains).
  if (isArenaTicket(ticket)) {
    const title = `${ticket.firstName}'s ${ticket.track} Session — HP Arena E-Ticket`;
    const description = `${ticket.track} · Session ${ticket.heatNumber} · Show this screen at the HP Arena desk.`;
    return {
      title,
      description,
      robots: { index: false, follow: false },
      openGraph: {
        title,
        description,
        siteName: "HP Arena E-Ticket",
        type: "website" as const,
        images: [...HEADPINZ_OG],
      },
      twitter: { card: "summary" as const, title, description },
    };
  }
  const title = `${ticket.firstName}'s ${ticket.raceType} Race — FastTrax E-Ticket`;
  const description = `Heat ${ticket.heatNumber} · ${ticket.track} ${ticket.raceType} · Show this screen at check-in.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      siteName: "FastTrax E-Ticket",
      type: "website" as const,
      images: [...FASTTRAX_OG],
    },
    twitter: { card: "summary" as const, title, description },
  };
}

/**
 * Server render path is intentionally Redis-only — no Pandora.
 *
 * Earlier we awaited Pandora's `races-current` and
 * `session-participants` here so the first paint had accurate
 * `checkingIn` / `onSession` state. Pandora is the slowest dependency
 * in the stack (typical 1-3s, occasional 5s+ on edge sessions) and
 * the page couldn't send a single byte until both calls resolved —
 * the dominant source of "the e-ticket takes forever to open" SMS
 * tap-to-paint latency.
 *
 * The client view (`ETicketView`) already polls those exact two
 * endpoints every 20s via `useVisibleInterval`, which fires
 * immediately on mount. So the live state arrives within ~200ms of
 * hydration anyway. Trade-off accepted: tickets viewed RIGHT after a
 * race is called or a racer is removed mid-heat may flash
 * `PreRaceCard` for ~1s before the poll updates them — vs. multi-
 * second blank screens for everyone else.
 *
 * The Redis-only `wasSessionCalled` lookup is kept (it's fast,
 * ~10-30ms) so recently-finished tickets render `PastCard`
 * immediately instead of flashing `PreRaceCard` first.
 */
export default async function ETicketPage({ params }: PageProps) {
  const { id } = await params;
  const ticket = await getRaceTicket(id);
  if (!ticket) notFound();

  // HP Arena tickets render their own HeadPinz-branded view — no
  // races-current / wasCalled SSR seed needed (arena state flips on
  // BMI checkedIn + time; see ArenaETicketView).
  if (isArenaTicket(ticket)) {
    return <ArenaETicketView ticket={ticket} />;
  }

  const wasCalled = await wasSessionCalled(ticket.sessionId);

  return (
    <ETicketView
      ticket={ticket}
      // Optimistic defaults — the client poll flips these to live
      // Pandora state within ~200ms of hydration. `onSession: true`
      // matches the historic forgiving behavior (don't flag invalid
      // on missing data); `checkingIn: false` is the dominant case
      // (most tickets aren't being actively checked in this second).
      initialCheckingIn={false}
      initialOnSession={true}
      initialWasCalled={wasCalled}
    />
  );
}

async function wasSessionCalled(sessionId: number | string): Promise<boolean> {
  try {
    const [called, alerted] = await Promise.all([
      redis.get(`race:called:${sessionId}`),
      redis.get(`alert:checkin:session:${sessionId}`),
    ]);
    return !!called || !!alerted;
  } catch {
    return false;
  }
}
