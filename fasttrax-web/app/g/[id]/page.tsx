import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import { getGroupTicket, type GroupTicket, type GroupTicketMember } from "@/lib/race-tickets";
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

export default async function GroupETicketPage({ params }: PageProps) {
  const { id } = await params;
  const group = await getGroupTicket(id);
  if (!group) notFound();

  // Resolve per-session state in parallel (dedupe distinct sessions).
  const distinctSessions = Array.from(new Set(group.members.map((m) => String(m.sessionId))));
  const [racesCurrent, participantsBySession, calledBySession] = await Promise.all([
    fetchRacesCurrent(),
    Promise.all(
      distinctSessions.map(async (sid) => ({
        sid,
        personIds: await fetchSessionPersonIds(group.locationId, sid),
      })),
    ),
    Promise.all(distinctSessions.map(async (sid) => ({ sid, wasCalled: await wasSessionCalled(sid) }))),
  ]);
  const partMap = new Map<string, Set<string>>();
  for (const p of participantsBySession) partMap.set(p.sid, p.personIds);
  const calledMap = new Map<string, boolean>();
  for (const c of calledBySession) calledMap.set(c.sid, c.wasCalled);

  const initial: Record<string, MemberInitialState> = {};
  for (const m of group.members) {
    const key = memberKey(m);
    initial[key] = {
      checkingIn: isCheckingIn(racesCurrent, m),
      onSession: isStillOn(partMap.get(String(m.sessionId)), m),
      wasCalled: calledMap.get(String(m.sessionId)) || false,
    };
  }

  return <GroupETicketView group={group} initial={initial} />;
}

async function wasSessionCalled(sessionId: string): Promise<boolean> {
  try {
    const v = await redis.get(`race:called:${sessionId}`);
    return !!v;
  } catch {
    return false;
  }
}

interface RacesCurrent {
  blue?: { sessionId?: number | string } | null;
  red?: { sessionId?: number | string } | null;
  mega?: { sessionId?: number | string } | null;
}

async function fetchRacesCurrent(): Promise<RacesCurrent> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
    const res = await fetch(`${base}/api/pandora/races-current`, { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as RacesCurrent;
  } catch {
    return {};
  }
}

/**
 * Returns the set of personIds currently on a session, or null if Pandora was
 * unreachable / returned empty. Null means "don't flag anyone as removed"
 * (consistent with the single-ticket view's forgiving behavior).
 */
async function fetchSessionPersonIds(locationId: string, sessionId: string): Promise<Set<string>> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
    const qs = new URLSearchParams({ locationId, sessionId }).toString();
    const res = await fetch(`${base}/api/pandora/session-participants?${qs}`, { cache: "no-store" });
    if (!res.ok) return new Set();
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return new Set(list.map((p: { personId: string | number }) => String(p.personId)));
  } catch {
    return new Set();
  }
}

function isCheckingIn(current: RacesCurrent, m: GroupTicketMember): boolean {
  const key = m.track.toLowerCase() as "blue" | "red" | "mega";
  return String(current?.[key]?.sessionId ?? "") === String(m.sessionId ?? "");
}

function isStillOn(ids: Set<string> | undefined, m: GroupTicketMember): boolean {
  // Don't invalidate on unreadable / empty — only when we have a non-empty
  // roster that definitely excludes the person.
  if (!ids || ids.size === 0) return true;
  const scheduled = new Date(m.scheduledStart).getTime();
  if (!isNaN(scheduled) && scheduled < Date.now() - 45 * 60_000) return true;
  return ids.has(String(m.personId));
}

function memberKey(m: Pick<GroupTicket["members"][number], "sessionId" | "personId">): string {
  return `${m.sessionId}:${m.personId}`;
}
