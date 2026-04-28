import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { getGroupTicket, type GroupTicket } from "@/lib/race-tickets";
import GroupETicketView, { type MemberInitialState } from "./GroupETicketView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const group = await getGroupTicket(id);
  if (!group) {
    return {
      title: "E-Ticket — FastTrax",
      description: "Your FastTrax e-ticket",
      openGraph: { title: "E-Ticket — FastTrax", description: "Your FastTrax e-ticket", siteName: "FastTrax E-Ticket" },
      twitter: { card: "summary" as const, title: "E-Ticket — FastTrax", description: "Your FastTrax e-ticket" },
    };
  }
  const count = group.members.length;
  const distinctHeats = new Set(group.members.map((m) => String(m.sessionId))).size;
  const title = `${count} Racers — FastTrax E-Ticket`;
  const description = `${count} racer${count === 1 ? "" : "s"} · ${distinctHeats} heat${distinctHeats === 1 ? "" : "s"} · Show this screen at check-in.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: "FastTrax E-Ticket", type: "website" as const },
    twitter: { card: "summary" as const, title, description },
  };
}

/**
 * Server render path is intentionally Redis-only — no Pandora.
 *
 * Earlier we awaited 1× `races-current` + N× `session-participants`
 * (one per distinct session in the group) before sending any HTML.
 * For a 4-racer group across 2 heats that's 5 blocking Pandora calls
 * — cumulative 3-5s on a typical evening, longer on edge sessions
 * that 500. The page couldn't paint a single byte until the slowest
 * call resolved, the dominant source of "the e-ticket takes forever
 * to open" SMS tap-to-paint latency.
 *
 * The client view (`GroupETicketView`) already polls those exact
 * endpoints every 20s via `useVisibleInterval`, which fires
 * immediately on mount — live state arrives within ~200ms of
 * hydration anyway.
 *
 * Redis-only `wasSessionCalled` lookups are kept (fast, ~10-30ms
 * each) so recently-finished sessions render `PastCard`
 * immediately instead of flashing `PreRaceCard` first.
 */
export default async function GroupETicketPage({ params }: PageProps) {
  const { id } = await params;
  const group = await getGroupTicket(id);
  if (!group) notFound();

  // Redis-only per-session called/alerted lookups in parallel.
  // Pandora calls (races-current, session-participants) are deferred
  // to the client poll — see the comment block above.
  const distinctSessions = Array.from(new Set(group.members.map((m) => String(m.sessionId))));
  const calledBySession = await Promise.all(
    distinctSessions.map(async (sid) => ({ sid, wasCalled: await wasSessionCalled(sid) })),
  );
  const calledMap = new Map<string, boolean>();
  for (const c of calledBySession) calledMap.set(c.sid, c.wasCalled);

  const initial: Record<string, MemberInitialState> = {};
  for (const m of group.members) {
    const key = memberKey(m);
    initial[key] = {
      // Optimistic defaults — the client poll flips these to live
      // Pandora state within ~200ms of hydration. Same reasoning as
      // the single-ticket page — see /t/[id]/page.tsx comment.
      checkingIn: false,
      onSession: true,
      wasCalled: calledMap.get(String(m.sessionId)) || false,
    };
  }

  return <GroupETicketView group={group} initial={initial} />;
}

async function wasSessionCalled(sessionId: string): Promise<boolean> {
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

function memberKey(m: Pick<GroupTicket["members"][number], "sessionId" | "personId">): string {
  return `${m.sessionId}:${m.personId}`;
}
