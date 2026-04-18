"use client";

import { useEffect, useState } from "react";
import type { GroupTicket, GroupTicketMember } from "@/lib/race-tickets";
import TrackStatus from "@/components/home/TrackStatus";
import {
  CheckingInCard,
  InvalidCard,
  PastCard,
  PreRaceCard,
  TICKET_PULSE_CSS,
  minutesUntil,
} from "../../t/[id]/cards";

export interface MemberInitialState {
  checkingIn: boolean;
  onSession: boolean;
}

interface Props {
  group: GroupTicket;
  initial: Record<string, MemberInitialState>;
}

interface MemberState {
  checkingIn: boolean;
  onSession: boolean;
}

function memberKey(m: Pick<GroupTicketMember, "sessionId" | "personId">): string {
  return `${m.sessionId}:${m.personId}`;
}

function earliestStart(members: GroupTicketMember[]): number {
  return Math.min(...members.map((m) => new Date(m.scheduledStart).getTime()));
}

export default function GroupETicketView({ group, initial }: Props) {
  const [state, setState] = useState<Record<string, MemberState>>(() => {
    const s: Record<string, MemberState> = {};
    for (const m of group.members) {
      s[memberKey(m)] = initial[memberKey(m)] ?? { checkingIn: false, onSession: true };
    }
    return s;
  });

  // Sort: active heats first (soonest start), past heats last.
  const sortedMembers = [...group.members].sort((a, b) => {
    const ta = new Date(a.scheduledStart).getTime();
    const tb = new Date(b.scheduledStart).getTime();
    return ta - tb;
  });

  // Stop polling once every heat is past by > 30 min.
  const allPast = group.members.every((m) => minutesUntil(m.scheduledStart) < -30);

  useEffect(() => {
    if (allPast) return;
    let cancelled = false;

    const distinctSessions = Array.from(new Set(group.members.map((m) => String(m.sessionId))));

    async function poll() {
      try {
        const [currentRes, ...partResponses] = await Promise.all([
          fetch("/api/pandora/races-current", { cache: "no-store" }),
          ...distinctSessions.map((sid) =>
            fetch(
              `/api/pandora/session-participants?locationId=${encodeURIComponent(group.locationId)}&sessionId=${encodeURIComponent(sid)}`,
              { cache: "no-store" },
            ),
          ),
        ]);

        let current: { blue?: { sessionId?: number | string } | null; red?: { sessionId?: number | string } | null; mega?: { sessionId?: number | string } | null } = {};
        if (currentRes.ok) current = await currentRes.json();

        const rosterBySession = new Map<string, Set<string>>();
        for (let i = 0; i < distinctSessions.length; i++) {
          const sid = distinctSessions[i];
          const res = partResponses[i];
          if (!res.ok) continue;
          const data = await res.json();
          const list = Array.isArray(data?.data) ? data.data : [];
          if (list.length === 0) continue; // trust prior state on empty
          rosterBySession.set(sid, new Set(list.map((p: { personId: string | number }) => String(p.personId))));
        }

        if (cancelled) return;

        setState((prev) => {
          const next: Record<string, MemberState> = { ...prev };
          for (const m of group.members) {
            const key = memberKey(m);
            const trackKey = m.track.toLowerCase() as "blue" | "red" | "mega";
            const checkingIn = String(current?.[trackKey]?.sessionId ?? "") === String(m.sessionId ?? "");
            const roster = rosterBySession.get(String(m.sessionId));
            let onSession = prev[key]?.onSession ?? true;
            if (roster) {
              const scheduled = new Date(m.scheduledStart).getTime();
              if (!isNaN(scheduled) && scheduled < Date.now() - 45 * 60_000) {
                onSession = true;
              } else {
                onSession = roster.has(String(m.personId));
              }
            }
            next[key] = { checkingIn, onSession };
          }
          return next;
        });
      } catch { /* silent */ }
    }

    const id = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [group.locationId, group.members, allPast]);

  const racerCount = group.members.length;
  const distinctHeats = new Set(group.members.map((m) => String(m.sessionId))).size;
  const earliest = earliestStart(group.members);
  const earliestDate = new Date(earliest);
  const dateLabel = isNaN(earliestDate.getTime())
    ? ""
    : earliestDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center p-4 py-8">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">
            {racerCount} Racers · {distinctHeats} Heat{distinctHeats === 1 ? "" : "s"}
          </p>
          {dateLabel && <p className="text-white/30 text-xs mt-1">{dateLabel}</p>}
        </div>

        <div className="space-y-5">
          {sortedMembers.map((m) => {
            const key = memberKey(m);
            const s = state[key] ?? { checkingIn: false, onSession: true };
            const mins = minutesUntil(m.scheduledStart);
            const isPast = mins < -30;
            return (
              <div key={key}>
                {!s.onSession && !isPast ? (
                  <InvalidCard />
                ) : isPast ? (
                  <PastCard details={m} />
                ) : s.checkingIn ? (
                  <CheckingInCard details={m} />
                ) : (
                  <PreRaceCard details={m} />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8">
          <TrackStatus />
        </div>

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">14501 Global Parkway, Fort Myers, FL 33913</p>
          <p className="text-white/20 text-[11px] mt-1">Show this screen at check-in · No paper ticket needed</p>
        </div>
      </div>
    </div>
  );
}
