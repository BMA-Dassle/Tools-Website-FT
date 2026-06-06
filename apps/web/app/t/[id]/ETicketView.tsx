"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RaceTicket } from "@/lib/race-tickets";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { checkinQrDataUrl } from "@/lib/qr-checkin";
import { modalBackdropProps } from "@/lib/a11y";
import {
  CheckingInCard,
  InvalidCard,
  MovedCard,
  PastCard,
  PreRaceCard,
  TICKET_PULSE_CSS,
  minutesUntil,
} from "./cards";
import ImportantRaceInfo from "./ImportantRaceInfo";
import FullScreenTicket from "./FullScreenTicket";
import PovVoucherBlock from "@/components/booking/PovVoucherBlock";

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

export default function ETicketView({
  ticket,
  initialCheckingIn,
  initialOnSession,
  initialWasCalled,
}: Props) {
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
  /** ViewPoint POV codes claimed against this participant's BMI
   *  ViewPoint Credit balance. Auto-issued on first ticket open;
   *  `cached: true` on subsequent visits returns the same codes
   *  back. Empty array = participant has no credit / no POV pool
   *  configured / claim deferred. Block renders only when codes
   *  are present, so the default empty state hides nothing. */
  const [povCodes, setPovCodes] = useState<string[]>([]);
  const [povCached, setPovCached] = useState(false);
  /** One-shot guard — the claim endpoint is idempotent (per-personId
   *  Redis key) but firing it once per mount avoids needless
   *  round-trips. StrictMode in dev double-invokes the effect; the
   *  ref short-circuits the second pass. */
  const povClaimAttempted = useRef(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [fullscreenQr, setFullscreenQr] = useState(false);
  const qrGenerated = useRef(false);
  const [headsockCredit, setHeadsockCredit] = useState(0);
  const headsockChecked = useRef(false);

  // Mirror of the encoded QR payload, exposed via data-qr-payload for
  // scan automation / E2E. 4-part when a valid participantId is present
  // (move-resilient), else legacy 3-part.
  const qrPayload = (() => {
    const partId = String(ticket.participantId ?? "").trim();
    const base = `FT:${ticket.personId}:${ticket.sessionId}`;
    return /^\d+$/.test(partId) ? `${base}:${partId}` : base;
  })();

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
        fetch(`/api/race-session-state?sessionId=${encodeURIComponent(String(ticket.sessionId))}`, {
          cache: "no-store",
          signal,
        }),
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
          const stillOn = list.some(
            (p: { personId: string | number }) => String(p.personId) === target,
          );
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

  // ViewPoint POV claim. Fires once on mount (StrictMode-safe via
  // ref). Idempotent server-side: per-personId Redis key returns the
  // same codes if the participant has visited before, so refresh /
  // re-open is free. Skipped for invalid tickets (placeholder
  // personId or missing fields) — the server-side validator will
  // reject anyway, no point in the round-trip.
  useEffect(() => {
    if (povClaimAttempted.current) return;
    povClaimAttempted.current = true;
    const pid = String(ticket.personId ?? "").trim();
    const sid = String(ticket.sessionId ?? "").trim();
    const loc = String(ticket.locationId ?? "").trim();
    if (!pid || !sid || !loc || !/^\d+$/.test(pid) || !/^\d+$/.test(sid)) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/pov-codes?action=claim-from-credit&personId=${encodeURIComponent(pid)}&locationId=${encodeURIComponent(loc)}&sessionId=${encodeURIComponent(sid)}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { codes?: string[]; cached?: boolean };
        if (Array.isArray(json.codes) && json.codes.length > 0) {
          setPovCodes(json.codes);
          setPovCached(!!json.cached);
        }
      } catch {
        /* aborts + transient errors — silent. The block stays
           hidden and the customer can revisit later. */
      }
    })();
    return () => ac.abort();
  }, [ticket.personId, ticket.sessionId, ticket.locationId]);

  useEffect(() => {
    if (qrGenerated.current) return;
    qrGenerated.current = true;
    const pid = String(ticket.personId ?? "").trim();
    const sid = String(ticket.sessionId ?? "").trim();
    if (!pid || !sid || !/^\d+$/.test(pid) || !/^\d+$/.test(sid)) return;
    const partId = String(ticket.participantId ?? "").trim();
    const partArg = /^\d+$/.test(partId) ? partId : undefined;
    checkinQrDataUrl(pid, sid, partArg)
      .then(setQrDataUrl)
      .catch(() => {});
  }, [ticket.personId, ticket.sessionId, ticket.participantId]);

  useEffect(() => {
    if (headsockChecked.current) return;
    headsockChecked.current = true;
    const pid = String(ticket.personId ?? "").trim();
    if (!pid || !/^\d+$/.test(pid)) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/pandora/deposits/${encodeURIComponent(pid)}?locationId=${encodeURIComponent(ticket.locationId)}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok) return;
        const json = await res.json();
        const rows = Array.isArray(json?.data) ? json.data : [];
        const hsKindId = "48069703";
        const row = rows.find(
          (r: { OUT_DPK_ID: number | string }) => String(r.OUT_DPK_ID) === hsKindId,
        );
        if (row && row.OUT_DPS_AMOUNT > 0) setHeadsockCredit(row.OUT_DPS_AMOUNT);
      } catch {
        /* silent */
      }
    })();
    return () => ac.abort();
  }, [ticket.personId, ticket.locationId]);

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center px-4 pt-28 sm:pt-32 pb-8">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">
            FastTrax Entertainment
          </p>
          <p className="text-white/60 text-sm font-semibold">E-Ticket</p>
          {ticket.viaGuardian && (
            <p className="text-amber-300/80 text-[11px] mt-2 inline-block px-2 py-0.5 rounded-full border border-amber-300/30 bg-amber-500/10">
              {ticket.guardianFirstName ? (
                <>
                  Sent to <strong className="text-amber-200">{ticket.guardianFirstName}</strong>{" "}
                  (parent)
                </>
              ) : (
                <>Sent to your guardian</>
              )}
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
        {!isPast && !ticket.movedTo && <ImportantRaceInfo />}

        {/* Always render the e-ticket info immediately. The status
            bar inside PreRaceCard shows a spinner while the live
            check is in flight — the customer's name, heat, time
            never gets blocked behind a loading card. Only confirmed
            terminal states (past / checking-in / removed) swap to
            their dedicated cards. */}
        {ticket.movedTo ? (
          <MovedCard details={ticket} movedTo={ticket.movedTo} />
        ) : !onSession && !isPast && !loadingStatus ? (
          <InvalidCard details={ticket} />
        ) : isPast ? (
          <PastCard details={ticket} />
        ) : checkingIn ? (
          <CheckingInCard details={ticket}>
            {onSession && qrDataUrl && (
              <>
                {headsockCredit > 0 && (
                  <div className="bg-amber-500/15 border-t border-amber-400/30 px-4 py-2.5 text-center">
                    <p className="text-amber-300 text-xs font-bold uppercase tracking-wider">
                      Headsock Credit on File
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setFullscreenQr(true)}
                  className="w-full flex flex-col items-center gap-2 py-5 border-t border-white/10 hover:bg-white/5 active:scale-[0.99] transition-all"
                >
                  <div className="bg-white rounded-lg p-2">
                    <img
                      src={qrDataUrl}
                      alt="Check-in QR"
                      data-qr-payload={qrPayload}
                      width={140}
                      height={140}
                      className="block"
                    />
                  </div>
                  <p className="text-white/50 text-xs">
                    Tap to open full screen &middot; Scan at Check-In
                  </p>
                </button>
              </>
            )}
          </CheckingInCard>
        ) : (
          <PreRaceCard details={ticket} loadingStatus={loadingStatus}>
            {onSession && qrDataUrl && (
              <>
                {headsockCredit > 0 && (
                  <div className="bg-amber-500/15 border-t border-amber-400/30 px-4 py-2.5 text-center">
                    <p className="text-amber-300 text-xs font-bold uppercase tracking-wider">
                      Headsock Credit on File
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setFullscreenQr(true)}
                  className="w-full flex flex-col items-center gap-2 py-5 border-t border-white/10 hover:bg-white/5 active:scale-[0.99] transition-all"
                >
                  <div className="bg-white rounded-lg p-2">
                    <img
                      src={qrDataUrl}
                      alt="Check-in QR"
                      data-qr-payload={qrPayload}
                      width={140}
                      height={140}
                      className="block"
                    />
                  </div>
                  <p className="text-white/50 text-xs">
                    Tap to open full screen &middot; Scan at Check-In
                  </p>
                </button>
              </>
            )}
          </PreRaceCard>
        )}

        {!isPast && !ticket.movedTo && povCodes.length > 0 && (
          <div className="mt-6">
            <PovVoucherBlock codes={povCodes} cached={povCached} />
          </div>
        )}

        <div className="mt-6">
          <TrackStatus />
        </div>

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">14501 Global Parkway, Fort Myers, FL 33913</p>
          <p className="text-white/20 text-[11px] mt-1">
            Please have your e-ticket open and ready at check-in
          </p>
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

      {fullscreenQr && qrDataUrl && (
        <div
          className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center px-6"
          {...modalBackdropProps(() => setFullscreenQr(false))}
        >
          <img
            src={qrDataUrl}
            alt="Check-in QR"
            className="block"
            style={{ width: "min(280px, 70vw)", height: "min(280px, 70vw)" }}
          />
          <p className="mt-4 text-black font-bold text-2xl sm:text-3xl text-center">
            {ticket.firstName} {ticket.lastName}
          </p>
          <p className="mt-1 text-black/60 text-sm uppercase tracking-wider">Scan at Check-In</p>
          <p className="mt-6 text-black/30 text-xs">Tap anywhere to close</p>
        </div>
      )}
    </div>
  );
}
