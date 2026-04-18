"use client";

import { useEffect, useState } from "react";
import type { RaceTicket } from "@/lib/race-tickets";
import TrackStatus from "@/components/home/TrackStatus";
import {
  CheckingInCard,
  InvalidCard,
  PastCard,
  PreRaceCard,
  TICKET_PULSE_CSS,
  minutesUntil,
} from "./cards";

interface Props {
  ticket: RaceTicket;
  initialCheckingIn: boolean;
  initialOnSession: boolean;
  initialWasCalled: boolean;
}

export default function ETicketView({ ticket, initialCheckingIn, initialOnSession, initialWasCalled }: Props) {
  const [checkingIn, setCheckingIn] = useState(initialCheckingIn);
  const [onSession, setOnSession] = useState(initialOnSession);
  // wasCalled is monotonic (false → true only) once the checkin cron flags
  // this session. `ever` tracks both the SSR value and any live observation.
  const [wasCalled, setWasCalled] = useState(initialWasCalled || initialCheckingIn);

  const mins = minutesUntil(ticket.scheduledStart);
  // Hard fallback for tickets viewed long after the heat with no called signal.
  const longPast = mins < -90;
  // Primary past-state trigger: race was called and is no longer currently checking in.
  const dropped = wasCalled && !checkingIn;
  const isPast = longPast || dropped;

  // Poll Pandora every 20s: races-current (for checking-in flip) AND
  // session-participants (to catch staff-removed racers). Also refresh
  // wasCalled from /api/race-session-state in case the cron flagged it
  // while the page was open.
  useEffect(() => {
    if (longPast) return;
    let cancelled = false;

    async function poll() {
      try {
        const [currentRes, partRes, stateRes] = await Promise.all([
          fetch("/api/pandora/races-current", { cache: "no-store" }),
          fetch(
            `/api/pandora/session-participants?locationId=${encodeURIComponent(ticket.locationId)}&sessionId=${encodeURIComponent(String(ticket.sessionId))}`,
            { cache: "no-store" },
          ),
          fetch(`/api/race-session-state?sessionId=${encodeURIComponent(String(ticket.sessionId))}`, { cache: "no-store" }),
        ]);
        if (currentRes.ok) {
          const d = await currentRes.json();
          const key = ticket.track.toLowerCase() as "blue" | "red" | "mega";
          const matches = String(d?.[key]?.sessionId ?? "") === String(ticket.sessionId ?? "");
          if (!cancelled) {
            setCheckingIn(matches);
            if (matches) setWasCalled(true);
          }
        }
        if (partRes.ok) {
          const d = await partRes.json();
          const list = Array.isArray(d?.data) ? d.data : [];
          // Ignore empty responses (Pandora 500s look empty to us) — don't flip valid→invalid on a spurious zero.
          if (list.length > 0) {
            const target = String(ticket.personId);
            const stillOn = list.some((p: { personId: string | number }) => String(p.personId) === target);
            if (!cancelled) setOnSession(stillOn);
          }
        }
        if (stateRes.ok) {
          const d = await stateRes.json();
          if (!cancelled && d?.wasCalled) setWasCalled(true);
        }
      } catch { /* silent */ }
    }
    const id = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticket.sessionId, ticket.track, ticket.locationId, ticket.personId, longPast]);

  return (
    <div className="min-h-screen bg-[#010A20] flex items-center justify-center p-4">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">E-Ticket</p>
        </div>

        {!onSession && !isPast ? (
          <InvalidCard details={ticket} />
        ) : isPast ? (
          <PastCard details={ticket} />
        ) : checkingIn ? (
          <CheckingInCard details={ticket} />
        ) : (
          <PreRaceCard details={ticket} />
        )}

        <div className="mt-6">
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
