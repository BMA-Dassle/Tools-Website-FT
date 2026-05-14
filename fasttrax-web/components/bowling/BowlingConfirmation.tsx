"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import { useBowlingConfirmation } from "@/hooks/useBowlingConfirmation";
import {
  BowlingHeroCard,
  BowlingLaneStatus,
  BowlingPlayerCta,
  BowlingBookingCard,
  BowlingPlayerSummary,
  BowlingArrivalInstructions,
  BowlingReschedulePanel,
  BowlingCancelSection,
  BowlingNavLinks,
  BowlerModal,
  KIND_CONFIG,
  type BowlingConfirmationKind,
} from "@/components/bowling/BowlingConfirmationPanels";

/**
 * Shared bowling confirmation page component.
 *
 * Used by both Kids Bowl Free (kind="kbf") and Open Bowling (kind="open").
 * Reads URL params: code (shortCode) or neonId (legacy).
 * All data fetching + mutations delegated to useBowlingConfirmation hook.
 * All UI via composable panels from BowlingConfirmationPanels.
 *
 * The same hook + panels are used by the unified confirmation page at
 * /book/checkout/confirmation for mixed-cart bookings.
 */

export type { BowlingConfirmationKind };

const BG = "#0a1628";

// ── Main content (inside Suspense) ─────────────────────────────────────────

function ConfirmationContent({ kind }: { kind: BowlingConfirmationKind }) {
  const sp = useSearchParams();
  const router = useRouter();

  // Prefer ?code= (short code, non-guessable). Fall back to legacy ?neonId=
  const codeParam = sp.get("code") ?? "";
  const legacyNeonId = parseInt(sp.get("neonId") ?? "0", 10);
  const autoOpenNames = sp.get("names") === "1";

  const bc = useBowlingConfirmation({
    shortCode: codeParam || undefined,
    neonId: legacyNeonId > 0 ? legacyNeonId : undefined,
    autoOpenNames,
  });

  // Legacy URL redirect: if user arrived via ?neonId=, swap to ?code=
  // once the reservation loads with a shortCode.
  if (!codeParam && bc.reservation?.shortCode) {
    const params = new URLSearchParams(window.location.search);
    params.delete("neonId");
    params.set("code", bc.reservation.shortCode);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    router.replace(newUrl);
  }

  const cfg = KIND_CONFIG[kind];

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-28 sm:pt-36 pb-24 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">

        {/* ── Check-in status — mobile top ── */}
        {!bc.isCancelled && bc.hasNeonRecord && bc.laneReadyPhase !== "idle" && (
          <div className="mb-4">
            <BowlingLaneStatus
              laneReadyPhase={bc.laneReadyPhase}
              laneReadyLabel={bc.laneReadyLabel}
              neonId={bc.neonId}
              responsive="mobile"
            />
          </div>
        )}

        {/* ── Bowler CTA — mobile only (above grid) ── */}
        {bc.players.length > 0 && !bc.isCancelled && bc.laneReadyPhase !== "running" && (
          <div className="mb-4">
            <BowlingPlayerCta
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              onOpen={() => { bc.setPlayersSaved(false); bc.setBowlerModalOpen(true); }}
              responsive="mobile"
            />
          </div>
        )}

        {/* ── Two-column on large screens ── */}
        <div className="lg:grid lg:grid-cols-5 lg:gap-6 space-y-4 lg:space-y-0">

        {/* ── LEFT COLUMN ── */}
        <div className="lg:col-span-3 space-y-4">
          <BowlingHeroCard
            isCancelled={bc.isCancelled}
            hasPaidDeposit={bc.hasPaidDeposit}
            cancelRefundCents={bc.cancelRefundCents}
            refundCents={bc.reservation?.refundCents ?? 0}
            cfg={cfg}
          />

          {/* Fetch-failed warning */}
          {(bc.fetchError || !bc.hasNeonRecord) && !bc.loading && (
            <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
              {!bc.hasNeonRecord
                ? "Your booking is confirmed — we couldn't save the detail record, but your lane is held."
                : "We couldn't load your full booking details right now — but your lane is held."}{" "}
              {cfg.fetchFailNote(bc.centerName)}
            </div>
          )}

          <BowlingBookingCard bc={bc} kind={kind} cfg={cfg} />

          {/* Bowler summary strip (left column) */}
          {bc.players.length > 0 && !bc.isCancelled && bc.laneReadyPhase !== "running" && (
            <BowlingPlayerSummary
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              onEditClick={() => { bc.setPlayersSaved(false); bc.setBowlerModalOpen(true); }}
            />
          )}
        </div>{/* ── END LEFT COLUMN ── */}

        {/* ── RIGHT COLUMN ── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Lane status (desktop only) */}
          {!bc.isCancelled && bc.hasNeonRecord && bc.laneReadyPhase !== "idle" && (
            <BowlingLaneStatus
              laneReadyPhase={bc.laneReadyPhase}
              laneReadyLabel={bc.laneReadyLabel}
              neonId={bc.neonId}
              responsive="desktop"
            />
          )}

          {/* Bowler CTA (desktop only) */}
          {bc.players.length > 0 && !bc.isCancelled && bc.laneReadyPhase !== "running" && (
            <BowlingPlayerCta
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              onOpen={() => { bc.setPlayersSaved(false); bc.setBowlerModalOpen(true); }}
              responsive="desktop"
            />
          )}

          {/* Bowler details modal */}
          {bc.bowlerModalOpen && bc.players.length > 0 && (
            <BowlerModal
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              laneNumbers={bc.laneNumbers}
              kind={kind}
              playersSaving={bc.playersSaving}
              playersSaved={bc.playersSaved}
              playersError={bc.playersError}
              onUpdate={bc.updatePlayer}
              onSave={() => void bc.savePlayers()}
              onClose={() => bc.setBowlerModalOpen(false)}
            />
          )}

          {/* Arrival instructions */}
          {!bc.isCancelled && (
            <BowlingArrivalInstructions displayRemaining={bc.displayRemaining} cfg={cfg} />
          )}

          {/* Reschedule */}
          <BowlingReschedulePanel bc={bc} cfg={cfg} />

          {/* Cancel */}
          <BowlingCancelSection bc={bc} />

          {/* Navigation links */}
          <BowlingNavLinks cfg={cfg} />
        </div>{/* ── END RIGHT COLUMN ── */}
        </div>{/* ── END GRID ── */}
        </div>{/* ── END max-w-5xl ── */}
      </main>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function ConfirmationSkeleton() {
  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />
      <main className="pt-28 pb-20 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          <div className="lg:grid lg:grid-cols-5 lg:gap-6">
            <div className="lg:col-span-3 animate-pulse space-y-4">
              <div className="h-44 rounded-2xl bg-white/5" />
              <div className="h-64 rounded-2xl bg-white/5" />
            </div>
            <div className="lg:col-span-2 animate-pulse space-y-4 mt-4 lg:mt-0">
              <div className="h-80 rounded-2xl bg-white/5" />
              <div className="h-24 rounded-2xl bg-white/5" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Exported component (wraps Suspense for useSearchParams) ───────────────

export default function BowlingConfirmation({ kind }: { kind: BowlingConfirmationKind }) {
  return (
    <Suspense fallback={<ConfirmationSkeleton />}>
      <ConfirmationContent kind={kind} />
    </Suspense>
  );
}
