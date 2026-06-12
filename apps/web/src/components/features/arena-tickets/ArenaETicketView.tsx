"use client";

/**
 * HP Arena single-ticket view — HeadPinz-branded sibling of
 * app/t/[id]/ETicketView.tsx, rendered when ticket.activity is an
 * arena activity.
 *
 * State machine differences vs racing:
 *   - No races-current — arena has no "session called" signal from
 *     Pandora today. State flips on:
 *       · BMI checkedIn (participants poll, lean payload) → CheckedInCard
 *       · time (90+ min past scheduledStart)               → PastCard
 *       · dropped from a non-empty roster                  → InvalidCard
 *       · movedTo stamped by the cron                      → MovedCard
 *   - /api/race-session-state is still polled: it reads the generic
 *     Redis race:called:{sessionId} key, which the FUTURE
 *     arena-checkin-alerts cron (blocked on Pandora arena support)
 *     will write. When that lands, deployed tickets light up the
 *     "checking in now" banner with no redeploy.
 *   - Racing-only widgets are gone: POV voucher claim, headsock
 *     credit, TrackStatus.
 *   - QR block is gated on ARENA_QR_ENABLED (off until the staff
 *     scanner is location-aware — PR-5). Arena desk checks guests in
 *     at POS today, so the ticket works without it.
 */

import { useEffect, useRef, useState } from "react";
import type { RaceTicket } from "@/lib/race-tickets";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { checkinQrDataUrl } from "@/lib/qr-checkin";
import { modalBackdropProps } from "@/lib/a11y";
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
  ticket: RaceTicket;
}

/** Lean participants-poll row (untrusted browser payload). */
interface LeanParticipant {
  personId: string | number;
  checkedIn?: string | null;
}

export default function ArenaETicketView({ ticket }: Props) {
  const [onSession, setOnSession] = useState(true);
  const [checkedIn, setCheckedIn] = useState(false);
  /** Future seam — race:called:{sessionId} written by the (not yet
   *  built) arena check-in alert cron. Renders a banner, not a state. */
  const [calledNow, setCalledNow] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [fullscreenQr, setFullscreenQr] = useState(false);
  const qrGenerated = useRef(false);

  const mins = minutesUntil(ticket.scheduledStart);
  const isPast = mins < -90;

  const qrPayload = (() => {
    const partId = String(ticket.participantId ?? "").trim();
    const base = `HP:${ticket.locationId}:${ticket.personId}:${ticket.sessionId}`;
    return /^\d+$/.test(partId) ? `${base}:${partId}` : base;
  })();

  // Poll every 30s: participants (onSession + checkedIn) and the
  // session-called seam. Paused while the tab is hidden, stopped
  // entirely once the session is long past.
  async function poll(signal: AbortSignal) {
    try {
      const [partRes, stateRes] = await Promise.all([
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
      if (partRes.ok) {
        const d = await partRes.json();
        const list: LeanParticipant[] = Array.isArray(d?.data) ? d.data : [];
        // Forgiving on empty — never flag invalid on missing data.
        if (list.length > 0) {
          const target = String(ticket.personId);
          const me = list.find((p) => String(p.personId) === target);
          setOnSession(!!me);
          setCheckedIn(!!me?.checkedIn);
        }
      }
      if (stateRes.ok) {
        const d = await stateRes.json();
        if (d?.wasCalled) setCalledNow(true);
      }
    } catch {
      /* aborts + transient network errors — silent; next cycle corrects */
    }
  }
  useVisibleInterval(poll, 30_000, !isPast);

  useEffect(() => {
    if (!ARENA_QR_ENABLED || qrGenerated.current) return;
    qrGenerated.current = true;
    const pid = String(ticket.personId ?? "").trim();
    const sid = String(ticket.sessionId ?? "").trim();
    if (!pid || !sid || !/^\d+$/.test(pid) || !/^\d+$/.test(sid)) return;
    const partId = String(ticket.participantId ?? "").trim();
    const partArg = /^\d+$/.test(partId) ? partId : undefined;
    checkinQrDataUrl(pid, sid, partArg, 160, ticket.locationId)
      .then(setQrDataUrl)
      .catch(() => {});
  }, [ticket.personId, ticket.sessionId, ticket.participantId, ticket.locationId]);

  const details = {
    firstName: ticket.firstName,
    lastName: ticket.lastName,
    scheduledStart: ticket.scheduledStart,
    track: ticket.track,
    heatNumber: ticket.heatNumber,
  };

  const qrBlock = ARENA_QR_ENABLED && onSession && qrDataUrl && (
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
      <p className="text-white/50 text-xs">Tap to open full screen &middot; Scan at the desk</p>
    </button>
  );

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center px-4 pt-28 sm:pt-32 pb-8">
      <style>{ARENA_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-5">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">HeadPinz</p>
          <p className="text-white/60 text-sm font-semibold">HP Arena E-Ticket</p>
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

        {!isPast && !ticket.movedTo && <ImportantArenaInfo />}

        {ticket.movedTo ? (
          <ArenaMovedCard details={details} movedTo={ticket.movedTo} />
        ) : !onSession && !isPast ? (
          <ArenaInvalidCard details={details} />
        ) : isPast ? (
          <ArenaPastCard details={details} />
        ) : checkedIn ? (
          <ArenaCheckedInCard details={details}>{qrBlock}</ArenaCheckedInCard>
        ) : (
          <ArenaPreSessionCard details={details} calledNow={calledNow}>
            {qrBlock}
          </ArenaPreSessionCard>
        )}

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">{HP_FM_ADDRESS}</p>
          <p className="text-white/20 text-[11px] mt-1">
            Please have your e-ticket open and ready at the HP Arena desk
          </p>
        </div>
      </div>

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
          <p className="mt-1 text-black/60 text-sm uppercase tracking-wider">Scan at the desk</p>
          <p className="mt-6 text-black/30 text-xs">Tap anywhere to close</p>
        </div>
      )}
    </div>
  );
}
