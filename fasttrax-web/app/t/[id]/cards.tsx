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
            Check-In Closes
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

export function PreRaceCard({ details, loadingStatus }: { details: CardDetails; loadingStatus?: boolean }) {
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
        {/* Status bar — when `loadingStatus` is set, the live state
            check is still in flight (wasCalled=true from Redis but
            `checkingIn` not yet confirmed). Show a subtle spinner
            in the bar so the rest of the ticket (name / time / heat)
            stays visible immediately instead of being blocked by a
            separate loading card. */}
        <p
          className="text-[#00E2E5] font-bold uppercase tracking-wider text-center inline-flex items-center justify-center gap-2 w-full"
          style={{ fontSize: "clamp(12px, 2vw, 14px)" }}
        >
          {loadingStatus ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block w-3 h-3 rounded-full border-2 border-[#00E2E5]/30 border-t-[#00E2E5] animate-spin"
              />
              Confirming current status…
            </>
          ) : (
            <>E-Ticket · {startsInText}</>
          )}
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
          <p className="text-[#00E2E5]/80 text-xs font-bold uppercase tracking-wider mb-1">Check-In Closes</p>
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

/** Transient state — shown for the brief window between the page
 *  opening and the first live poll resolving. Without this card,
 *  pages with `wasCalled=true` (Redis-seeded) flash PastCard for
 *  ~1-2s while we wait for `checkingIn` to arrive — the user sees
 *  "Session Complete" on a heat that's actually checking in RIGHT
 *  NOW. Renders the same shape as PreRaceCard so the layout
 *  doesn't jump when the real card swaps in. */
export function LoadingStatusCard({ details }: { details: CardDetails }) {
  const trackColor = trackColorFor(details);
  return (
    <div
      className="rounded-2xl overflow-hidden border border-white/15 bg-white/[0.02]"
      style={{ boxShadow: "0 0 24px rgba(255,255,255,0.04)" }}
    >
      <div className="bg-white/[0.04] border-b border-white/10 px-4 py-3">
        <p
          className="text-white/60 font-bold uppercase tracking-wider text-center inline-flex items-center justify-center gap-2 w-full"
          style={{ fontSize: "clamp(12px, 2vw, 14px)" }}
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 h-3 rounded-full border-2 border-white/20 border-t-white/70 animate-spin"
          />
          Loading status…
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
        <p className="text-white/40 text-sm">
          Confirming whether this race is currently being called…
        </p>
      </div>
    </div>
  );
}

export function InvalidCard({ details }: { details?: CardDetails }) {
  const trackColor = details ? trackColorFor(details) : "#9ca3af";
  return (
    <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-6 sm:p-8 text-center">
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
        You&apos;re no longer assigned to this session. If you think this is a mistake, please see Guest Services.
      </p>

      {details && (
        <div className="mt-6 pt-6 border-t border-white/10">
          <p className="text-white/30 text-[11px] uppercase tracking-widest mb-3">Original Ticket</p>

          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full opacity-70 mb-3"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}40` }}
          >
            {badgeFor(details)}
          </span>

          <p
            className="text-white/60 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(28px, 8vw, 44px)" }}
          >
            {fullNameOf(details)}
          </p>

          <p className="text-white/40 text-[11px] uppercase tracking-wider mt-3 mb-1">Check-In Closed</p>
          <p
            className="text-white/55 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(32px, 10vw, 52px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/30 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>
      )}

      <p className="text-white/30 text-xs mt-6">Need help? Call (239) 481-9666</p>
    </div>
  );
}

export function PastCard({ details }: { details: CardDetails }) {
  const trackColor = trackColorFor(details);
  return (
    <div className="rounded-2xl overflow-hidden border border-white/15 bg-white/[0.03]">
      <div className="bg-white/5 border-b border-white/10 px-4 py-3">
        <p
          className="text-white/50 font-bold uppercase tracking-wider text-center"
          style={{ fontSize: "clamp(12px, 2vw, 14px)" }}
        >
          Session Complete
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <span
            className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full opacity-70"
            style={{ color: trackColor, backgroundColor: `${trackColor}20`, border: `1px solid ${trackColor}40` }}
          >
            {badgeFor(details)}
          </span>
        </div>

        <p
          className="text-white/70 font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-wider mb-1">Check-In Closed</p>
          <p
            className="text-white/60 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/40 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>

        <p className="text-white/30 text-xs mt-5">This heat&apos;s check-in window has closed.</p>

        {details.resNumber && <p className="text-white/30 font-bold text-xs mt-4">{details.resNumber}</p>}
      </div>
    </div>
  );
}
