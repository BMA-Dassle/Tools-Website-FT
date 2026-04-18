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
}

export default function ETicketView({ ticket, initialCheckingIn, initialOnSession }: Props) {
  const [checkingIn, setCheckingIn] = useState(initialCheckingIn);
  const [onSession, setOnSession] = useState(initialOnSession);
  const mins = minutesUntil(ticket.scheduledStart);

  // Past state: heat ran > 30 min ago
  const isPast = mins < -30;

  // Poll Pandora every 20s: races-current (for checking-in flip) AND
  // session-participants (to catch staff-removed racers).
  useEffect(() => {
    if (isPast) return;
    let cancelled = false;

    async function poll() {
      try {
        const [currentRes, partRes] = await Promise.all([
          fetch("/api/pandora/races-current", { cache: "no-store" }),
          fetch(
            `/api/pandora/session-participants?locationId=${encodeURIComponent(ticket.locationId)}&sessionId=${encodeURIComponent(String(ticket.sessionId))}`,
            { cache: "no-store" },
          ),
        ]);
        if (currentRes.ok) {
          const d = await currentRes.json();
          const key = ticket.track.toLowerCase() as "blue" | "red" | "mega";
          const matches = String(d?.[key]?.sessionId ?? "") === String(ticket.sessionId ?? "");
          if (!cancelled) setCheckingIn(matches);
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
      } catch { /* silent */ }
    }
    const id = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticket.sessionId, ticket.track, ticket.locationId, ticket.personId, isPast]);

  return (
    <div className="min-h-screen bg-[#010A20] flex items-center justify-center p-4">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">E-Ticket</p>
        </div>

        {!onSession && !isPast ? (
          <InvalidCard />
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
