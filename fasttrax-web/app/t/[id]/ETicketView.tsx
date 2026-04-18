"use client";

import { useEffect, useState } from "react";
import type { RaceTicket } from "@/lib/race-tickets";

interface Props {
  ticket: RaceTicket;
  initialCheckingIn: boolean;
}

const TRACK_COLORS: Record<string, string> = {
  red: "#E53935",
  blue: "#004AAD",
  mega: "#8B5CF6",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

function minutesUntil(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.round((then - now) / 60_000);
}

export default function ETicketView({ ticket, initialCheckingIn }: Props) {
  const [checkingIn, setCheckingIn] = useState(initialCheckingIn);
  const mins = minutesUntil(ticket.scheduledStart);

  // Past state: heat ran > 30 min ago
  const isPast = mins < -30;

  // Poll Pandora every 20s so the view flips automatically if the user
  // leaves the page open from pre-race into check-in.
  useEffect(() => {
    if (isPast) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/pandora/races-current", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        const key = ticket.track.toLowerCase() as "blue" | "red" | "mega";
        // sessionId can be string or number depending on which Pandora endpoint
        // populated the ticket. Normalize for comparison.
        const matches = String(d?.[key]?.sessionId ?? "") === String(ticket.sessionId ?? "");
        if (!cancelled) setCheckingIn(matches);
      } catch { /* silent */ }
    }
    const id = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticket.sessionId, ticket.track, isPast]);

  const trackColor = TRACK_COLORS[ticket.track.toLowerCase()] || "#00E2E5";
  const badgeText = `${ticket.track} ${ticket.raceType} ${ticket.heatNumber}`;
  const fullName = `${ticket.firstName} ${ticket.lastName}`.trim();

  return (
    <div className="min-h-screen bg-[#010A20] flex items-center justify-center p-4">
      <style>{`
        @keyframes ticketPulse {
          0%, 100% { box-shadow: 0 0 20px rgba(228,28,29,0.35), 0 0 40px rgba(228,28,29,0.15); }
          50% { box-shadow: 0 0 32px rgba(228,28,29,0.6), 0 0 64px rgba(228,28,29,0.28); }
        }
      `}</style>

      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">E-Ticket</p>
        </div>

        {isPast ? <PastCard ticket={ticket} /> : checkingIn ? (
          <CheckingInCard ticket={ticket} fullName={fullName} trackColor={trackColor} badgeText={badgeText} />
        ) : (
          <PreRaceCard ticket={ticket} fullName={fullName} trackColor={trackColor} badgeText={badgeText} mins={mins} />
        )}

        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">14501 Global Parkway, Fort Myers, FL 33913</p>
          <p className="text-white/20 text-[11px] mt-1">Show this screen at check-in · No paper ticket needed</p>
        </div>
      </div>
    </div>
  );
}

function CheckingInCard({
  ticket,
  fullName,
  trackColor,
  badgeText,
}: {
  ticket: RaceTicket;
  fullName: string;
  trackColor: string;
  badgeText: string;
}) {
  return (
    <div
      className="rounded-2xl overflow-hidden border-2"
      style={{
        borderColor: "#E41C1D",
        animation: "ticketPulse 2.4s ease-in-out infinite",
        background: "linear-gradient(135deg, rgba(228,28,29,0.14), rgba(228,28,29,0.03))",
      }}
    >
      {/* Red urgent banner */}
      <div className="px-4 py-3 animate-pulse" style={{ backgroundColor: "rgba(228,28,29,0.22)", borderBottom: "1px solid rgba(228,28,29,0.55)" }}>
        <p className="font-bold uppercase tracking-wider text-center" style={{ fontSize: "clamp(14px, 2.5vw, 18px)", color: "#ff6b6b" }}>
          ⚠ Your Heat Is Being Called — Check In Now
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}50` }}
          >
            {badgeText}
          </span>
        </div>

        <p className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(30px, 8vw, 56px)" }}>
          {fullName}
        </p>

        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: "#ff6b6b" }}>Race Time</p>
          <p className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(40px, 12vw, 72px)" }}>
            {formatTime(ticket.scheduledStart)}
          </p>
        </div>

        {/* Check-in directions — clear + prominent */}
        <div className="mt-6 rounded-xl px-4 py-4" style={{ backgroundColor: "rgba(228,28,29,0.12)", border: "1px solid rgba(228,28,29,0.4)" }}>
          <p className="font-bold text-white uppercase tracking-wider mb-1" style={{ fontSize: "clamp(13px, 2vw, 16px)" }}>
            Head to Karting Check-In
          </p>
          <p className="text-white/80 text-sm">1st Floor · Karting Counter</p>
          <p className="text-white/50 text-xs mt-1">Check in immediately — your heat is being staged now.</p>
        </div>

        <p className="text-white/40 text-xs mt-5">{formatDate(ticket.scheduledStart)}</p>
        {ticket.resNumber && (
          <p className="font-bold text-xs mt-1" style={{ color: "rgba(255,107,107,0.6)" }}>{ticket.resNumber}</p>
        )}
      </div>
    </div>
  );
}

function PreRaceCard({
  ticket,
  fullName,
  trackColor,
  badgeText,
  mins,
}: {
  ticket: RaceTicket;
  fullName: string;
  trackColor: string;
  badgeText: string;
  mins: number;
}) {
  const startsInText =
    mins <= 0 ? "Starting soon" : mins < 60 ? `Starts in ${mins} min` : `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`;

  return (
    <div
      className="rounded-2xl overflow-hidden border border-[#00E2E5]/40 bg-white/[0.03]"
      style={{ boxShadow: "0 0 24px rgba(0,226,229,0.1)" }}
    >
      <div className="bg-[#00E2E5]/10 border-b border-[#00E2E5]/30 px-4 py-3">
        <p className="text-[#00E2E5] font-bold uppercase tracking-wider text-center" style={{ fontSize: "clamp(12px, 2vw, 14px)" }}>
          E-Ticket · {startsInText}
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}50` }}
          >
            {badgeText}
          </span>
        </div>

        <p className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(30px, 8vw, 56px)" }}>
          {fullName}
        </p>

        <div className="mt-5">
          <p className="text-[#00E2E5]/80 text-xs font-bold uppercase tracking-wider mb-1">Race Time</p>
          <p className="text-white font-display uppercase tracking-wider leading-none" style={{ fontSize: "clamp(40px, 12vw, 72px)" }}>
            {formatTime(ticket.scheduledStart)}
          </p>
          <p className="text-white/50 text-xs mt-2">{formatDate(ticket.scheduledStart)}</p>
        </div>

        <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-white/60 text-xs leading-relaxed">
          Save this page or screenshot it. This is your e-ticket — <strong className="text-white/80">show this screen at check-in</strong>. We&apos;ll notify you when your heat is called.
        </div>

        {ticket.resNumber && (
          <p className="text-[#00E2E5]/50 font-bold text-xs mt-4">{ticket.resNumber}</p>
        )}
      </div>
    </div>
  );
}

function PastCard({ ticket }: { ticket: RaceTicket }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Session Complete</p>
      <p className="text-white font-display uppercase tracking-wider text-2xl mb-2">
        {ticket.firstName}&apos;s {ticket.raceType} Race
      </p>
      <p className="text-white/50 text-sm">
        {formatDate(ticket.scheduledStart)} · {formatTime(ticket.scheduledStart)}
      </p>
      <p className="text-white/30 text-xs mt-4">Your heat has already run. Check your email for results.</p>
    </div>
  );
}
