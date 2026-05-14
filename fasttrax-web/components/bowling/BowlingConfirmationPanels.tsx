"use client";

import { useState } from "react";
import Link from "next/link";
import type { BowlingReservationPlayer } from "@/lib/bowling-db";
import {
  centsToDollars,
  fmtTimeET,
  type ReservationWithLines,
  type LaneReadyPhase,
  type CancelPhase,
  type RescheduleInfo,
  type UseBowlingConfirmationReturn,
} from "@/hooks/useBowlingConfirmation";

// ── Constants ──────────────────────────────────────────────────────────────

const CORAL = "#fd5b56";
const NAVY = "#123075";
const GOLD = "#FFD700";

// ── Shoe size catalog (used by BowlerCard) ─────────────────────────────────

const TODDLER_SIZES = ["6","7","8","9","10","11","12","13"];
const MALE_SIZES    = ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","12.5","13","13.5","14","14.5","15"];
const FEMALE_SIZES  = ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12"];

type ShoeCategory = "Toddler" | "Male" | "Female";

export type BowlingConfirmationKind = "kbf" | "open";

// ── Small helpers ──────────────────────────────────────────────────────────

export function Row({
  label,
  value,
  mono,
  green,
}: {
  label: string;
  value: string;
  mono?: boolean;
  green?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-white/50 shrink-0">{label}</span>
      <span
        className={`text-right ${mono ? "font-mono" : ""} ${green ? "text-green-400 font-semibold" : "text-white"}`}
        style={mono ? { letterSpacing: "0.4px" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

export function DividerLine() {
  return <div className="border-t border-white/10 my-2" />;
}

// ── Kind-specific config ───────────────────────────────────────────────────

export interface KindConfig {
  heroLabel: string;
  heroSubtitle: (hasPaidDeposit: boolean) => string;
  fetchFailNote: (centerName: string) => string;
  linesHeader: string;
  arrivalBullets: (displayRemaining: number) => React.ReactNode;
  changeLink?: { href: string; label: string };
  navLinks: { href: string; label: string }[];
}

export const KIND_CONFIG: Record<BowlingConfirmationKind, KindConfig> = {
  kbf: {
    heroLabel: "Kids Bowl Free · Confirmed",
    heroSubtitle: (hasPaidDeposit) =>
      hasPaidDeposit
        ? "Your deposit has been charged and your lane is reserved. Bring this confirmation when you arrive."
        : "Your lane is reserved. Show this confirmation (or your Kids Bowl Free coupon email) at the front desk.",
    fetchFailNote: (centerName) =>
      `Bring your KBF coupon to ${centerName} and the front desk will find it.`,
    linesHeader: "Add-ons",
    arrivalBullets: (displayRemaining) => (
      <>
        <li>Show this confirmation at the front desk.</li>
        <li>Bring your Kids Bowl Free coupon or season pass.</li>
        <li>Your lane is held until 5 minutes after start time.</li>
        {displayRemaining > 0 && (
          <li>
            Your remaining balance of{" "}
            <span className="text-white font-semibold">
              {centsToDollars(displayRemaining)}
            </span>{" "}
            is due at the center.
          </li>
        )}
      </>
    ),
    changeLink: { href: "/hp/book/kids-bowl-free", label: "Change Date & Time" },
    navLinks: [
      { href: "/hp/kids-bowl-free", label: "Kids Bowl Free info" },
      { href: "/hp/book", label: "Book something else" },
    ],
  },

  open: {
    heroLabel: "Open Bowling · Confirmed",
    heroSubtitle: () =>
      "Your deposit has been charged and your lane is reserved. Bring this confirmation when you arrive.",
    fetchFailNote: () => "Please show your booking reference at the front desk.",
    linesHeader: "Order",
    arrivalBullets: (displayRemaining) => (
      <>
        <li>Show this confirmation at the front desk.</li>
        <li>Rental shoes are available at the front counter.</li>
        <li>Your lane is held until 10 minutes after start time.</li>
        {displayRemaining > 0 && (
          <li>
            Your remaining balance of{" "}
            <span className="text-white font-semibold">
              {centsToDollars(displayRemaining)}
            </span>{" "}
            is due at the center.
          </li>
        )}
      </>
    ),
    changeLink: { href: "/hp/book/bowling", label: "Change Date & Time" },
    navLinks: [
      { href: "/hp/book/bowling", label: "Book another lane" },
      { href: "/hp/book", label: "Book something else" },
    ],
  },
};

// ── BowlingHeroCard ────────────────────────────────────────────────────────

export function BowlingHeroCard({
  isCancelled,
  hasPaidDeposit,
  cancelRefundCents,
  refundCents,
  cfg,
}: {
  isCancelled: boolean;
  hasPaidDeposit: boolean;
  cancelRefundCents: number;
  refundCents: number;
  cfg: KindConfig;
}) {
  return (
    <div
      className="rounded-2xl border p-6 sm:p-8"
      style={{
        backgroundColor: isCancelled ? "rgba(253,91,86,0.05)" : "rgba(34,197,94,0.08)",
        borderColor: isCancelled ? `${CORAL}55` : "rgba(34,197,94,0.35)",
      }}
    >
      <div
        className="uppercase font-bold mb-2"
        style={{ color: isCancelled ? CORAL : "#22c55e", fontSize: "11px", letterSpacing: "3px" }}
      >
        {isCancelled ? "Booking cancelled" : cfg.heroLabel}
      </div>
      <h1
        className="font-heading font-black uppercase italic mb-2"
        style={{
          fontSize: "clamp(28px, 5vw, 40px)",
          lineHeight: 1.05,
          color: isCancelled ? "rgba(255,255,255,0.35)" : "white",
          textDecoration: isCancelled ? "line-through" : "none",
        }}
      >
        You&apos;re booked!
      </h1>
      <p className="text-white/70 text-sm leading-relaxed">
        {isCancelled
          ? "This booking has been cancelled."
          : cfg.heroSubtitle(hasPaidDeposit)}
      </p>

      {/* Refund line — shown directly in hero when cancelled */}
      {isCancelled && (() => {
        const refund = cancelRefundCents || refundCents;
        return refund > 0 ? (
          <p className="text-white/55 text-sm mt-2">
            {centsToDollars(refund)} refund will appear on your card in 3–5 business days.
          </p>
        ) : (
          <p className="text-white/55 text-sm mt-2">No charges were made.</p>
        );
      })()}
    </div>
  );
}

// ── BowlingLaneStatus ──────────────────────────────────────────────────────

export function BowlingLaneStatus({
  laneReadyPhase,
  laneReadyLabel,
  neonId,
  responsive,
}: {
  laneReadyPhase: LaneReadyPhase;
  laneReadyLabel: string;
  neonId: number;
  /** "mobile" = shown on mobile only, "desktop" = lg only, "both" = always shown */
  responsive?: "mobile" | "desktop" | "both";
}) {
  const vis = responsive === "desktop" ? "hidden lg:block" : responsive === "mobile" ? "lg:hidden" : "";
  return (
    <div className={`${vis} space-y-3`}>
      {laneReadyPhase === "not_ready" && (
        <div
          className="w-full rounded-2xl border px-5 py-3.5 flex items-center gap-3"
          style={{ backgroundColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" }}
        >
          <span style={{ fontSize: "18px" }}>🔴</span>
          <div>
            <p className="text-sm font-semibold" style={{ color: "#f87171" }}>Lane Not Ready Yet</p>
            <p className="text-xs text-white/45 mt-0.5">We&apos;ll let you know as soon as it&apos;s set up.</p>
          </div>
        </div>
      )}
      {laneReadyPhase === "ready" && (
        <button
          type="button"
          onClick={() => { window.location.href = `/hp/book/bowling/checkin?neonId=${neonId}`; }}
          className="w-full py-4 rounded-2xl font-body font-black uppercase tracking-wider text-white transition-all hover:scale-[1.02] active:scale-100"
          style={{
            background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
            fontSize: "15px",
            letterSpacing: "1.5px",
            boxShadow: "0 4px 24px rgba(34,197,94,0.4)",
          }}
        >
          🎳 Your Lane is Ready! Check In Now!
        </button>
      )}
      {laneReadyPhase === "running" && (
        <div
          className="rounded-2xl border p-5 text-center space-y-1"
          style={{ backgroundColor: "rgba(74,222,128,0.07)", borderColor: "rgba(74,222,128,0.3)" }}
        >
          <p className="font-heading font-black uppercase italic" style={{ color: "#4ade80", fontSize: "clamp(18px,4vw,22px)" }}>
            {laneReadyLabel ? `${laneReadyLabel} is open!` : "Your lane is open!"}
          </p>
          <p className="text-white/60 text-sm">🥿 Shoes will be delivered directly to you.</p>
        </div>
      )}
    </div>
  );
}

// ── BowlingPlayerCta ───────────────────────────────────────────────────────

export function BowlingPlayerCta({
  players,
  shoePairsAllowed,
  onOpen,
  responsive,
}: {
  players: BowlingReservationPlayer[];
  shoePairsAllowed: number;
  onOpen: () => void;
  responsive?: "mobile" | "desktop" | "both";
}) {
  const vis = responsive === "desktop" ? "hidden lg:block" : responsive === "mobile" ? "lg:hidden" : "";
  const noDataYet = !players.some((p) => p.shoeSize || (p.name && !p.name.startsWith("Bowler ")));
  return (
    <div className={vis}>
      <button
        type="button"
        onClick={onOpen}
        className={`w-full py-3.5 rounded-xl font-body font-bold uppercase tracking-wider text-white transition-all hover:scale-[1.02] active:scale-100 ${
          noDataYet ? "cta-pulse-glow" : ""
        }`}
        style={{
          backgroundColor: CORAL,
          fontSize: "14px",
          letterSpacing: "1.5px",
        }}
      >
        {shoePairsAllowed > 0
          ? "Enter Names & Shoe Sizes"
          : "Enter Bowler Names"}
      </button>
    </div>
  );
}

// ── BowlingBookingCard ─────────────────────────────────────────────────────

export function BowlingBookingCard({
  bc,
  kind,
  cfg,
}: {
  bc: UseBowlingConfirmationReturn;
  kind: BowlingConfirmationKind;
  cfg: KindConfig;
}) {
  const { reservation, isCancelled, qamfId, centerName, centerAddress, dateLabel, playerCount, guestName, lines, players } = bc;
  const { displayTotal, displayDepositPaid, hasPaidDeposit, hasRewardsLinked, rewardDiscountCents, displayRemaining } = bc;
  return (
    <div
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-3 relative overflow-hidden"
      style={isCancelled ? { opacity: 0.45 } : undefined}
    >
      {/* CANCELED stamp overlay */}
      {isCancelled && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ zIndex: 1 }}
        >
          <div
            className="font-heading font-black uppercase italic rotate-[-18deg] select-none"
            style={{
              fontSize: "clamp(52px, 10vw, 72px)",
              color: CORAL,
              opacity: 0.18,
              letterSpacing: "4px",
              lineHeight: 1,
            }}
          >
            Canceled
          </div>
        </div>
      )}
      {qamfId && <Row label="Booking ref" value={qamfId} mono />}
      <Row label="Center" value={centerName} />
      {centerAddress && <Row label="Address" value={centerAddress} />}
      {dateLabel && <Row label="When" value={dateLabel} />}
      {playerCount != null && <Row label="Bowlers" value={String(playerCount)} />}
      {guestName && <Row label="Guest" value={guestName} />}

      {/* KBF program info banner */}
      {kind === "kbf" && players.length > 0 && (() => {
        const kidCount = players.filter((p) => p.kbfRelation === "kid").length;
        const freeAdultCount = players.filter((p) => p.kbfRelation === "family").length;
        const paidAdultCount = players.filter((p) => p.kbfRelation === null).length;
        const isVip = lines.some((l) => /vip/i.test(l.label));
        return (
          <>
            <DividerLine />
            <div
              className="rounded-xl px-4 py-3 space-y-1"
              style={{ backgroundColor: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.18)" }}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">🎳</span>
                <span className="font-body font-bold text-sm" style={{ color: "#4ade80" }}>
                  Kids Bowl Free{isVip ? " · VIP" : ""} Reservation
                </span>
              </div>
              <p className="text-white/60 text-xs font-body leading-relaxed">
                {kidCount} {kidCount === 1 ? "kid" : "kids"} bowl free
                {freeAdultCount > 0 && ` · ${freeAdultCount} ${freeAdultCount === 1 ? "adult" : "adults"} free (Family Pass)`}
                {paidAdultCount > 0 && ` · ${paidAdultCount} paid ${paidAdultCount === 1 ? "adult" : "adults"}`}
                {" · 2 games per bowler"}
              </p>
            </div>
          </>
        );
      })()}

      {/* Line items */}
      {lines.length > 0 && (() => {
        const linesSubtotal = lines.reduce(
          (s, l) => s + l.unitPriceCents * l.quantity,
          0,
        );
        const taxAndFees = displayTotal - linesSubtotal;
        return (
          <>
            <DividerLine />
            <div>
              <div
                className="uppercase font-bold mb-2"
                style={{
                  color: "rgba(255,255,255,0.35)",
                  fontSize: "10px",
                  letterSpacing: "2.5px",
                }}
              >
                {cfg.linesHeader}
              </div>
              <div className="space-y-1.5">
                {lines.map((line, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-white/75">
                      {line.label}
                      {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                    </span>
                    <span className="text-white">
                      {line.unitPriceCents === 0
                        ? "Free"
                        : centsToDollars(line.unitPriceCents * line.quantity)}
                    </span>
                  </div>
                ))}
                {taxAndFees > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-white/50">Tax &amp; fees</span>
                    <span className="text-white/50">
                      {centsToDollars(taxAndFees)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}

      {/* Attraction add-ons */}
      {reservation?.attractionBookings && reservation.attractionBookings.length > 0 && (
        <>
          <DividerLine />
          <div className="space-y-1.5">
            <p className="text-white/40 text-[10px] uppercase tracking-widest font-bold">
              Activities
            </p>
            {reservation.attractionBookings.map((a, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="font-body text-white/60">
                  {a.name}{" "}
                  <span className="text-white/35">
                    {a.quantity}p · {a.timeLabel}
                  </span>
                </span>
                <span className="font-body text-white/50">
                  ${a.totalPriceDollars.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Payment summary */}
      {(hasPaidDeposit || rewardDiscountCents > 0) && (
        <>
          <DividerLine />
          <div className="space-y-1.5">
            {displayTotal > 0 && (
              <Row label="Order total" value={centsToDollars(displayTotal)} />
            )}
            {rewardDiscountCents > 0 && (
              <Row
                label="⭐ HeadPinz Reward"
                value={`-${centsToDollars(rewardDiscountCents)}`}
              />
            )}
            {hasPaidDeposit && (
              <Row
                label="Paid at booking"
                value={centsToDollars(displayDepositPaid)}
                green
              />
            )}
            {displayRemaining > 0 && (
              <Row
                label="Balance due at center"
                value={centsToDollars(displayRemaining)}
              />
            )}
            {displayRemaining === 0 && (
              <Row label="Balance due at center" value="Paid in full" />
            )}
          </div>
        </>
      )}

      {/* HeadPinz Rewards */}
      {hasRewardsLinked && (
        <>
          <DividerLine />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-base">⭐</span>
              <span
                className="uppercase font-bold"
                style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
              >
                HeadPinz Rewards
              </span>
            </div>
            <p className="text-white/55 text-xs leading-relaxed">
              Earning <span className="text-white font-semibold">10 Pinz for every $1</span> spent.
            </p>
            <p className="text-white/30 text-xs">
              Pinz are applied after your reservation is checked in.
            </p>
            <Link
              href="/hp/rewards"
              className="inline-block text-xs font-semibold hover:underline transition-colors"
              style={{ color: GOLD }}
            >
              Check rewards status →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// ── BowlingPlayerSummary ───────────────────────────────────────────────────

export function BowlingPlayerSummary({
  players,
  shoePairsAllowed,
  onEditClick,
}: {
  players: BowlingReservationPlayer[];
  shoePairsAllowed: number;
  onEditClick: () => void;
}) {
  // Only show if at least one player has data
  if (!players.some((p) => p.shoeSize || (p.name && !p.name.startsWith("Bowler ")))) return null;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div
        className="uppercase font-bold mb-3"
        style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
      >
        Bowler Details
      </div>
      <div className="space-y-1.5">
        {players.map((p) => (
          <div key={p.slot} className="flex items-center justify-between text-sm px-1">
            <span className="text-white/70 truncate">{p.name && !p.name.startsWith("Bowler ") ? p.name : `Bowler ${p.slot}`}</span>
            <span className="text-white/40 text-xs flex-shrink-0 ml-2">
              {p.shoeSize ?? "No shoes"}{p.bumpers ? " · Bumpers" : ""}
            </span>
          </div>
        ))}
        {shoePairsAllowed > 0 && (
          <p className="text-white/30 text-xs text-right pt-1">
            {players.filter((pp) => pp.shoeSize).length} of {shoePairsAllowed} shoe pair{shoePairsAllowed !== 1 ? "s" : ""} assigned
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onEditClick}
        className="mt-3 w-full text-center text-xs font-body text-white/40 hover:text-white/70 transition-colors underline underline-offset-2"
      >
        Edit bowler details
      </button>
    </div>
  );
}

// ── BowlingArrivalInstructions ─────────────────────────────────────────────

export function BowlingArrivalInstructions({
  displayRemaining,
  cfg,
}: {
  displayRemaining: number;
  cfg: KindConfig;
}) {
  return (
    <div
      className="rounded-xl border px-5 py-4 space-y-2"
      style={{
        backgroundColor: "rgba(18,48,117,0.35)",
        borderColor: `${NAVY}99`,
      }}
    >
      <div
        className="uppercase font-bold"
        style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
      >
        When you arrive
      </div>
      <ul className="text-white/75 text-sm space-y-1 list-disc list-inside">
        {cfg.arrivalBullets(displayRemaining)}
      </ul>
    </div>
  );
}

// ── BowlingReschedulePanel ─────────────────────────────────────────────────

export function BowlingReschedulePanel({
  bc,
  cfg,
}: {
  bc: UseBowlingConfirmationReturn;
  cfg: KindConfig;
}) {
  const { reservation, hasNeonRecord, isCancelled, isWithin1Hour, laneReadyPhase } = bc;

  if (isCancelled || !hasNeonRecord || !cfg.changeLink || laneReadyPhase === "running" || isWithin1Hour) return null;

  const hasAttractions = (reservation?.attractionBookings?.length ?? 0) > 0;

  // Attractions block reschedule — show greyed-out notice instead
  if (hasAttractions) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="w-full text-center px-5 py-4 font-body font-semibold text-sm text-white/25 cursor-not-allowed">
          {cfg.changeLink.label}
        </div>
        <div className="px-5 pb-4 -mt-1">
          <p className="text-[11px] text-white/30 text-center leading-relaxed">
            Online rescheduling is not available for bookings with attractions. Cancel and rebook if needed.
          </p>
        </div>
      </div>
    );
  }

  // Derive experience label from first non-shoe line item
  const expLabel = reservation?.lines
    ?.find((l) => !/shoe/i.test(l.label))
    ?.label;

  // Build date pills: next 14 days from today in ET
  const allowedDays = bc.rescheduleInfo?.daysOfWeek;
  const datePills: { dateStr: string; dayLabel: string; dateLabel: string; disabled: boolean }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dayLabel = i === 0 ? "Today" : i === 1 ? "Tomorrow"
      : d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
    const dateLabel = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    const jsDay = d.getDay();
    const disabled = Array.isArray(allowedDays) && allowedDays.length > 0 && !allowedDays.includes(jsDay);
    datePills.push({ dateStr, dayLabel, dateLabel, disabled });
  }

  return (
    <div className="rounded-xl border border-[#00E2E5]/25 bg-[#00E2E5]/[0.04] overflow-hidden">
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => bc.rescheduleOpen ? bc.setRescheduleOpen(false) : bc.openReschedule()}
        className="w-full text-center px-5 py-4 font-body font-semibold text-sm text-[#00E2E5] hover:bg-[#00E2E5]/[0.08] transition-colors"
      >
        {bc.rescheduleSuccess ? "Time Updated!" : cfg.changeLink.label}
      </button>

      {/* Reschedule panel */}
      {bc.rescheduleOpen && !bc.rescheduleSuccess && (
        <div className="px-3 sm:px-4 pb-4 space-y-3 border-t border-[#00E2E5]/15">
          {/* Experience constraint notice */}
          <div className="pt-3 space-y-1.5">
            {expLabel && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full bg-[#00E2E5]/15 text-[#00E2E5] border border-[#00E2E5]/20">
                  {expLabel}
                </span>
              </div>
            )}
            <p className="text-[11px] text-white/40 leading-relaxed">
              You can reschedule to a different date or time within the same experience.
              To switch experiences, please cancel and rebook.
            </p>
          </div>

          {/* Loading info */}
          {bc.rescheduleInfoLoading && (
            <p className="text-center text-sm text-white/40 py-4 animate-pulse">
              Loading...
            </p>
          )}

          {/* Info error */}
          {bc.rescheduleInfoError && (
            <p className="text-sm text-center py-2" style={{ color: CORAL }}>
              {bc.rescheduleInfoError}
            </p>
          )}

          {/* Date pills + time slots */}
          {bc.rescheduleInfo && (
            <>
              {/* Scrollable date pills */}
              <div
                className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1"
                style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
              >
                {datePills.map((dp) => {
                  const isActive = bc.rescheduleDate === dp.dateStr;
                  return (
                    <button
                      key={dp.dateStr}
                      type="button"
                      disabled={dp.disabled}
                      onClick={() => bc.setRescheduleDate(dp.dateStr)}
                      className="flex-shrink-0 rounded-lg px-2.5 py-2 text-center transition-colors disabled:cursor-not-allowed"
                      style={{
                        minWidth: 56,
                        opacity: dp.disabled ? 0.25 : 1,
                        backgroundColor: isActive ? "rgba(0,226,229,0.18)" : "rgba(255,255,255,0.05)",
                        border: isActive ? "1.5px solid #00E2E5" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div
                        className="text-[10px] font-bold uppercase tracking-wide"
                        style={{ color: isActive ? "#00E2E5" : "rgba(255,255,255,0.5)" }}
                      >
                        {dp.dayLabel}
                      </div>
                      <div
                        className="text-xs mt-0.5"
                        style={{ color: isActive ? "#00E2E5" : "rgba(255,255,255,0.7)" }}
                      >
                        {dp.dateLabel}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Time slots */}
              {bc.rescheduleSlotsLoading ? (
                <p className="text-center text-sm text-white/30 py-3 animate-pulse">
                  Checking availability...
                </p>
              ) : bc.rescheduleSlots.length === 0 && bc.rescheduleDate ? (
                <p className="text-center text-xs text-white/30 py-3">
                  No times available for this date.
                </p>
              ) : (
                <div
                  className="grid gap-1.5"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}
                >
                  {bc.rescheduleSlots.map((slot) => {
                    const isCurrent = reservation && slot.bookedAt === reservation.bookedAt;
                    const isSelected = bc.rescheduleSelected === slot.bookedAt;
                    return (
                      <button
                        key={slot.bookedAt}
                        type="button"
                        onClick={() => bc.setRescheduleSelected(slot.bookedAt)}
                        disabled={!!isCurrent}
                        className="rounded-lg text-xs font-semibold py-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{
                          backgroundColor: isSelected ? "rgba(0,226,229,0.2)" : "rgba(255,255,255,0.06)",
                          border: isSelected ? "1.5px solid #00E2E5" : "1px solid rgba(255,255,255,0.1)",
                          color: isSelected ? "#00E2E5" : isCurrent ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
                        }}
                      >
                        {fmtTimeET(slot.bookedAt)}
                        {isCurrent && (
                          <span className="block text-[10px] text-white/25 mt-0.5">current</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Error */}
              {bc.rescheduleError && (
                <p className="text-sm text-center" style={{ color: CORAL }}>
                  {bc.rescheduleError}
                </p>
              )}

              {/* Submit */}
              <button
                type="button"
                onClick={() => void bc.handleReschedule()}
                disabled={!bc.rescheduleSelected || bc.rescheduleSubmitting}
                className="w-full rounded-full py-3 text-sm font-body font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: bc.rescheduleSelected && !bc.rescheduleSubmitting ? "#00E2E5" : "rgba(0,226,229,0.15)",
                  color: bc.rescheduleSelected && !bc.rescheduleSubmitting ? "#000418" : "rgba(0,226,229,0.4)",
                }}
              >
                {bc.rescheduleSubmitting ? "Updating..." : "Confirm New Time"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Success message */}
      {bc.rescheduleSuccess && (
        <div className="px-4 pb-4 text-center">
          <p className="text-sm text-emerald-400 font-semibold">
            Your reservation has been moved. Updated confirmation sent!
          </p>
          <p className="text-xs text-white/30 mt-1">Refreshing...</p>
        </div>
      )}
    </div>
  );
}

// ── BowlingCancelSection ───────────────────────────────────────────────────

export function BowlingCancelSection({
  bc,
}: {
  bc: UseBowlingConfirmationReturn;
}) {
  const { isCancelled, hasNeonRecord, isWithin1Hour, cancelPhase, cancelError, displayDepositPaid, reservation, centerPhone } = bc;

  if (isCancelled || !hasNeonRecord) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      {/* Within 1 hour: self-serve disabled — must call center */}
      {isWithin1Hour && cancelPhase === "idle" && (
        <div className="text-center space-y-1">
          <p className="text-sm text-white/50">
            Need to change or cancel? Your reservation starts in less than an hour.
          </p>
          <p className="text-sm text-white/70">
            Please call us
            {centerPhone ? (
              <>
                {" at "}
                <a
                  href={`tel:${centerPhone.replace(/\D/g, "")}`}
                  className="font-semibold text-white hover:underline"
                >
                  {centerPhone}
                </a>
              </>
            ) : ""}{" "}
            to make any changes.
          </p>
        </div>
      )}

      {!isWithin1Hour && cancelPhase === "idle" && (
        <button
          type="button"
          onClick={() => bc.setCancelPhase("confirming")}
          className="w-full text-center text-sm font-body text-white/35 hover:text-white/60 transition-colors underline underline-offset-2"
        >
          Cancel this booking
        </button>
      )}

      {cancelPhase === "confirming" && (
        <div className="text-center space-y-3">
          <p className="text-white/70 text-sm">
            Are you sure you want to cancel?
            {displayDepositPaid > 0
              ? ` Your deposit of ${centsToDollars(displayDepositPaid)} will be refunded within 3–5 business days.`
              : " No charges will be made."}
          </p>
          {cancelError && (
            <p className="text-sm" style={{ color: CORAL }}>{cancelError}</p>
          )}
          <div className="flex gap-2 justify-center">
            <button
              type="button"
              onClick={() => { bc.setCancelPhase("idle"); bc.setCancelError(null); }}
              className="px-5 py-2 rounded-full text-sm font-body font-semibold border border-white/20 text-white/60 hover:text-white transition-colors"
            >
              Keep booking
            </button>
            <button
              type="button"
              onClick={() => void bc.handleCancel()}
              className="px-5 py-2 rounded-full text-sm font-body font-bold text-white transition-colors"
              style={{ backgroundColor: CORAL }}
            >
              Yes, cancel
            </button>
          </div>
        </div>
      )}

      {cancelPhase === "busy" && (
        <p className="text-center text-sm text-white/50 animate-pulse">Cancelling…</p>
      )}
    </div>
  );
}

// ── BowlerModal (re-exported from BowlingConfirmation) ─────────────────────

import { modalBackdropProps } from "@/lib/a11y";

export function BowlerModal({
  players,
  shoePairsAllowed,
  laneNumbers,
  kind,
  playersSaving,
  playersSaved,
  playersError,
  onUpdate,
  onSave,
  onClose,
}: {
  players: BowlingReservationPlayer[];
  shoePairsAllowed: number;
  laneNumbers: number[];
  kind: BowlingConfirmationKind;
  playersSaving: boolean;
  playersSaved: boolean;
  playersError: string | null;
  onUpdate: (slot: number, patch: Partial<BowlingReservationPlayer>) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  // Accordion: track which bowler slot is expanded
  const [expandedSlot, setExpandedSlot] = useState<number | null>(() => {
    const incomplete = players.find(
      (p) => !p.name || p.name.startsWith("Bowler ") || (shoePairsAllowed > 0 && !p.shoeSize),
    );
    return incomplete?.slot ?? players[0]?.slot ?? null;
  });

  function bowlerSummary(p: BowlingReservationPlayer): string {
    const parts: string[] = [];
    if (p.shoeSize) parts.push(p.shoeSize);
    if (p.bumpers) parts.push("Bumpers");
    return parts.length > 0 ? parts.join(" · ") : "Tap to edit";
  }

  function bowlerComplete(p: BowlingReservationPlayer): boolean {
    const hasName = !!p.name && !p.name.startsWith("Bowler ");
    if (shoePairsAllowed > 0) return hasName && !!p.shoeSize;
    return hasName;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl border border-white/15 p-5 sm:p-7 flex flex-col"
        style={{ backgroundColor: "#0e1d3a", maxHeight: "90vh" }}
      >
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors text-xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Header */}
        <div className="text-center mb-5 pr-6">
          <p
            className="font-heading font-black uppercase italic"
            style={{ fontSize: "clamp(20px, 5vw, 26px)", color: "white" }}
          >
            {shoePairsAllowed > 0 ? "Names & Shoe Sizes" : "Bowler Names"}
          </p>
          <p className="text-white/50 text-xs font-body mt-1 leading-relaxed">
            Tap each bowler to fill in their details
          </p>
        </div>

        {/* Scrollable accordion list */}
        <div className="overflow-y-auto flex-1 -mx-1 px-1" style={{ maxHeight: "65vh" }}>
          {laneNumbers.length > 1 ? (
            <div className="space-y-4">
              {laneNumbers.map((laneNum) => (
                <div key={laneNum}>
                  <div className="text-xs font-bold uppercase tracking-widest mb-2 mt-1" style={{ color: GOLD }}>
                    Lane {laneNum}
                  </div>
                  <div className="space-y-2">
                    {players
                      .filter((p) => (p.laneNumber ?? laneNumbers[0]) === laneNum)
                      .map((player) => (
                        <BowlerAccordionItem
                          key={player.slot}
                          player={player}
                          expandedSlot={expandedSlot}
                          setExpandedSlot={setExpandedSlot}
                          bowlerComplete={bowlerComplete}
                          bowlerSummary={bowlerSummary}
                          shoePairsAllowed={shoePairsAllowed}
                          players={players}
                          kind={kind}
                          onUpdate={onUpdate}
                          laneNumbers={laneNumbers}
                          currentLane={laneNum}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {players.map((player) => (
                <BowlerAccordionItem
                  key={player.slot}
                  player={player}
                  expandedSlot={expandedSlot}
                  setExpandedSlot={setExpandedSlot}
                  bowlerComplete={bowlerComplete}
                  bowlerSummary={bowlerSummary}
                  shoePairsAllowed={shoePairsAllowed}
                  players={players}
                  kind={kind}
                  onUpdate={onUpdate}
                />
              ))}
            </div>
          )}
        </div>

        {/* Shoe pair counter */}
        {shoePairsAllowed > 0 && (
          <p className="text-white/35 text-xs mt-3 text-right font-body">
            {players.filter((p) => p.shoeSize).length} of {shoePairsAllowed} shoe pair{shoePairsAllowed !== 1 ? "s" : ""} assigned
          </p>
        )}

        {/* Error */}
        {playersError && (
          <div
            className="rounded-xl p-3 text-sm font-body mt-3"
            style={{
              backgroundColor: "rgba(253,91,86,0.12)",
              border: "1.5px solid rgba(253,91,86,0.35)",
              color: CORAL,
            }}
          >
            {playersError}
          </div>
        )}

        {/* Save button */}
        <button
          type="button"
          onClick={onSave}
          disabled={playersSaving || playersSaved}
          className="mt-4 w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          style={{ backgroundColor: playersSaved ? "rgba(74,222,128,0.25)" : CORAL }}
        >
          {playersSaving
            ? "Saving…"
            : playersSaved
              ? "✓ Saved"
              : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── BowlerAccordionItem (used by BowlerModal) ─────────────────────────────

function BowlerAccordionItem({
  player,
  expandedSlot,
  setExpandedSlot,
  bowlerComplete,
  bowlerSummary,
  shoePairsAllowed,
  players,
  kind,
  onUpdate,
  laneNumbers,
  currentLane,
}: {
  player: BowlingReservationPlayer;
  expandedSlot: number | null;
  setExpandedSlot: (slot: number | null) => void;
  bowlerComplete: (p: BowlingReservationPlayer) => boolean;
  bowlerSummary: (p: BowlingReservationPlayer) => string;
  shoePairsAllowed: number;
  players: BowlingReservationPlayer[];
  kind: BowlingConfirmationKind;
  onUpdate: (slot: number, patch: Partial<BowlingReservationPlayer>) => void;
  laneNumbers?: number[];
  currentLane?: number;
}) {
  const isExpanded = expandedSlot === player.slot;
  const displayName = player.name && !player.name.startsWith("Bowler ") ? player.name : `Bowler ${player.slot}`;

  if (isExpanded) {
    return (
      <div className="rounded-xl border border-white/15 bg-white/[0.03] overflow-hidden">
        <button
          type="button"
          onClick={() => setExpandedSlot(null)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-white font-body font-semibold text-sm">{displayName}</span>
          <span className="text-white/30 text-xs">▲</span>
        </button>
        <div className="px-4 pb-4">
          <BowlerCard
            player={player}
            shoePairsAllowed={shoePairsAllowed}
            shoeSizesAssigned={players.filter((p) => p.shoeSize).length}
            kind={kind}
            onUpdate={(patch) => onUpdate(player.slot, patch)}
          />
        </div>
        {/* Lane move buttons (multi-lane only) */}
        {laneNumbers && laneNumbers.length > 1 && currentLane != null && (
          <div className="flex gap-1.5 px-4 pb-3">
            <span className="text-white/30 text-xs self-center">Move to:</span>
            {laneNumbers.filter((ln) => ln !== currentLane).map((ln) => (
              <button
                key={ln}
                type="button"
                onClick={() => onUpdate(player.slot, { laneNumber: ln })}
                className="px-2.5 py-1 rounded-lg text-xs font-body font-semibold border border-white/15 text-white/50 hover:text-white hover:border-white/35 transition-colors"
              >
                Lane {ln}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setExpandedSlot(player.slot)}
      aria-label={`Edit ${displayName}`}
      className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-colors text-left"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: bowlerComplete(player) ? "#4ade80" : "rgba(255,255,255,0.2)" }}
        />
        <span className="text-white font-body font-semibold text-sm truncate">{displayName}</span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-white/40 text-xs">{bowlerSummary(player)}</span>
        <span className="text-white/30 text-xs">▼</span>
      </div>
    </button>
  );
}

// ── BowlerCard (individual bowler editing) ─────────────────────────────────

export function BowlerCard({
  player,
  shoePairsAllowed,
  shoeSizesAssigned,
  kind,
  onUpdate,
}: {
  player: BowlingReservationPlayer;
  shoePairsAllowed: number;
  shoeSizesAssigned: number;
  kind: BowlingConfirmationKind;
  onUpdate: (patch: Partial<BowlingReservationPlayer>) => void;
}) {
  const nameReadOnly = kind === "kbf";
  const savedCat: ShoeCategory | null = player.shoeSize?.startsWith("Toddler")
    ? "Toddler"
    : player.shoeSize?.startsWith("Kids")
    ? "Toddler"
    : player.shoeSize?.startsWith("Male")
    ? "Male"
    : player.shoeSize?.startsWith("Men")
    ? "Male"
    : player.shoeSize?.startsWith("Adult")
    ? "Male"
    : player.shoeSize?.startsWith("Female")
    ? "Female"
    : player.shoeSize?.startsWith("Women")
    ? "Female"
    : null;
  const [activeCat, setActiveCat] = useState<ShoeCategory | null>(savedCat);

  const nums =
    activeCat === "Toddler" ? TODDLER_SIZES
    : activeCat === "Male" ? MALE_SIZES
    : activeCat === "Female" ? FEMALE_SIZES
    : [];
  const currentNum = player.shoeSize?.split(" ")[1] ?? null;
  const canPickShoes = !!player.shoeSize || shoeSizesAssigned < shoePairsAllowed;

  function selectCat(cat: ShoeCategory | null) {
    if (cat === null) {
      setActiveCat(null);
      onUpdate({ shoeSize: null });
      return;
    }
    if (activeCat !== cat && player.shoeSize) onUpdate({ shoeSize: null });
    setActiveCat(cat);
  }

  function selectNum(num: string) {
    if (!activeCat) return;
    onUpdate({ shoeSize: `${activeCat} ${num}` });
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {/* Name */}
      <input
        type="text"
        value={player.name ?? ""}
        onChange={nameReadOnly ? undefined : (e) => onUpdate({ name: e.target.value || null })}
        readOnly={nameReadOnly}
        placeholder={`Bowler ${player.slot}`}
        className={`w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-white text-sm font-body placeholder:text-white/25 focus:outline-none focus:border-white/35${nameReadOnly ? " opacity-60 cursor-not-allowed" : ""}`}
      />
      {nameReadOnly && (
        <p className="text-white/30 text-[10px] font-body -mt-1">Names are set from your Kids Bowl Free registration</p>
      )}

      {/* Bumpers */}
      <div className="flex items-center gap-3">
        <span className="text-white/50 text-xs font-body w-16 shrink-0">Bumpers</span>
        <div className="flex rounded-lg overflow-hidden border border-white/15">
          {([true, false] as const).map((val) => (
            <button
              key={String(val)}
              type="button"
              onClick={() => onUpdate({ bumpers: val })}
              className="px-3 py-1.5 text-xs font-body font-semibold transition-colors"
              style={{
                backgroundColor:
                  player.bumpers === val
                    ? val
                      ? CORAL
                      : "rgba(255,255,255,0.15)"
                    : "transparent",
                color: player.bumpers === val ? "white" : "rgba(255,255,255,0.35)",
              }}
            >
              {val ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>

      {/* Shoes */}
      {shoePairsAllowed > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-xs font-body w-16 shrink-0">Shoes</span>
            <div className="flex gap-1.5">
              {(["None", "Toddler", "Male", "Female"] as const).map((label) => {
                const cat: ShoeCategory | null = label === "None" ? null : label;
                const active = cat === null ? activeCat === null : activeCat === cat;
                const disabled = !active && !canPickShoes && cat !== null;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectCat(cat)}
                    className="px-3 py-1.5 rounded-lg text-xs font-body font-semibold border transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: active
                        ? cat === null
                          ? "rgba(255,255,255,0.12)"
                          : CORAL
                        : "transparent",
                      borderColor: active
                        ? cat === null
                          ? "rgba(255,255,255,0.25)"
                          : CORAL
                        : "rgba(255,255,255,0.12)",
                      color: active ? "white" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Size number chips */}
          {activeCat && (
            <div className="flex gap-1.5 flex-wrap pl-[76px]">
              {nums.map((num) => {
                const selected =
                  currentNum === num && player.shoeSize?.startsWith(activeCat);
                return (
                  <button
                    key={num}
                    type="button"
                    onClick={() => selectNum(num)}
                    className="min-w-[36px] px-2 py-1.5 rounded-lg text-xs font-body font-semibold border transition-colors"
                    style={{
                      backgroundColor: selected ? CORAL : "rgba(255,255,255,0.06)",
                      borderColor: selected ? CORAL : "rgba(255,255,255,0.12)",
                      color: selected ? "white" : "rgba(255,255,255,0.55)",
                    }}
                  >
                    {num}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── BowlingNavLinks ────────────────────────────────────────────────────────

export function BowlingNavLinks({ cfg }: { cfg: KindConfig }) {
  return (
    <div className="flex flex-col sm:flex-row lg:flex-col gap-2 pt-1">
      {cfg.navLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="flex-1 text-center rounded-xl px-4 py-3.5 font-body font-semibold text-sm text-white/80 hover:text-white transition-all hover:scale-[1.01]"
          style={{
            backgroundColor: "rgba(18,48,117,0.4)",
            border: "1px solid rgba(18,48,117,0.7)",
          }}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}
