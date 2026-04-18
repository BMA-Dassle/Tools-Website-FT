"use client";

/**
 * Shared e-ticket card components used by both the single-racer view
 * (/t/{id}) and the grouped family view (/g/{id}).
 *
 * Each card takes a minimal `CardDetails` — the overlap between a single
 * RaceTicket and a GroupTicketMember — so the grouped view can render one
 * card per member without copying RaceTicket's whole shape.
 */

export interface CardDetails {
  firstName: string;
  lastName: string;
  scheduledStart: string;
  track: string;
  raceType: string;
  heatNumber: number;
  resNumber?: string;
}

export const TRACK_COLORS: Record<string, string> = {
  red: "#E53935",
  blue: "#004AAD",
  mega: "#8B5CF6",
};

export function formatTime(iso: string): string {
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

export function formatDate(iso: string): string {
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

export function minutesUntil(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.round((then - now) / 60_000);
}

function badgeFor(d: CardDetails): string {
  return `${d.track} ${d.raceType} ${d.heatNumber}`;
}

function fullNameOf(d: CardDetails): string {
  return `${d.firstName} ${d.lastName}`.trim();
}

function trackColorFor(d: CardDetails): string {
  return TRACK_COLORS[d.track.toLowerCase()] || "#00E2E5";
}

export const TICKET_PULSE_CSS = `
  @keyframes ticketPulse {
    0%, 100% { box-shadow: 0 0 20px rgba(228,28,29,0.35), 0 0 40px rgba(228,28,29,0.15); }
    50% { box-shadow: 0 0 32px rgba(228,28,29,0.6), 0 0 64px rgba(228,28,29,0.28); }
  }
`;

export function CheckingInCard({ details }: { details: CardDetails }) {
  const trackColor = trackColorFor(details);
  return (
    <div
      className="rounded-2xl overflow-hidden border-2"
      style={{
        borderColor: "#E41C1D",
        animation: "ticketPulse 2.4s ease-in-out infinite",
        background: "linear-gradient(135deg, rgba(228,28,29,0.14), rgba(228,28,29,0.03))",
      }}
    >
      <div
        className="px-4 py-3 animate-pulse"
        style={{ backgroundColor: "rgba(228,28,29,0.22)", borderBottom: "1px solid rgba(228,28,29,0.55)" }}
      >
        <p
          className="font-bold uppercase tracking-wider text-center"
          style={{ fontSize: "clamp(14px, 2.5vw, 18px)", color: "#ff6b6b" }}
        >
          ⚠ Your Heat Is Being Called — Check In Now
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}50` }}
          >
            {badgeFor(details)}
          </span>
        </div>

        <p
          className="text-white font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: "#ff6b6b" }}>
            Race Time
          </p>
          <p
            className="text-white font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
        </div>

        <div
          className="mt-6 rounded-xl px-4 py-4"
          style={{ backgroundColor: "rgba(228,28,29,0.12)", border: "1px solid rgba(228,28,29,0.4)" }}
        >
          <p
            className="font-bold text-white uppercase tracking-wider mb-1"
            style={{ fontSize: "clamp(13px, 2vw, 16px)" }}
          >
            Head to Karting Check-In
          </p>
          <p className="text-white/80 text-sm">1st Floor · Karting Counter</p>
          <p className="text-white/50 text-xs mt-1">Check in immediately — your heat is being staged now.</p>
        </div>

        <p className="text-white/40 text-xs mt-5">{formatDate(details.scheduledStart)}</p>
        {details.resNumber && (
          <p className="font-bold text-xs mt-1" style={{ color: "rgba(255,107,107,0.6)" }}>
            {details.resNumber}
          </p>
        )}
      </div>
    </div>
  );
}

export function PreRaceCard({ details }: { details: CardDetails }) {
  const trackColor = trackColorFor(details);
  const mins = minutesUntil(details.scheduledStart);
  const startsInText =
    mins <= 0 ? "Starting soon" : mins < 60 ? `Starts in ${mins} min` : `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`;

  return (
    <div
      className="rounded-2xl overflow-hidden border border-[#00E2E5]/40 bg-white/[0.03]"
      style={{ boxShadow: "0 0 24px rgba(0,226,229,0.1)" }}
    >
      <div className="bg-[#00E2E5]/10 border-b border-[#00E2E5]/30 px-4 py-3">
        <p
          className="text-[#00E2E5] font-bold uppercase tracking-wider text-center"
          style={{ fontSize: "clamp(12px, 2vw, 14px)" }}
        >
          E-Ticket · {startsInText}
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}50` }}
          >
            {badgeFor(details)}
          </span>
        </div>

        <p
          className="text-white font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p className="text-[#00E2E5]/80 text-xs font-bold uppercase tracking-wider mb-1">Race Time</p>
          <p
            className="text-white font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/50 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>

        <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-white/60 text-xs leading-relaxed">
          Save this page or screenshot it. This is your e-ticket —{" "}
          <strong className="text-white/80">show this screen at check-in</strong>. We&apos;ll notify you when your heat is
          called.
        </div>

        {details.resNumber && <p className="text-[#00E2E5]/50 font-bold text-xs mt-4">{details.resNumber}</p>}
      </div>
    </div>
  );
}

export function InvalidCard() {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-8 text-center">
      <div
        className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
        style={{ backgroundColor: "rgba(156,163,175,0.15)", border: "1px solid rgba(156,163,175,0.35)" }}
      >
        <svg className="w-7 h-7 text-white/50" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <p className="text-white font-display uppercase tracking-wider text-xl mb-2">Ticket No Longer Valid</p>
      <p className="text-white/50 text-sm leading-relaxed max-w-xs mx-auto">
        You&apos;re no longer assigned to this session. If you think this is a mistake, please see the Karting counter at
        FastTrax.
      </p>
      <p className="text-white/30 text-xs mt-4">Need help? Call (239) 204-4227</p>
    </div>
  );
}

export function PastCard({ details }: { details: CardDetails }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Session Complete</p>
      <p className="text-white font-display uppercase tracking-wider text-2xl mb-2">
        {details.firstName}&apos;s {details.raceType} Race
      </p>
      <p className="text-white/50 text-sm">
        {formatDate(details.scheduledStart)} · {formatTime(details.scheduledStart)}
      </p>
      <p className="text-white/30 text-xs mt-4">Your heat has already run. Check your email for results.</p>
    </div>
  );
}
