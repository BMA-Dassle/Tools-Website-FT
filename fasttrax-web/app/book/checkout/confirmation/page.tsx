"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import BrandNav from "@/components/BrandNav";
import { useBowlingConfirmation } from "@/hooks/useBowlingConfirmation";
import { useRacingConfirmation, type RacerConfirmation, type RaceGroup } from "@/hooks/useRacingConfirmation";
import { useTrackStatus } from "@/hooks/useTrackStatus";

// Bowling panels
import {
  BowlingHeroCard,
  BowlingLaneStatus,
  BowlingPlayerCta,
  BowlingBookingCard,
  BowlingPlayerSummary,
  BowlingArrivalInstructions,
  BowlingReschedulePanel,
  BowlingCancelSection,
  BowlerModal,
  KIND_CONFIG,
  type BowlingConfirmationKind,
} from "@/components/bowling/BowlingConfirmationPanels";

// Racing panels
import {
  RacingHero,
  RacingWaiverBanner,
  RacingExpressLaneBanner,
  ExpressGlowStyle,
  RacingHeatCard,
  RacingPovCodes,
  RacingRookiePackCard,
  RacerJourneySteps,
  ExpressTrackStatus,
  FullscreenQrModal,
} from "@/components/racing/RacingConfirmationPanels";

/**
 * Unified checkout confirmation page — dynamic, multi-item.
 *
 * checkout/v2 handles ALL confirmation (QAMF + BMI + Square + Neon).
 * This page displays the result with full interactive features:
 *
 *   Bowling → player editing, lane-ready polling, reschedule, cancel
 *   Racing  → QR codes, Express Lane, waivers, POV codes, journey guide
 *   Other   → attraction summary cards with reservation number
 *
 * Data flow:
 *   1. Reads `sessionStorage.checkoutConfirmation` (one-time, set by checkout)
 *   2. Uses shortCode from URL (?code=) for refresh survival
 *   3. Bowling hook fetches reservation from Neon via shortCode/neonId
 *   4. Racing hook uses preResolved data from checkout OR fetches booking record
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface DebugStep {
  name: string;
  status: "ok" | "fail" | "skip";
  ms?: number;
  detail?: string;
}

/** Shape of racerAssignment saved by the racing wizard → checkout. */
interface RacerAssignment {
  racerName: string;
  personId: string | null;
  product: string;
  productId: string;
  tier: string;
  track: string;
  category: string;
  heatName: string;
  heatStart: string;
  heatStop: string | null;
}

interface ConfirmationData {
  // Core IDs from checkout/v2
  neonId?: number;
  neonIds?: number[];
  checkoutGroupId?: string | null;
  bmiBillId?: string | null;
  bmiReservationNumber?: string | null;
  bmiConfirmed?: boolean;
  qamfReservationId?: string | null;
  qamfConfirmed?: boolean;
  shortCode?: string | null;
  bookingType?: "bowling" | "racing" | "attractions" | "mixed";
  depositPaidCents?: number;
  totalCents?: number;

  // Bowling display data (from bowlingHold, about to be cleared)
  bowling?: {
    experienceName: string;
    timeLabel: string;
    bookedAt?: string;
    locationKey?: string;
    kind?: string;
    players: Array<{ name?: string; shoeSize?: string | null }> | number;
    totalCents: number;
    depositCents?: number;
    lineItems?: Array<{ name: string; quantity: string }>;
  } | null;

  // Attraction display data (from cart items)
  attractions?: {
    name: string;
    quantity: number;
    date: string;
    time: string | null;
  }[];

  // Guest info
  guestName?: string | null;
  guestEmail?: string | null;

  // Phase 3 additions for dynamic sections
  bowlingNeonId?: number | null;
  bowlingShortCode?: string | null;
  bowlingKind?: string | null;
  racerAssignments?: RacerAssignment[] | null;
  primaryPersonId?: string | null;
  isRacingCart?: boolean;

  // Debug (preview only)
  _debug?: DebugStep[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(iso: string) {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return "";
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Build preResolved racing data from the checkout confirmation blob.
 * This gives the racing hook immediate data (QR codes, heat cards) without
 * waiting for the booking-record to be created by post-confirm.
 */
function buildRacingPreResolved(
  data: ConfirmationData,
): {
  confirmations: RacerConfirmation[];
  raceGroups: RaceGroup[];
  expressLane: boolean;
  povCodes: string[];
  waiverUrl: string | null;
  rookiePack: boolean;
  checkInLocation: "fasttrax" | "headpinz";
} | null {
  const assignments = data.racerAssignments;
  if (!assignments || assignments.length === 0) return null;

  const billId = data.bmiBillId || "";
  const resNumber = data.bmiReservationNumber || "";
  const resCode = resNumber || `r${billId}`;

  // Build confirmations — one per racer
  const confirmations: RacerConfirmation[] = assignments.map((ra) => ({
    billId,
    racerName: ra.racerName,
    resNumber,
    resCode,
  }));

  // Build race groups — group by product + heatStart
  const groupMap = new Map<string, {
    product: string;
    track: string | null;
    heatStart: string;
    heatName: string;
    racers: string[];
  }>();
  for (const ra of assignments) {
    const key = `${ra.product}|${ra.heatStart}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        product: ra.product,
        track: ra.track || null,
        heatStart: ra.heatStart,
        heatName: ra.heatName,
        racers: [],
      });
    }
    groupMap.get(key)!.racers.push(ra.racerName);
  }
  const raceGroups: RaceGroup[] = [...groupMap.values()]
    .map((g) => ({ ...g, resNumber, resCode, billId }))
    .sort((a, b) => a.heatStart.localeCompare(b.heatStart));

  return {
    confirmations,
    raceGroups,
    // Enrichment data isn't available yet (set by post-confirm async).
    // Defaults are safe — the notification email/SMS includes these links.
    expressLane: false,
    povCodes: [],
    waiverUrl: null,
    rookiePack: false,
    checkInLocation: "fasttrax",
  };
}

// ── Racing Section ─────────────────────────────────────────────────────────

function RacingSection({ data }: { data: ConfirmationData }) {
  const billId = data.bmiBillId || "";
  const resNumber = data.bmiReservationNumber || "";
  const preResolved = useMemo(() => buildRacingPreResolved(data), [data]);

  const rc = useRacingConfirmation({
    billId,
    skipBmiConfirm: true, // checkout/v2 already confirmed
    preResolved: preResolved ?? undefined,
  });

  const liveStatus = useTrackStatus();

  if (rc.loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
      </div>
    );
  }

  // Even when the hook has no race groups yet (post-confirm still running),
  // show the reservation number + basic info from checkout data so the
  // customer doesn't see a blank page. The hook will enrich once ready.
  const hasHookData = rc.raceGroups.length > 0 || rc.confirmations.length > 0;

  return (
    <>
      {rc.expressLane && <ExpressGlowStyle />}

      {/* Waiver banner — new racers */}
      {rc.waiverUrl && <RacingWaiverBanner waiverUrl={rc.waiverUrl} />}

      {/* Express Lane banner — returning racers */}
      {rc.expressLane && <RacingExpressLaneBanner />}

      {hasHookData ? (
        <>
          {/* Heat cards */}
          <div className="space-y-4">
            {rc.raceGroups.map((group, i) => (
              <RacingHeatCard
                key={`${group.heatStart}-${i}`}
                group={group}
                expressLane={rc.expressLane}
                qr={rc.racerQrCodes[rc.confirmations[0]?.billId] ?? null}
                checkInLocation={rc.checkInLocation}
                isMyHeat={false}
                onQrClick={(src, resNum) => rc.setFullscreenQr({ src, resNumber: resNum })}
              />
            ))}
          </div>

          {/* POV codes */}
          <RacingPovCodes codes={rc.povCodes} />

          {/* Rookie pack */}
          {rc.rookiePack && <RacingRookiePackCard />}
        </>
      ) : (
        /* Fallback: post-confirm pipeline hasn't written the booking record yet.
           Show reservation number + attraction cart items so customer sees something. */
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-4">
          <div>
            <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest mb-1">
              Your Racing Reservation
            </p>
            {resNumber && (
              <p className="text-white/30 text-xs">
                Reservation <span className="font-mono text-[#00E2E5]/70">{resNumber}</span>
              </p>
            )}
          </div>
          {data.attractions && data.attractions.filter(a => /racing|race|kart/i.test(a.name)).map((item, i) => (
            <div key={i} className="flex justify-between items-start px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
              <div>
                <p className="text-white text-sm font-semibold">{item.name}</p>
                {item.date && (
                  <p className="text-white/40 text-xs">
                    {formatDate(item.date)}
                    {item.time ? ` · ${formatTime(item.time)}` : ""}
                  </p>
                )}
              </div>
              {item.quantity > 1 && <span className="text-white/30 text-xs shrink-0 ml-3">x{item.quantity}</span>}
            </div>
          ))}
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-amber-300 text-sm font-semibold mb-1">Waivers Required</p>
            <p className="text-white/60 text-xs leading-relaxed">
              Each participant must complete a waiver before their activity.
              Check your confirmation email for your waiver link, or complete one at Guest Services when you arrive.
            </p>
          </div>
          <p className="text-white/30 text-xs text-center">
            Full racing details (QR codes, Express Lane status) will appear in your confirmation email.
          </p>
        </div>
      )}

      {/* Journey guide / track status */}
      {rc.expressLane ? (
        <ExpressTrackStatus liveStatus={liveStatus} />
      ) : (
        <RacerJourneySteps liveStatus={liveStatus} />
      )}

      {/* Fullscreen QR modal */}
      {rc.fullscreenQr && (
        <FullscreenQrModal
          src={rc.fullscreenQr.src}
          resNumber={rc.fullscreenQr.resNumber}
          onClose={() => rc.setFullscreenQr(null)}
        />
      )}
    </>
  );
}

// ── Bowling Section ────────────────────────────────────────────────────────

function BowlingSection({
  shortCode,
  neonId,
  kind,
}: {
  shortCode?: string;
  neonId?: number;
  kind: BowlingConfirmationKind;
}) {
  const bc = useBowlingConfirmation({
    shortCode: shortCode || undefined,
    neonId: neonId && neonId > 0 ? neonId : undefined,
  });

  const cfg = KIND_CONFIG[kind];

  if (bc.loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-40 rounded-2xl bg-white/5" />
        <div className="h-56 rounded-2xl bg-white/5" />
      </div>
    );
  }

  // If the hook couldn't find a reservation, show minimal info
  if (!bc.reservation && !bc.hasNeonRecord) {
    return (
      <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
        Your bowling lane is reserved — we&apos;re loading your booking details.
        If this takes too long, check your confirmation email for full details.
      </div>
    );
  }

  return (
    <>
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

      {/* ── Bowler CTA — mobile only ── */}
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

      {/* ── Two-column layout ── */}
      <div className="lg:grid lg:grid-cols-5 lg:gap-6 space-y-4 lg:space-y-0">
        {/* LEFT */}
        <div className="lg:col-span-3 space-y-4">
          <BowlingHeroCard
            isCancelled={bc.isCancelled}
            hasPaidDeposit={bc.hasPaidDeposit}
            cancelRefundCents={bc.cancelRefundCents}
            refundCents={bc.reservation?.refundCents ?? 0}
            cfg={cfg}
          />

          {(bc.fetchError || !bc.hasNeonRecord) && !bc.loading && (
            <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
              {!bc.hasNeonRecord
                ? "Your booking is confirmed — we couldn't save the detail record, but your lane is held."
                : "We couldn't load your full booking details right now — but your lane is held."}{" "}
              {cfg.fetchFailNote(bc.centerName)}
            </div>
          )}

          <BowlingBookingCard bc={bc} kind={kind} cfg={cfg} />

          {bc.players.length > 0 && !bc.isCancelled && bc.laneReadyPhase !== "running" && (
            <BowlingPlayerSummary
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              onEditClick={() => { bc.setPlayersSaved(false); bc.setBowlerModalOpen(true); }}
            />
          )}
        </div>

        {/* RIGHT */}
        <div className="lg:col-span-2 space-y-4">
          {!bc.isCancelled && bc.hasNeonRecord && bc.laneReadyPhase !== "idle" && (
            <BowlingLaneStatus
              laneReadyPhase={bc.laneReadyPhase}
              laneReadyLabel={bc.laneReadyLabel}
              neonId={bc.neonId}
              responsive="desktop"
            />
          )}

          {bc.players.length > 0 && !bc.isCancelled && bc.laneReadyPhase !== "running" && (
            <BowlingPlayerCta
              players={bc.players}
              shoePairsAllowed={bc.shoePairsAllowed}
              onOpen={() => { bc.setPlayersSaved(false); bc.setBowlerModalOpen(true); }}
              responsive="desktop"
            />
          )}

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

          {!bc.isCancelled && (
            <BowlingArrivalInstructions displayRemaining={bc.displayRemaining} cfg={cfg} />
          )}

          <BowlingReschedulePanel bc={bc} cfg={cfg} />
          <BowlingCancelSection bc={bc} />
        </div>
      </div>
    </>
  );
}

// ── Bowling Fallback (when Neon insert failed — no shortCode/neonId) ──────

/**
 * When the Neon insert fails during checkout, we have no shortCode or neonId
 * to feed the full BowlingSection hook. This fallback renders the booking
 * details from sessionStorage so the customer still sees what they booked.
 *
 * They won't get player editing, lane-ready polling, or reschedule — but
 * the booking IS confirmed (QAMF + Square both succeeded). The notification
 * pipeline also failed (depends on Neon ID), so we tell them to watch for
 * a follow-up or contact Guest Services.
 */
function BowlingFallbackSection({ data }: { data: ConfirmationData }) {
  const b = data.bowling;
  if (!b) return null;

  const playerCount = typeof b.players === "number" ? b.players : b.players?.length ?? 0;
  const depositDollars = (b.depositCents ?? data.depositPaidCents ?? 0) / 100;
  const totalDollars = b.totalCents / 100;
  const remainingDollars = Math.max(0, totalDollars - depositDollars);
  const bookingDate = b.bookedAt ? formatDate(b.bookedAt.split("T")[0]) : "";
  const bookingTime = b.bookedAt ? formatTime(b.bookedAt) : b.timeLabel || "";

  return (
    <div className="space-y-4">
      {/* Warning: degraded mode */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-amber-400 text-sm font-semibold mb-1">Booking details are limited</p>
        <p className="text-white/60 text-xs leading-relaxed">
          Your bowling lane is reserved and your payment has been processed, but we
          couldn&apos;t save the full booking record. You may not receive a confirmation
          email — please check in at the front desk when you arrive or contact Guest
          Services if you have questions.
        </p>
        {data.qamfReservationId && (
          <p className="text-white/40 text-xs mt-2">
            QAMF Ref: <span className="font-mono text-amber-400/80">{data.qamfReservationId}</span>
          </p>
        )}
      </div>

      {/* Static booking card */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-4">
        <div>
          <p className="text-white text-lg font-bold">{b.experienceName}</p>
          {bookingDate && (
            <p className="text-white/50 text-sm mt-1">
              {bookingDate}{bookingTime ? ` · ${bookingTime}` : ""}
            </p>
          )}
          {playerCount > 0 && (
            <p className="text-white/40 text-xs mt-1">
              {playerCount} {playerCount === 1 ? "player" : "players"}
            </p>
          )}
        </div>

        {/* Line items */}
        {b.lineItems && b.lineItems.length > 0 && (
          <div className="border-t border-white/8 pt-3 space-y-1.5">
            {b.lineItems.map((li, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span className="text-white/60">{li.name}</span>
                <span className="text-white/40">×{li.quantity}</span>
              </div>
            ))}
          </div>
        )}

        {/* Payment */}
        <div className="border-t border-white/8 pt-3 space-y-1.5">
          {depositDollars > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Deposit paid</span>
              <span className="text-[#00E2E5] font-bold">${depositDollars.toFixed(2)}</span>
            </div>
          )}
          {remainingDollars > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-white/30">Remaining</span>
              <span className="text-white/40">${remainingDollars.toFixed(2)} due day-of</span>
            </div>
          )}
        </div>
      </div>

      {/* Arrival instructions */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <p className="text-white/30 text-xs font-bold uppercase tracking-wider mb-3">When You Arrive</p>
        <ul className="space-y-2 text-white/60 text-sm">
          <li className="flex items-start gap-2">
            <span className="text-[#00E2E5] shrink-0">✓</span>
            Check in at the front desk with your name
          </li>
          <li className="flex items-start gap-2">
            <span className="text-[#00E2E5] shrink-0">✓</span>
            Arrive 10-15 minutes early to get settled
          </li>
          <li className="flex items-start gap-2">
            <span className="text-[#00E2E5] shrink-0">✓</span>
            Shoe rentals available at the desk
          </li>
        </ul>
      </div>
    </div>
  );
}

// ── Attractions Section (non-racing BMI items) ─────────────────────────────

function AttractionsSection({
  attractions,
  reservationNumber,
}: {
  attractions: ConfirmationData["attractions"];
  reservationNumber?: string | null;
}) {
  if (!attractions || attractions.length === 0) return null;

  // Filter out racing items (those are handled by RacingSection).
  // "Racing" doesn't contain "race" (r-a-c-i vs r-a-c-e), so match both.
  const nonRacingItems = attractions.filter(
    (a) => !/racing|race|kart/i.test(a.name),
  );
  if (nonRacingItems.length === 0) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-4">
      <div>
        <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest mb-1">
          Your Attractions
        </p>
        {reservationNumber && (
          <p className="text-white/30 text-xs">
            Reservation <span className="font-mono text-[#00E2E5]/70">{reservationNumber}</span>
          </p>
        )}
      </div>

      <div className="space-y-3">
        {nonRacingItems.map((item, i) => (
          <div
            key={i}
            className="flex justify-between items-start px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]"
          >
            <div>
              <p className="text-white text-sm font-semibold">{item.name}</p>
              {item.date && (
                <p className="text-white/40 text-xs">
                  {formatDate(item.date)}
                  {item.time ? ` · ${formatTime(item.time)}` : ""}
                </p>
              )}
            </div>
            {item.quantity > 1 && (
              <span className="text-white/30 text-xs shrink-0 ml-3">x{item.quantity}</span>
            )}
          </div>
        ))}
      </div>

      {/* Waiver prompt for attractions that need it */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-amber-300 text-sm font-semibold mb-1">Waivers Required</p>
        <p className="text-white/60 text-xs leading-relaxed">
          Each participant must complete a waiver before their activity.
          Waivers will be available at Guest Services when you arrive.
        </p>
      </div>
    </div>
  );
}

// ── Payment Summary ────────────────────────────────────────────────────────

function PaymentSummary({ data }: { data: ConfirmationData }) {
  const depositDollars = data.depositPaidCents ? (data.depositPaidCents / 100).toFixed(2) : null;
  const totalDollars = data.totalCents ? (data.totalCents / 100).toFixed(2) : null;
  const remaining = data.totalCents && data.depositPaidCents
    ? ((data.totalCents - data.depositPaidCents) / 100).toFixed(2)
    : null;

  if (!depositDollars && !totalDollars) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
      <p className="text-white/30 text-xs font-bold uppercase tracking-wider">Payment Summary</p>
      {depositDollars && (
        <div className="flex justify-between text-sm">
          <span className="text-white/50">Deposit paid</span>
          <span className="text-[#00E2E5] font-bold">${depositDollars}</span>
        </div>
      )}
      {remaining && remaining !== "0.00" && (
        <div className="flex justify-between text-xs">
          <span className="text-white/30">Remaining balance</span>
          <span className="text-white/40">${remaining} due day-of</span>
        </div>
      )}
    </div>
  );
}

// ── Confirmation Warnings ──────────────────────────────────────────────────

function ConfirmationWarnings({ data }: { data: ConfirmationData }) {
  const issues: string[] = [];
  if (data.bmiConfirmed === false && data.bmiBillId) issues.push("attraction reservation");
  if (data.qamfConfirmed === false && data.qamfReservationId) issues.push("bowling reservation");

  // Detect Neon insert failure: bowling data exists but no Neon ID was returned
  const bowlingNeonFailed = !!data.bowling && !data.bowlingNeonId && !data.bowlingShortCode;

  if (issues.length === 0 && !bowlingNeonFailed) return null;

  return (
    <div className="space-y-2">
      {issues.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-left">
          <p className="text-amber-400 text-xs">
            ⚠️ Your {issues.join(" and ")} confirmation is still processing.
            Your payment has been received — our team will follow up if any action is needed.
          </p>
        </div>
      )}
      {bowlingNeonFailed && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-left">
          <p className="text-red-400 text-xs">
            ⚠️ Your lane is reserved and payment is confirmed, but we couldn&apos;t save the
            booking record. You may not receive a confirmation email. Please check in at the
            front desk with your name when you arrive.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Debug Panel (preview/localhost only) ────────────────────────────────────

function DebugPanel({ steps }: { steps: DebugStep[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border-2 border-amber-500/50 bg-amber-500/5 p-4 text-left">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-amber-400 text-xs font-bold uppercase tracking-wider"
      >
        <span>Debug: {steps.length} checkout steps</span>
        <span className="text-amber-400/60">{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {steps.map((step, i) => {
            const icon = step.status === "ok" ? "✓" : step.status === "fail" ? "✗" : "⊘";
            const color = step.status === "ok" ? "text-green-400" : step.status === "fail" ? "text-red-400" : "text-white/30";
            return (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`font-mono font-bold ${color} shrink-0`}>{icon}</span>
                <div className="min-w-0">
                  <span className="text-white/70">{step.name}</span>
                  {step.ms != null && <span className="text-white/30 ml-1">({step.ms}ms)</span>}
                  {step.status === "fail" && step.detail && (
                    <p className="text-red-400/70 mt-0.5 break-words">{step.detail}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Content (inside Suspense) ─────────────────────────────────────────

function ConfirmationContent() {
  const sp = useSearchParams();
  const codeParam = sp.get("code") ?? "";
  const neonIdParam = sp.get("neonId") ?? "";

  const [data, setData] = useState<ConfirmationData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isPreview, setIsPreview] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Try sessionStorage first (set by checkout page before redirect)
      try {
        const raw = sessionStorage.getItem("checkoutConfirmation");
        if (raw) {
          setData(JSON.parse(raw));
          sessionStorage.removeItem("checkoutConfirmation");
          setIsPreview(
            window.location.hostname.endsWith(".vercel.app") ||
            window.location.hostname === "localhost",
          );
          setLoaded(true);
          return;
        }
      } catch { /* continue to API fallback */ }

      // 2. Fallback: fetch from confirmation API (page refresh case)
      const lookupKey = codeParam || neonIdParam;
      if (lookupKey) {
        try {
          const param = codeParam ? `code=${codeParam}` : `neonId=${neonIdParam}`;
          const res = await fetch(`/api/checkout/v2/confirmation?${param}`);
          if (res.ok && !cancelled) {
            const apiData = await res.json();
            setData(apiData);
          }
        } catch { /* non-fatal — show generic confirmed */ }
      }

      if (!cancelled) {
        setIsPreview(
          window.location.hostname.endsWith(".vercel.app") ||
          window.location.hostname === "localhost",
        );
        setLoaded(true);
      }
    })();

    return () => { cancelled = true; };
  }, [codeParam, neonIdParam]);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-[#000418]">
        <BrandNav />
        <div className="flex justify-center py-32">
          <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Determine what booking types are present.
  // Use bookingType from API/sessionStorage as primary signal, with field
  // presence as fallback. Don't use shortCode — that's universal, not bowling-specific.
  const hasBowling =
    data?.bookingType === "bowling" ||
    data?.bookingType === "mixed" ||
    !!data?.bowling ||
    !!data?.bowlingNeonId;
  const hasRacing =
    data?.bookingType === "racing" ||
    data?.bookingType === "mixed" ||
    (!!data?.isRacingCart && !!data?.bmiBillId);
  const hasAttractions = !!data?.attractions?.length;
  const isMultiType = [hasBowling, hasRacing, hasAttractions].filter(Boolean).length > 1;
  const bowlingKind: BowlingConfirmationKind = (data?.bowlingKind as BowlingConfirmationKind) || "open";

  // Bowling shortCode: use URL param only when we know bowling is present
  const bowlingShortCode = hasBowling ? (data?.bowlingShortCode || codeParam || undefined) : undefined;
  const bowlingNeonId = data?.bowlingNeonId || undefined;

  // Racing-only bookings get the hero banner with track photo
  const showRacingHero = hasRacing && !hasBowling;

  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />

      {/* Racing hero banner (full-width, with track photo background) */}
      {showRacingHero && (
        <RacingHero
          loading={false}
          bookingType={data?.bookingType === "racing" ? "racing" : "attraction"}
        />
      )}

      <main className={`${showRacingHero ? "pb-24 px-4 sm:px-6" : "pt-28 sm:pt-36 pb-24 px-4 sm:px-6"}`}>
        <div className="max-w-5xl mx-auto space-y-8">

          {/* ── Non-racing hero (bowling-only, attractions-only, mixed without racing) ── */}
          {!showRacingHero && (
            <div className="text-center">
              <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white mb-2">
                You&apos;re All Set!
              </h1>
              <p className="text-white/50 text-sm">
                Your booking is confirmed.{" "}
                {data?.guestEmail && (
                  <>A confirmation has been sent to <span className="text-white/70">{data.guestEmail}</span>.</>
                )}
              </p>
            </div>
          )}

          {/* ── Confirmation warning (edge case: partial confirm) ── */}
          {data && <ConfirmationWarnings data={data} />}

          {/* ── No data fallback ── */}
          {!data && (
            <div className="text-center space-y-4">
              <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white">
                Booking Confirmed
              </h1>
              <p className="text-white/50 text-sm">
                Your booking is confirmed! Check your email for full details and your confirmation link.
              </p>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════
               BOWLING SECTION
             ══════════════════════════════════════════════════════ */}
          {hasBowling && (
            <section>
              {isMultiType && (
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <h2 className="text-white/40 text-xs font-bold uppercase tracking-[0.2em]">Bowling</h2>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              {(bowlingShortCode || bowlingNeonId) ? (
                <BowlingSection
                  shortCode={bowlingShortCode as string | undefined}
                  neonId={bowlingNeonId as number | undefined}
                  kind={bowlingKind}
                />
              ) : (
                /* Neon insert failed — show static fallback from sessionStorage */
                data && <BowlingFallbackSection data={data} />
              )}
            </section>
          )}

          {/* ══════════════════════════════════════════════════════
               RACING SECTION
             ══════════════════════════════════════════════════════ */}
          {hasRacing && data && (
            <section>
              {isMultiType && (
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <h2 className="text-white/40 text-xs font-bold uppercase tracking-[0.2em]">Racing</h2>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <RacingSection data={data} />
            </section>
          )}

          {/* ══════════════════════════════════════════════════════
               ATTRACTIONS SECTION (non-racing BMI items)
             ══════════════════════════════════════════════════════ */}
          {hasAttractions && !hasRacing && data && (
            <section>
              {isMultiType && (
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <h2 className="text-white/40 text-xs font-bold uppercase tracking-[0.2em]">Attractions</h2>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <AttractionsSection
                attractions={data.attractions}
                reservationNumber={data.bmiReservationNumber}
              />
            </section>
          )}

          {/* Attraction items when racing is also present (mixed cart) */}
          {hasAttractions && hasRacing && data && (
            <section>
              {isMultiType && (
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <h2 className="text-white/40 text-xs font-bold uppercase tracking-[0.2em]">Attractions</h2>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <AttractionsSection
                attractions={data.attractions}
                reservationNumber={data.bmiReservationNumber}
              />
            </section>
          )}

          {/* ── Payment summary (when bowling doesn't show its own) ── */}
          {!hasBowling && data && <PaymentSummary data={data} />}

          {/* ── Reference numbers (fallback for when sections don't show them) ── */}
          {data && !hasBowling && !hasRacing && (data.bmiReservationNumber || data.qamfReservationId) && (
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
              <p className="text-white/30 text-xs font-bold uppercase tracking-wider mb-2">Reference</p>
              {data.bmiReservationNumber && (
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-white/40">Reservation #</span>
                  <span className="font-mono text-[#00E2E5]">{data.bmiReservationNumber}</span>
                </div>
              )}
              {data.qamfReservationId && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Bowling Ref</span>
                  <span className="font-mono text-[#00E2E5]">{data.qamfReservationId}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Debug panel (preview only) ── */}
          {isPreview && data?._debug && data._debug.length > 0 && (
            <DebugPanel steps={data._debug} />
          )}

          {/* ── Actions ── */}
          <div className="flex flex-col gap-3 max-w-md mx-auto">
            <Link
              href="/book"
              className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors text-center shadow-lg shadow-[#00E2E5]/25"
            >
              Book More Activities
            </Link>
            <Link
              href="/"
              className="w-full py-3 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors text-center"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Loading Skeleton ───────────────────────────────────────────────────────

function ConfirmationSkeleton() {
  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />
      <main className="pt-28 pb-20 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col items-center gap-4 mb-8">
            <div className="w-20 h-20 rounded-full bg-white/5 animate-pulse" />
            <div className="h-8 w-64 rounded bg-white/5 animate-pulse" />
            <div className="h-4 w-48 rounded bg-white/5 animate-pulse" />
          </div>
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

// ── Exported Page Component ────────────────────────────────────────────────

export default function CheckoutConfirmation() {
  return (
    <Suspense fallback={<ConfirmationSkeleton />}>
      <ConfirmationContent />
    </Suspense>
  );
}
