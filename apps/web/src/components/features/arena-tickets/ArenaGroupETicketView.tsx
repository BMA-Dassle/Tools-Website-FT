"use client";

/**
 * HP Arena group-ticket view — HeadPinz-branded sibling of
 * app/g/[id]/GroupETicketView.tsx, rendered when group.brand is
 * "headpinz". Groups never mix brands (cron buckets are per-brand),
 * so every member here is an arena member.
 *
 * Same state-machine differences vs racing as ArenaETicketView:
 * checkedIn/onSession from the lean participants poll, time-based
 * past state, race-session-state polled as the future called-banner
 * seam, no POV/headsock/TrackStatus, QR gated on ARENA_QR_ENABLED.
 */

import { useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { checkinQrDataUrl } from "@/lib/qr-checkin";
import { modalBackdropProps } from "@/lib/a11y";
import type { GroupTicket, GroupTicketMember } from "@/lib/race-tickets";
import { minutesUntil } from "@/app/t/[id]/cards";
import {
  ARENA_PULSE_CSS,
  ArenaCheckedInCard,
  ArenaInvalidCard,
  ArenaMovedCard,
  ArenaPastCard,
  ArenaPreSessionCard,
} from "./arena-cards";
import ImportantArenaInfo from "./ImportantArenaInfo";
import { ARENA_QR_ENABLED, HP_FM_ADDRESS } from "~/features/arena-tickets/constants";

interface Props {
  group: GroupTicket;
}

interface MemberState {
  onSession: boolean;
  checkedIn: boolean;
}

interface LeanParticipant {
  personId: string | number;
  checkedIn?: string | null;
}

function memberKey(m: Pick<GroupTicketMember, "sessionId" | "personId">): string {
  return `${m.sessionId}:${m.personId}`;
}

function memberQrPayload(
  m: Pick<GroupTicketMember, "sessionId" | "personId" | "participantId">,
  locationId: string,
): string {
  const partId = String(m.participantId ?? "").trim();
  const base = `HP:${locationId}:${m.personId}:${m.sessionId}`;
  return /^\d+$/.test(partId) ? `${base}:${partId}` : base;
}

export default function ArenaGroupETicketView({ group }: Props) {
  const [state, setState] = useState<Record<string, MemberState>>(() => {
    const s: Record<string, MemberState> = {};
    for (const m of group.members) {
      s[memberKey(m)] = { onSession: true, checkedIn: false };
    }
    return s;
  });
  const [calledSessions, setCalledSessions] = useState<Set<string>>(new Set());
  const [qrByMember, setQrByMember] = useState<Record<string, string>>({});
  const [fullscreenQrKey, setFullscreenQrKey] = useState<string | null>(null);
  const qrGenerated = useRef(false);

  const sortedMembers = [...group.members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );

  // Stop polling once every session is 90+ min past.
  const allPast = group.members.every((m) => minutesUntil(m.scheduledStart) < -90);

  const distinctSessions = Array.from(new Set(group.members.map((m) => String(m.sessionId))));
  async function poll(signal: AbortSignal) {
    try {
      const responses = await Promise.all([
        ...distinctSessions.map((sid) =>
          fetch(
            `/api/pandora/session-participants?locationId=${encodeURIComponent(group.locationId)}&sessionId=${encodeURIComponent(sid)}`,
            { cache: "no-store", signal },
          ),
        ),
        ...distinctSessions.map((sid) =>
          fetch(`/api/race-session-state?sessionId=${encodeURIComponent(sid)}`, {
            cache: "no-store",
            signal,
          }),
        ),
      ]);
      if (signal.aborted) return;
      const partResponses = responses.slice(0, distinctSessions.length);
      const stateResponses = responses.slice(distinctSessions.length);

      const rosterBySession = new Map<string, Map<string, LeanParticipant>>();
      for (let i = 0; i < distinctSessions.length; i++) {
        const res = partResponses[i];
        if (!res.ok) continue;
        const data = await res.json();
        const list: LeanParticipant[] = Array.isArray(data?.data) ? data.data : [];
        if (list.length === 0) continue; // trust prior state on empty
        rosterBySession.set(distinctSessions[i], new Map(list.map((p) => [String(p.personId), p])));
      }

      const nowCalled = new Set<string>();
      for (let i = 0; i < distinctSessions.length; i++) {
        const res = stateResponses[i];
        if (!res.ok) continue;
        try {
          const d = await res.json();
          if (d?.wasCalled) nowCalled.add(distinctSessions[i]);
        } catch {
          /* skip */
        }
      }
      if (nowCalled.size > 0) {
        setCalledSessions((prev) => new Set([...prev, ...nowCalled]));
      }

      setState((prev) => {
        const next: Record<string, MemberState> = { ...prev };
        for (const m of group.members) {
          const key = memberKey(m);
          const roster = rosterBySession.get(String(m.sessionId));
          if (!roster) continue;
          const me = roster.get(String(m.personId));
          // Forgiving once the session is well past — roster churn
          // after the fact should never flip a ticket to Invalid.
          const scheduled = new Date(m.scheduledStart).getTime();
          const wellPast = !isNaN(scheduled) && scheduled < Date.now() - 45 * 60_000;
          next[key] = {
            onSession: wellPast ? (prev[key]?.onSession ?? true) : !!me,
            checkedIn: !!me?.checkedIn || (prev[key]?.checkedIn ?? false),
          };
        }
        return next;
      });
    } catch {
      /* transient — silent */
    }
  }
  useVisibleInterval(poll, 30_000, !allPast);

  useEffect(() => {
    if (!ARENA_QR_ENABLED || qrGenerated.current) return;
    qrGenerated.current = true;
    const targets: { key: string; pid: string; sid: string; partId?: string }[] = [];
    for (const m of group.members) {
      const pid = String(m.personId ?? "").trim();
      const sid = String(m.sessionId ?? "").trim();
      if (!pid || !sid || !/^\d+$/.test(pid) || !/^\d+$/.test(sid)) continue;
      const partId = String(m.participantId ?? "").trim();
      targets.push({
        key: memberKey(m),
        pid,
        sid,
        partId: /^\d+$/.test(partId) ? partId : undefined,
      });
    }
    Promise.all(
      targets.map(async (t) => {
        try {
          const url = await checkinQrDataUrl(t.pid, t.sid, t.partId, 160, group.locationId);
          return { key: t.key, url };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      const out: Record<string, string> = {};
      for (const r of results) if (r) out[r.key] = r.url;
      setQrByMember(out);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  const playerCount = group.members.length;
  const distinctCount = distinctSessions.length;
  const earliest = Math.min(...group.members.map((m) => new Date(m.scheduledStart).getTime()));
  const earliestDate = new Date(earliest);
  const dateLabel = isNaN(earliestDate.getTime())
    ? ""
    : earliestDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      });

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center px-4 pt-28 sm:pt-32 pb-8">
      <style>{ARENA_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">HeadPinz</p>
          <p className="text-white/60 text-sm font-semibold">
            {group.recipient === "guardian"
              ? "Your Players' HP Arena E-Tickets"
              : "HP Arena E-Tickets"}
          </p>
          <p className="text-white/40 text-xs mt-0.5">
            {playerCount} Player{playerCount === 1 ? "" : "s"} · {distinctCount} Session
            {distinctCount === 1 ? "" : "s"}
          </p>
          {dateLabel && <p className="text-white/30 text-xs mt-1">{dateLabel}</p>}
          {group.recipient === "guardian" && (
            <p className="text-amber-300/80 text-[11px] mt-2 inline-block px-2 py-0.5 rounded-full border border-amber-300/30 bg-amber-500/10">
              {group.guardianFirstName ? (
                <>
                  Sent to <strong className="text-amber-200">{group.guardianFirstName}</strong>{" "}
                  (parent)
                </>
              ) : (
                <>Sent to your guardian</>
              )}
            </p>
          )}
        </div>

        {!allPast && <ImportantArenaInfo />}

        <div className="space-y-5">
          {sortedMembers.map((m) => {
            const key = memberKey(m);
            const s = state[key] ?? { onSession: true, checkedIn: false };
            const isPast = minutesUntil(m.scheduledStart) < -90;
            const details = {
              firstName: m.firstName,
              lastName: m.lastName,
              scheduledStart: m.scheduledStart,
              track: m.track,
              heatNumber: m.heatNumber,
            };
            const qrBlock = ARENA_QR_ENABLED && s.onSession && qrByMember[key] && (
              <button
                type="button"
                onClick={() => setFullscreenQrKey(key)}
                className="w-full flex flex-col items-center gap-2 py-4 border-t border-white/10 hover:bg-white/5 active:scale-[0.99] transition-all"
              >
                <div className="bg-white rounded-lg p-1.5">
                  <img
                    src={qrByMember[key]}
                    alt={`QR for ${m.firstName}`}
                    data-qr-payload={memberQrPayload(m, group.locationId)}
                    width={100}
                    height={100}
                    className="block"
                  />
                </div>
                <p className="text-white/50 text-xs">Tap to open full screen</p>
              </button>
            );
            return (
              <div key={key}>
                {m.movedTo ? (
                  <ArenaMovedCard details={details} movedTo={m.movedTo} />
                ) : !s.onSession && !isPast ? (
                  <ArenaInvalidCard details={details} />
                ) : isPast ? (
                  <ArenaPastCard details={details} />
                ) : s.checkedIn ? (
                  <ArenaCheckedInCard details={details}>{qrBlock}</ArenaCheckedInCard>
                ) : (
                  <ArenaPreSessionCard
                    details={details}
                    calledNow={calledSessions.has(String(m.sessionId))}
                  >
                    {qrBlock}
                  </ArenaPreSessionCard>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">{HP_FM_ADDRESS}</p>
          <p className="text-white/20 text-[11px] mt-1">
            Please have your e-ticket open and ready at the HP Arena desk
          </p>
        </div>
      </div>

      {fullscreenQrKey &&
        qrByMember[fullscreenQrKey] &&
        (() => {
          const m = group.members.find((mm) => memberKey(mm) === fullscreenQrKey);
          if (!m) return null;
          return (
            <div
              className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center px-6"
              {...modalBackdropProps(() => setFullscreenQrKey(null))}
            >
              <img
                src={qrByMember[fullscreenQrKey]}
                alt="Check-in QR"
                className="block"
                style={{ width: "min(280px, 70vw)", height: "min(280px, 70vw)" }}
              />
              <p className="mt-4 text-black font-bold text-2xl sm:text-3xl text-center">
                {m.firstName} {m.lastName}
              </p>
              <p className="mt-1 text-black/60 text-sm uppercase tracking-wider">
                Scan at the desk
              </p>
              <p className="mt-6 text-black/30 text-xs">Tap anywhere to close</p>
            </div>
          );
        })()}
    </div>
  );
}
