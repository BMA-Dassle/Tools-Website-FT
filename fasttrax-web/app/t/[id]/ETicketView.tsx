"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { RaceTicket } from "@/lib/race-tickets";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import {
  CheckingInCard,
  InvalidCard,
  LoadingStatusCard,
  PastCard,
  PreRaceCard,
  TICKET_PULSE_CSS,
  minutesUntil,
} from "./cards";
import ImportantRaceInfo from "./ImportantRaceInfo";
import FullScreenTicket from "./FullScreenTicket";

/** TrackStatus pulls Pandora + the proxied track-status API on
 *  mount. When Pandora is degraded its initial render can be held
 *  up while the bundle loads + the first poll resolves. Loading it
 *  via dynamic import + ssr:false splits it into its own chunk so
 *  the e-ticket card and Important Race Info banner ABOVE it paint
 *  immediately — TrackStatus arrives a beat later without blocking. */
const TrackStatus = dynamic(() => import("@/components/home/TrackStatus"), {
  ssr: false,
  loading: () => null,
});

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
  // True after the FIRST live poll completes. Until then we don't
  // know whether `checkingIn` is actually false or just hasn't been
  // fetched yet — and `wasCalled && !checkingIn` would wrongly
  // resolve to PastCard when the race might be checking in RIGHT
  // NOW. Was the cause of the "session complete" flash on open.
  const [statusLoaded, setStatusLoaded] = useState(false);
  /** Drives the full-screen "show to Karting attendant" overlay.
   *  Same UX pattern as the confirmation page's QR modal — high-
   *  contrast white background + huge text so staff can read the
   *  racer's heat info from across the check-in counter. */
  const [fullScreen, setFullScreen] = useState(false);

  const mins = minutesUntil(ticket.scheduledStart);
  // Hard fallback for tickets viewed long after the heat with no called signal.
  const longPast = mins < -90;
  // Primary past-state trigger: race was called and is no longer currently checking in.
  // Only evaluate after the first poll has settled. If wasCalled was
  // seeded from Redis (SSR) but the page hasn't seen a fresh
  // races-current yet, we DON'T jump to PastCard — show a loading
  // state instead. longPast is time-based and always safe.
  const dropped = statusLoaded && wasCalled && !checkingIn;
  const isPast = longPast || dropped;
  // Pre-first-poll "loading" state: race is in the live window
  // (not longPast) AND we have a wasCalled signal that COULD mean
  // "currently checking in" OR "race already finished". Ambiguous
  // until the poll resolves. Show a transient loading card instead
  // of the wrong final card.
  const loadingStatus = !statusLoaded && wasCalled && !longPast;

  // Poll Pandora every 20s: races-current (for checking-in flip) AND
  // session-participants (to catch staff-removed racers). Also
  // refresh wasCalled from /api/race-session-state in case the cron
  // flagged it while the page was open.
  //
  // Polling is paused while the tab is hidden — Edge in particular
  // kills long-lived background renderers that keep doing fetch
  // work, and the user gets "This page couldn't load" on next
  // focus. See lib/use-visible-interval.ts.
  async function poll(signal: AbortSignal) {
    try {
      const [currentRes, partRes, stateRes] = await Promise.all([
        fetch("/api/pandora/races-current", { cache: "no-store", signal }),
        fetch(
          `/api/pandora/session-participants?locationId=${encodeURIComponent(ticket.locationId)}&sessionId=${encodeURIComponent(String(ticket.sessionId))}`,
          { cache: "no-store", signal },
        ),
        fetch(`/api/race-session-state?sessionId=${encodeURIComponent(String(ticket.sessionId))}`, { cache: "no-store", signal }),
      ]);
      if (signal.aborted) return;
      if (currentRes.ok) {
        const d = await currentRes.json();
        const key = ticket.track.toLowerCase() as "blue" | "red" | "mega";
        const matches = String(d?.[key]?.sessionId ?? "") === String(ticket.sessionId ?? "");
        setCheckingIn(matches);
        if (matches) setWasCalled(true);
      }
      if (partRes.ok) {
        const d = await partRes.json();
        const list = Array.isArray(d?.data) ? d.data : [];
        if (list.length > 0) {
          const target = String(ticket.personId);
          const stillOn = list.some((p: { personId: string | number }) => String(p.personId) === target);
          setOnSession(stillOn);
        }
      }
      if (stateRes.ok) {
        const d = await stateRes.json();
        if (d?.wasCalled) setWasCalled(true);
      }
      // Mark first-poll-complete so the "is this race past?" check
      // can now trust `checkingIn`. Done at the END of the poll so
      // any state setters above have already queued.
      if (!signal.aborted) setStatusLoaded(true);
    } catch {
      /* aborts + transient network errors land here — silent. We
         still flip statusLoaded on transient errors so the user
         doesn't get stuck on the loading card forever; the next
         poll cycle will correct any wrong assumptions. */
      setStatusLoaded(true);
    }
  }
  useVisibleInterval(poll, 20_000, !longPast);

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center px-4 pt-28 sm:pt-32 pb-8">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">E-Ticket</p>
          {ticket.viaGuardian && (
            <p className="text-amber-300/80 text-[11px] mt-2 inline-block px-2 py-0.5 rounded-full border border-amber-300/30 bg-amber-500/10">
              {ticket.guardianFirstName
                ? <>Sent to <strong className="text-amber-200">{ticket.guardianFirstName}</strong> (parent)</>
                : <>Sent to your guardian</>}
            </p>
          )}
        </div>

        {/* Important race info banner — was previously embedded in
            the SMS body but T-Mobile / Verizon were rejecting the
            11-segment messages with code 4505 ("carrier rejected
            message too long"). Moved here so customers still see
            the same info the moment they open the e-ticket link.
            Hidden once the race has run (PastCard branch handles
            its own messaging). */}
        {!isPast && <ImportantRaceInfo />}

        {loadingStatus ? (
          // Pre-first-poll: wasCalled is true but we don't yet know
          // if the race is currently checking in or already past.
          // Show a transient "Loading status…" card to avoid a
          // wrong PastCard flash while the poll resolves.
          <LoadingStatusCard details={ticket} />
        ) : !onSession && !isPast ? (
          <InvalidCard details={ticket} />
        ) : isPast ? (
          <PastCard details={ticket} />
        ) : checkingIn ? (
          <CheckingInCard details={ticket} />
        ) : (
          <PreRaceCard details={ticket} />
        )}

        {/* "Show to Karting attendant" full-screen button —
            mirrors the confirmation page's QR-modal pattern. Hidden
            on past states (nothing to scan) and during the loading
            window (no settled state to display). */}
        {!isPast && !loadingStatus && onSession && (
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            className="mt-4 w-full py-3 rounded-xl bg-white text-[#000418] font-bold uppercase tracking-wider text-sm hover:bg-white/90 active:scale-[0.99] transition-all"
          >
            Show to Karting Attendant
          </button>
        )}

        <div className="mt-6">
          <TrackStatus />
        </div>

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">14501 Global Parkway, Fort Myers, FL 33913</p>
          <p className="text-white/20 text-[11px] mt-1">Show this screen at check-in · No paper ticket needed</p>
        </div>
      </div>

      {fullScreen && (
        <FullScreenTicket
          racers={[{ firstName: ticket.firstName, lastName: ticket.lastName }]}
          heat={{
            scheduledStart: ticket.scheduledStart,
            track: ticket.track,
            raceType: ticket.raceType,
            heatNumber: ticket.heatNumber,
            resNumber: ticket.resNumber,
          }}
          onClose={() => setFullScreen(false)}
        />
      )}
    </div>
  );
}
