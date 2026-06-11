"use client";

/**
 * HP Arena e-ticket cards — HeadPinz-branded siblings of the racing
 * cards in app/t/[id]/cards.tsx. Shared pure helpers (formatTime,
 * formatDate, minutesUntil) are imported from there; the markup is
 * separate because the copy diverges everywhere ("session" not "heat",
 * "Session Starts" not "Check-In Closes", no track colors, HP contact
 * info) and arena state flips on BMI checkedIn rather than races-current.
 *
 * `track` on an arena ticket holds the activity display name
 * ("Laser Tag" / "Gel Blaster") — set by the arena cron.
 */

import { formatDate, formatTime, minutesUntil } from "@/app/t/[id]/cards";
import { HP_FM_PHONE_DISPLAY } from "~/features/arena-tickets/constants";

export interface ArenaCardDetails {
  firstName: string;
  lastName: string;
  scheduledStart: string;
  /** Activity display name — "Laser Tag" | "Gel Blaster". */
  track: string;
  heatNumber: number;
}

/** Per-activity accent — matches the booking catalog's accentColor
 *  (laser-tag #8652FF, gel-blaster #00E2E5). */
export const ACTIVITY_COLORS: Record<string, string> = {
  "laser tag": "#8652FF",
  "gel blaster": "#00E2E5",
};

function accentFor(d: ArenaCardDetails): string {
  return ACTIVITY_COLORS[d.track.toLowerCase()] || "#fd5b56";
}

function badgeFor(d: ArenaCardDetails): string {
  return `${d.track} · Session ${d.heatNumber}`;
}

function fullNameOf(d: ArenaCardDetails): string {
  return `${d.firstName} ${d.lastName}`.trim();
}

export const ARENA_PULSE_CSS = `
  @keyframes arenaPulse {
    0%, 100% { box-shadow: 0 0 20px rgba(134,82,255,0.35), 0 0 40px rgba(134,82,255,0.15); }
    50% { box-shadow: 0 0 32px rgba(134,82,255,0.6), 0 0 64px rgba(134,82,255,0.28); }
  }
`;

function ActivityBadge({ details, dim }: { details: ArenaCardDetails; dim?: boolean }) {
  const accent = accentFor(details);
  return (
    <span
      className={`inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full${dim ? " opacity-70" : ""}`}
      style={{
        color: accent,
        backgroundColor: `${accent}20`,
        border: `1px solid ${accent}50`,
      }}
    >
      {badgeFor(details)}
    </span>
  );
}

export function ArenaPreSessionCard({
  details,
  /** Future seam — flips a pulsing "checking in now" banner when the
   *  arena check-in alert cron (blocked on Pandora arena support)
   *  writes race:called:{sessionId}. Until then this stays false. */
  calledNow,
  children,
}: {
  details: ArenaCardDetails;
  calledNow?: boolean;
  children?: React.ReactNode;
}) {
  const accent = accentFor(details);
  const mins = minutesUntil(details.scheduledStart);
  const startsInText =
    mins <= 0
      ? "Starting soon"
      : mins < 60
        ? `Starts in ${mins} min`
        : `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`;

  return (
    <div
      className="rounded-2xl overflow-hidden border bg-white/[0.03]"
      style={{ borderColor: `${accent}66`, boxShadow: `0 0 24px ${accent}1a` }}
    >
      {calledNow ? (
        <div
          className="px-4 py-3 animate-pulse"
          style={{ backgroundColor: `${accent}38`, borderBottom: `1px solid ${accent}8c` }}
        >
          <p
            className="font-bold uppercase tracking-wider text-center text-white"
            style={{ fontSize: "clamp(13px, 2.2vw, 16px)" }}
          >
            Your session is checking in — head to the HP Arena desk
          </p>
        </div>
      ) : (
        <div
          className="px-4 py-3"
          style={{ backgroundColor: `${accent}1a`, borderBottom: `1px solid ${accent}4d` }}
        >
          <p
            className="font-bold uppercase tracking-wider text-center w-full"
            style={{ fontSize: "clamp(12px, 2vw, 14px)", color: accent }}
          >
            E-Ticket · {startsInText}
          </p>
        </div>
      )}

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <ActivityBadge details={details} />
        </div>

        <p
          className="text-white font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p
            className="text-xs font-bold uppercase tracking-wider mb-1"
            style={{ color: `${accent}cc` }}
          >
            Session Starts
          </p>
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
          <strong className="text-white/80">show this screen at the HP Arena desk</strong>. Arrive
          15 minutes early to gear up.
        </div>
      </div>
      {children}
    </div>
  );
}

/** Shown once BMI confirms the guest at the desk (participant
 *  `checkedIn` timestamp from the participants poll). */
export function ArenaCheckedInCard({
  details,
  children,
}: {
  details: ArenaCardDetails;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl overflow-hidden border-2"
      style={{
        borderColor: "#10B981",
        background: "linear-gradient(135deg, rgba(16,185,129,0.14), rgba(16,185,129,0.03))",
      }}
    >
      <div
        className="px-4 py-3"
        style={{
          backgroundColor: "rgba(16,185,129,0.2)",
          borderBottom: "1px solid rgba(16,185,129,0.5)",
        }}
      >
        <p
          className="font-bold uppercase tracking-wider text-center"
          style={{ fontSize: "clamp(14px, 2.5vw, 18px)", color: "#34d399" }}
        >
          ✓ Checked In — You&apos;re All Set
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <div className="mb-4">
          <ActivityBadge details={details} />
        </div>

        <p
          className="text-white font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p className="text-emerald-300/80 text-xs font-bold uppercase tracking-wider mb-1">
            Session Starts
          </p>
          <p
            className="text-white font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/50 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>

        <p className="text-white/50 text-xs mt-5">
          Listen for your session call and head to the arena entrance when staged.
        </p>
      </div>
      {children}
    </div>
  );
}

export function ArenaPastCard({ details }: { details: ArenaCardDetails }) {
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
          <ActivityBadge details={details} dim />
        </div>

        <p
          className="text-white/70 font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
        >
          {fullNameOf(details)}
        </p>

        <div className="mt-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-wider mb-1">
            Session Started
          </p>
          <p
            className="text-white/60 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/40 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>

        <p className="text-white/30 text-xs mt-5">This session has already run.</p>
      </div>
    </div>
  );
}

export function ArenaInvalidCard({ details }: { details?: ArenaCardDetails }) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-6 sm:p-8 text-center">
      <div
        className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
        style={{
          backgroundColor: "rgba(156,163,175,0.15)",
          border: "1px solid rgba(156,163,175,0.35)",
        }}
      >
        <svg
          className="w-7 h-7 text-white/50"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <p className="text-white font-display uppercase tracking-wider text-xl mb-2">
        Ticket No Longer Valid
      </p>
      <p className="text-white/50 text-sm leading-relaxed max-w-xs mx-auto">
        You&apos;re no longer assigned to this session. If you think this is a mistake, please see
        the HP Arena desk.
      </p>

      {details && (
        <div className="mt-6 pt-6 border-t border-white/10">
          <p className="text-white/30 text-[11px] uppercase tracking-widest mb-3">
            Original Ticket
          </p>
          <div className="mb-3">
            <ActivityBadge details={details} dim />
          </div>
          <p
            className="text-white/60 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(28px, 8vw, 44px)" }}
          >
            {fullNameOf(details)}
          </p>
          <p className="text-white/40 text-[11px] uppercase tracking-wider mt-3 mb-1">
            Session Time
          </p>
          <p
            className="text-white/55 font-display uppercase tracking-wider leading-none"
            style={{ fontSize: "clamp(32px, 10vw, 52px)" }}
          >
            {formatTime(details.scheduledStart)}
          </p>
          <p className="text-white/30 text-xs mt-2">{formatDate(details.scheduledStart)}</p>
        </div>
      )}

      <p className="text-white/30 text-xs mt-6">Need help? Call {HP_FM_PHONE_DISPLAY}</p>
    </div>
  );
}

/** New-session detail rendered by ArenaMovedCard (mirror of
 *  RaceTicket.movedTo — `track` carries the activity display name). */
export interface ArenaMovedSession {
  ticketId: string;
  group?: boolean;
  heatNumber: number;
  track: string;
  scheduledStart: string;
}

export function ArenaMovedCard({
  details,
  movedTo,
}: {
  details: ArenaCardDetails;
  movedTo: ArenaMovedSession;
}) {
  const newAccent = ACTIVITY_COLORS[movedTo.track.toLowerCase()] || "#fd5b56";
  return (
    <div
      className="rounded-2xl overflow-hidden border-2"
      style={{
        borderColor: "#F59E0B",
        background: "linear-gradient(135deg, rgba(245,158,11,0.14), rgba(245,158,11,0.03))",
      }}
    >
      <div
        className="px-4 py-3"
        style={{
          backgroundColor: "rgba(245,158,11,0.2)",
          borderBottom: "1px solid rgba(245,158,11,0.5)",
        }}
      >
        <p
          className="font-bold uppercase tracking-wider text-center"
          style={{ fontSize: "clamp(14px, 2.5vw, 18px)", color: "#fbbf24" }}
        >
          Your Session Moved
        </p>
      </div>

      <div className="p-5 sm:p-6 text-center">
        <p
          className="text-white font-display uppercase tracking-wider leading-none mb-5"
          style={{ fontSize: "clamp(30px, 9vw, 52px)" }}
        >
          {fullNameOf(details)}
        </p>

        <p className="text-white/40 text-[11px] uppercase tracking-widest mb-1">Was</p>
        <div className="opacity-60 mb-1">
          <ActivityBadge details={details} dim />
        </div>
        <p className="text-white/45 text-sm line-through">{formatTime(details.scheduledStart)}</p>

        <p className="text-[#F59E0B] text-2xl my-2" aria-hidden="true">
          ↓
        </p>

        <p className="text-[#fbbf24] text-[11px] uppercase tracking-widest mb-1 font-bold">Now</p>
        <span
          className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-2"
          style={{
            color: newAccent,
            backgroundColor: `${newAccent}20`,
            border: `1px solid ${newAccent}50`,
          }}
        >
          {movedTo.track} · Session {movedTo.heatNumber}
        </span>
        <p
          className="text-white font-display uppercase tracking-wider leading-none"
          style={{ fontSize: "clamp(40px, 13vw, 64px)" }}
        >
          {formatTime(movedTo.scheduledStart)}
        </p>
        <p className="text-white/50 text-xs mt-2">{formatDate(movedTo.scheduledStart)}</p>

        <a
          href={`/${movedTo.group ? "g" : "t"}/${movedTo.ticketId}`}
          className="mt-6 inline-block w-full rounded-xl px-4 py-3 font-bold uppercase tracking-wider text-sm active:scale-[0.99] transition-all"
          style={{ backgroundColor: "#F59E0B", color: "#1a1a1a" }}
        >
          View Updated E-Ticket
        </a>
        <p className="text-white/30 text-xs mt-4">Need help? Call {HP_FM_PHONE_DISPLAY}</p>
      </div>
    </div>
  );
}
